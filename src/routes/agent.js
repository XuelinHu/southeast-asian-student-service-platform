const express = require('express');
const pool = require('../config/db');
const { auth, optionalAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const llm = require('../services/llm');
const knowledge = require('../services/agent/knowledge');
const { runAgent } = require('../services/agent/orchestrator');
const { parsePageQuery, buildPageEnvelope } = require('../services/pagination');
const {
  AGENT_GUEST_ENABLED,
  AGENT_MAX_QUESTION_CHARS,
  AGENT_MAX_HISTORY_MESSAGES,
  LLM_LOCAL_ONLY,
  LLM_MAX_MODEL_SIZE_GB
} = require('../config/llm');

const router = express.Router();

// ---------------------------------------------------------------------------
// 角色解析
// ---------------------------------------------------------------------------

/**
 * 未登录一律降级成 guest：给一个空菜单表，任何按菜单授权的工具都拿不到。
 *
 * 登录用户直接把 loadActiveUser 的产物当权限身份用 —— 角色代码、菜单授权、isSuper，
 * 以及学生/教师的绑定 id 都在里面，工具层与智能体路由看到的是同一份权限事实。
 */
function resolveIdentity(req) {
  if (!req.user) {
    if (!AGENT_GUEST_ENABLED) {
      const error = new Error('请先登录后再使用智能体');
      error.status = 401;
      throw error;
    }
    return {
      permission: { role: 'guest', menus: new Map(), isSuper: false },
      role: 'guest',
      userId: null,
      username: null,
      studentId: null
    };
  }

  // permission 给工具层判权，role/userId/username 用于问答记录落库，两者不要混
  return {
    permission: req.user,
    role: req.user.role,
    userId: req.user.id,
    username: req.user.username,
    studentId: req.user.studentId ?? null
  };
}

// ---------------------------------------------------------------------------
// 模型下拉
// ---------------------------------------------------------------------------

router.get('/models', optionalAuth(), async (req, res, next) => {
  try {
    const models = await llm.listModels();
    res.json({
      // 每条含 sizeGb / localOnly / unavailableReason：
      // 体积换算与"能不能选"的判定都在服务端做完，前端只负责渲染
      items: models,
      defaultModel: await llm.pickDefaultModel(),
      localOnly: LLM_LOCAL_ONLY,
      maxModelSizeGb: LLM_MAX_MODEL_SIZE_GB,
      // 前端据此决定是否显示"加载模型"按钮、以及游客模式的提示语
      guestEnabled: AGENT_GUEST_ENABLED,
      maxQuestionChars: AGENT_MAX_QUESTION_CHARS
    });
  } catch (error) {
    next(error);
  }
});

router.get('/health', optionalAuth(), async (req, res, next) => {
  try {
    res.json(await llm.health());
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 加载模型进显存
// 冷启动首次推理要 50s 以上，先 warmup 再提问能明显改善体验。
// ---------------------------------------------------------------------------

router.post(
  '/warmup',
  auth(),
  rateLimit('agent-warmup', { windowMs: 5 * 60 * 1000, max: 10, keyBy: 'user' }),
  async (req, res, next) => {
    try {
      const model = String(req.body?.model || '').trim();
      if (!model) return res.status(400).json({ message: '请指定要加载的模型' });
      const result = await llm.warmup(model);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// 卸载模型是运维动作，不挂任何菜单：只有超级管理员能释放显存。
// 用角色代码而不是 is_super 判断，与 BUILTIN_ROLES 里对该角色的描述一致。
router.post(
  '/unload',
  auth(['super_admin']),
  rateLimit('agent-unload', { windowMs: 5 * 60 * 1000, max: 10, keyBy: 'user' }),
  async (req, res, next) => {
    try {
      const model = String(req.body?.model || '').trim();
      if (!model) return res.status(400).json({ message: '请指定要卸载的模型' });
      res.json(await llm.unload(model));
    } catch (error) {
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// 知识库目录（游客也能看，用于弹框里的"我能问什么"提示）
// ---------------------------------------------------------------------------

router.get('/knowledge', (req, res) => {
  res.json({ items: knowledge.listTopics() });
});

// ---------------------------------------------------------------------------
// 问答（SSE 流式）
//
// 用 fetch + ReadableStream 消费而不是 EventSource：EventSource 不能带
// Authorization 头，而这个接口必须能识别登录用户。
// ---------------------------------------------------------------------------

// 游客按 visitor id 而不是 IP 计数：公网访客经 TCP 隧道进来时 req.ip 都是 127.0.0.1，
// 按 IP 计数等于全网共用一个 5 次/10 分钟的桶，正常人一多就互相挤掉（见 middleware/visitor.js）
const chatLimitLoggedIn = rateLimit('agent-chat-user', { windowMs: 10 * 60 * 1000, max: 20, keyBy: 'user' });
const chatLimitGuest = rateLimit('agent-chat-guest', { windowMs: 10 * 60 * 1000, max: 5, keyBy: 'visitor' });

function sseWrite(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

router.post('/chat', optionalAuth(), (req, res, next) => {
  const limiter = req.user ? chatLimitLoggedIn : chatLimitGuest;
  limiter(req, res, next);
}, async (req, res, next) => {
  let identity;
  try {
    identity = await resolveIdentity(req);
  } catch (error) {
    return next(error);
  }

  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ message: '请输入问题' });
  if (question.length > AGENT_MAX_QUESTION_CHARS) {
    return res.status(400).json({ message: `问题过长，请控制在 ${AGENT_MAX_QUESTION_CHARS} 字以内` });
  }

  const model = String(req.body?.model || '').trim() || (await llm.pickDefaultModel());
  if (!model) return res.status(503).json({ message: '当前没有可用模型，请先在本机安装 Ollama 模型' });

  // 先把模型校验掉，避免流已经开了才发现模型名非法（那时只能推一个 error 事件）
  try {
    await llm.resolveModel(model);
  } catch (error) {
    return next(error);
  }

  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-AGENT_MAX_HISTORY_MESSAGES) : [];

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 经 FRP / Nginx 时禁用缓冲，否则流式会被攒成一坨再吐
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  const controller = new AbortController();
  // 客户端断开（关弹框、切页）时要 abort 上游，否则 Ollama 会继续把显存占着算完
  req.on('close', () => controller.abort());

  const started = Date.now();
  let answer = '';
  let thinking = '';
  let toolCalls = [];
  let toolRounds = 0;
  let status = 'success';
  let errorMessage = null;

  try {
    for await (const event of runAgent({
      identity: identity.permission,
      userId: identity.userId,
      studentId: identity.studentId,
      question,
      history,
      model,
      signal: controller.signal
    })) {
      if (event.type === 'done') {
        answer = event.answer;
        thinking = event.thinking;
        toolCalls = event.toolCalls;
        toolRounds = event.toolRounds;
        // 把完整回答随 done 一起下发，前端不必自己拼接 delta
        sseWrite(res, {
          type: 'done',
          answer,
          toolCalls,
          toolRounds,
          latencyMs: Date.now() - started
        });
        continue;
      }
      sseWrite(res, event);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      status = 'aborted';
    } else {
      status = 'error';
      errorMessage = error.message;
      sseWrite(res, { type: 'error', message: error.message });
    }
  } finally {
    res.end();
    recordMessage({
      identity,
      model,
      question,
      answer,
      thinking,
      toolCalls,
      toolRounds,
      status,
      errorMessage,
      latencyMs: Date.now() - started
    }).catch(() => {
      /* 记录失败不影响本次回答 */
    });
  }
});

/** 落库问答记录，供管理台"问答记录"菜单分页查看。 */
async function recordMessage({
  identity,
  model,
  question,
  answer,
  thinking,
  toolCalls,
  toolRounds,
  status,
  errorMessage,
  latencyMs
}) {
  const parsed = llm.parseModelId(model) || { provider: 'unknown', model };
  await pool.execute(
    `INSERT INTO agent_messages
       (user_id, username, role, model, provider, question, answer, thinking, tool_calls,
        tool_rounds, status, error_message, latency_ms)
     VALUES (:userId, :username, :role, :model, :provider, :question, :answer, :thinking, :toolCalls,
             :toolRounds, :status, :errorMessage, :latencyMs)`,
    {
      userId: identity.userId,
      username: identity.username || null,
      role: identity.role,
      model,
      provider: parsed.provider,
      question: question.slice(0, 4000),
      answer: answer || null,
      thinking: thinking || null,
      toolCalls: toolCalls.length ? JSON.stringify(toolCalls).slice(0, 60000) : null,
      toolRounds,
      status,
      errorMessage: errorMessage ? String(errorMessage).slice(0, 255) : null,
      latencyMs
    }
  );
}

// ---------------------------------------------------------------------------
// 历史记录（只返回本人的，管理台看全量走 /api/admin/agentMessages）
// ---------------------------------------------------------------------------

// 分页参数与信封都走 services/pagination.js，与管理台的列表接口同一套：
// 自己实现一份的话，MAX_PAGE_SIZE、越界页、totalPages 的边界迟早跟别处不一致。
router.get('/history', auth(), async (req, res, next) => {
  try {
    const parsed = parsePageQuery(req.query, { defaultPageSize: 20 });

    // 只查本人的记录：user_id 来自令牌，不接受请求参数
    const [[countRow]] = await pool.query(
      'SELECT COUNT(*) AS total FROM agent_messages WHERE user_id = ?',
      [req.user.id]
    );
    const [items] = await pool.query(
      `SELECT id, conversation_id, turn_index, model, provider, question, answer,
              tool_rounds, status, error_message, latency_ms, created_at
       FROM agent_messages WHERE user_id = ?
       ORDER BY id DESC LIMIT ${Number(parsed.pageSize)} OFFSET ${Number(parsed.offset)}`,
      [req.user.id]
    );

    res.json(
      buildPageEnvelope(items, {
        page: parsed.page,
        pageSize: parsed.pageSize,
        total: Number(countRow?.total || 0),
        keyword: parsed.keyword
      })
    );
  } catch (error) {
    next(error);
  }
});

router.delete('/history/:id', auth(), async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: '记录 ID 不合法' });

    // 带上 user_id 条件，避免删到别人的记录
    const [result] = await pool.execute('DELETE FROM agent_messages WHERE id = :id AND user_id = :userId', {
      id,
      userId: req.user.id
    });
    if (!result.affectedRows) return res.status(404).json({ message: '记录不存在' });
    res.json({ message: '已删除' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
