const llm = require('../llm');
const tools = require('./tools');
const knowledge = require('./knowledge');
const { buildSystemPrompt } = require('./prompt');
const {
  AGENT_MAX_TOOL_ROUNDS,
  AGENT_THINKING,
  AGENT_MAX_HISTORY_MESSAGES,
  LLM_TOOL_RESULT_MAX_CHARS
} = require('../../config/llm');

// ---------------------------------------------------------------------------
// 工具调用循环
//
// 优先走模型原生的 tools 能力；模型不支持时回退到"提示词约定 JSON 协议 + 解析"。
// 每轮把工具执行结果作为 role:"tool" 消息回灌，直到模型给出最终回答或达到轮数上限。
// ---------------------------------------------------------------------------

const JSON_PROTOCOL = [
  '## 工具调用格式',
  '你没有原生工具调用能力，需要按下面的约定发起查询：',
  '当需要查询数据时，只输出一个 JSON 代码块，不要写别的解释：',
  '```json',
  '{"tool": "工具名", "arguments": {"参数名": "参数值"}}',
  '```',
  '系统会把执行结果回给你，你再据此作答。不需要查询时，直接用自然语言回答。'
].join('\n');

function truncate(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…（结果过长已截断，共 ${value.length} 字符）`;
}

/** 从模型的自由文本里抠出 JSON 协议调用（无原生工具能力时的回退路径）。 */
function parseJsonProtocol(content) {
  const match = String(content || '').match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = match ? match[1] : content;
  const start = String(raw).indexOf('{');
  const end = String(raw).lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  try {
    const parsed = JSON.parse(String(raw).slice(start, end + 1));
    if (!parsed || typeof parsed.tool !== 'string') return null;
    return { name: parsed.tool, arguments: parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {} };
  } catch {
    return null;
  }
}

/**
 * 执行一次工具调用，任何异常都转成可读文本回灌给模型，
 * 让模型能自己说"这个查询失败了"，而不是整个会话崩掉。
 */
async function executeTool(call, ctx, seen) {
  const tool = tools.getTool(call.name, ctx.identity);
  if (!tool) {
    return { ok: false, content: { error: `工具 ${call.name} 不存在或当前角色无权使用。` } };
  }

  // 同工具同参数重复调用：模型偶尔会绕圈，直接挡掉并提示它换个思路
  const signature = `${call.name}:${JSON.stringify(call.arguments || {})}`;
  if (seen.has(signature)) {
    return {
      ok: false,
      content: { error: '相同的查询刚刚已经执行过，结果没有变化。请直接用已有结果作答，或换一个查询条件。' }
    };
  }
  seen.add(signature);

  const started = Date.now();
  try {
    const result = await tool.run(call.arguments || {}, ctx);
    return { ok: true, content: result, elapsedMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      content: { error: `查询执行失败：${error.message}` },
      elapsedMs: Date.now() - started
    };
  }
}

/** 给前端的一行摘要，避免把整段 JSON 塞进事件流。 */
function summarizeResult(content) {
  if (!content || typeof content !== 'object') return String(content).slice(0, 120);
  if (content.error) return content.error;
  if (Array.isArray(content.items)) return `返回 ${content.items.length} 条`;
  if (content.summary) return Object.entries(content.summary).map(([key, value]) => `${key}=${value}`).join(' ');
  if (content.total !== undefined) return `共 ${content.total} 条`;
  if (content.found === false) return '未找到';
  return '执行完成';
}

/**
 * 跑一轮完整的智能体对话，产出规范化事件流。
 *
 * @param {object} options
 * @param {object} options.identity        { role, menus, isSuper }，游客传 { role:'guest', menus:new Map() }
 * @param {number|null} options.userId
 * @param {number|null} options.studentId  学生角色绑定的 students.id
 * @param {string} options.question
 * @param {Array}  options.history         之前的对话（role/content）
 * @param {string} options.model
 * @param {AbortSignal} options.signal
 */
async function* runAgent({ identity, userId = null, studentId = null, question, history = [], model, signal }) {
  const role = identity.role;
  const ctx = { identity, role, userId, studentId };

  // 用问题先去知识库里捞一遍，命中的条目直接进系统提示词，
  // 让模型不必为了"这个规则怎么定的"多跑一轮工具
  const knowledgeEntries = knowledge.search(question, 2);
  const availableTools = tools.toolsForUser(identity);

  const capabilities = await llm.getCapabilities(model);
  const nativeTools = capabilities.capabilities.includes('tools') && availableTools.length > 0;

  let systemPrompt = buildSystemPrompt({ role, knowledgeEntries });
  if (!nativeTools && availableTools.length) {
    systemPrompt += `\n\n${JSON_PROTOCOL}\n\n可用工具：\n${availableTools
      .map((tool) => `- ${tool.name}: ${tool.description}`)
      .join('\n')}`;
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    // 只保留最近若干条历史，避免上下文无限增长把显存吃满
    ...history.slice(-AGENT_MAX_HISTORY_MESSAGES).map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: String(item.content || '').slice(0, 4000)
    })),
    { role: 'user', content: question }
  ];

  const toolSchema = nativeTools ? tools.schemaForUser(identity) : undefined;
  const seenCalls = new Set();

  let answer = '';
  let thinking = '';
  const toolCalls = [];
  // 真正调过工具的轮数，不是循环跑了几圈：模型直接作答时循环只跑了一圈但一次工具都没用，
  // 报成 1 的话管理台的"工具轮次"列会把"没查库"记成"查了一轮"，据此排查会走错方向
  let toolRounds = 0;
  let finishReason = 'stop';

  yield { type: 'status', message: nativeTools ? '正在思考' : '正在思考（该模型无原生工具能力，使用提示词协议）' };

  // 多留一轮：前 AGENT_MAX_TOOL_ROUNDS 轮允许发起工具调用，
  // 最后一轮把工具全部摘掉，逼模型基于已有结果直接出结论，
  // 否则模型可能一直在"再查一次"上打转，用户永远等不到答案。
  for (let round = 0; round <= AGENT_MAX_TOOL_ROUNDS; round += 1) {
    const allowTools = round < AGENT_MAX_TOOL_ROUNDS;
    const roundSchema = allowTools && nativeTools ? toolSchema : undefined;

    let roundContent = '';
    const roundCalls = [];
    let roundDone = null;

    for await (const event of llm.chatStream(model, messages, { tools: roundSchema, signal })) {
      if (event.type === 'thinking') {
        thinking += event.text;
        if (AGENT_THINKING) yield { type: 'thinking', text: event.text };
        continue;
      }
      if (event.type === 'delta') {
        roundContent += event.text;
        // 回退协议下，模型输出的 JSON 代码块不是给人看的，先不推给前端
        if (nativeTools) yield { type: 'delta', text: event.text };
        continue;
      }
      if (event.type === 'tool_call') {
        roundCalls.push(event);
        continue;
      }
      if (event.type === 'status') {
        yield event;
        continue;
      }
      if (event.type === 'done') roundDone = event;
    }

    finishReason = roundDone?.finishReason || 'stop';

    // 没有原生工具能力：看看模型是不是按约定吐了一个调用
    if (!nativeTools) {
      const parsed = allowTools ? parseJsonProtocol(roundContent) : null;
      if (parsed) {
        roundCalls.push({ id: `call_${round}`, name: parsed.name, arguments: parsed.arguments });
      } else {
        // 正常回答，直接收尾
        answer = roundContent;
        break;
      }
    }

    if (!roundCalls.length) {
      answer = roundContent;
      break;
    }

    toolRounds += 1;

    // 把这一轮的助手消息挂进上下文，工具调用必须跟着它一起回灌
    messages.push(
      nativeTools
        ? {
            role: 'assistant',
            content: roundContent,
            tool_calls: roundCalls.map((call) => ({
              function: { name: call.name, arguments: call.arguments }
            }))
          }
        : { role: 'assistant', content: roundContent }
    );

    for (const call of roundCalls) {
      yield { type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments };

      const outcome = await executeTool(call, ctx, seenCalls);
      toolCalls.push({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        ok: outcome.ok,
        elapsedMs: outcome.elapsedMs ?? null
      });

      yield {
        type: 'tool_result',
        id: call.id,
        name: call.name,
        ok: outcome.ok,
        summary: summarizeResult(outcome.content)
      };

      const serialized = truncate(JSON.stringify(outcome.content), LLM_TOOL_RESULT_MAX_CHARS);

      if (nativeTools) {
        messages.push({
          role: 'tool',
          content: serialized,
          tool_name: call.name,
          tool_call_id: call.id
        });
      } else {
        // 回退协议下模型不认识 role:"tool"，把结果当成用户提供的信息给它
        messages.push({
          role: 'user',
          content: `工具 ${call.name} 的执行结果：\n${serialized}\n\n请据此回答我上一个问题。`
        });
      }
    }
  }

  if (!answer && !nativeTools) {
    answer = '抱歉，我没能在这个问题给出确定的回答，请换个说法再问一次。';
  }

  yield {
    type: 'done',
    answer,
    thinking: AGENT_THINKING ? thinking : '',
    toolCalls,
    toolRounds,
    finishReason
  };
}

module.exports = { runAgent, parseJsonProtocol };
