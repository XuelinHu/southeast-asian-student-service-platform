// 智能体弹框：悬浮按钮 → 弹框问答 → 流式输出 + 思考流 + 工具调用过程 + 语音播报/对话。
// DOM 全部由本文件创建，门户页和管理台只要引一个 <script type="module"> 即可。

import { state, api, esc, $, toast } from './core.js';
import voice from './voice.js';

const STORAGE_KEY = 'agentPrefs';

// ---------------------------------------------------------------------------
// 偏好（模型选择、是否自动播报）存本地，换页不丢
// ---------------------------------------------------------------------------

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writePrefs(patch) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readPrefs(), ...patch }));
  } catch {
    /* 隐私模式下写不了，忽略即可 */
  }
}

// ---------------------------------------------------------------------------
// 极简 Markdown 渲染。先整体转义再做格式替换，顺序反了就是 XSS。
// ---------------------------------------------------------------------------

function renderRich(text) {
  const safe = esc(text);
  const lines = safe.split('\n');
  const html = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const bullet = trimmed.match(/^[-*]\s+(.*)$/);
    const numbered = trimmed.match(/^\d+[.、]\s+(.*)$/);

    if (bullet || numbered) {
      const wanted = bullet ? 'ul' : 'ol';
      if (listType !== wanted) {
        closeList();
        html.push(`<${wanted}>`);
        listType = wanted;
      }
      html.push(`<li>${(bullet ? bullet[1] : numbered[1]).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</li>`);
      continue;
    }

    closeList();
    if (!trimmed) continue;
    html.push(`<p>${trimmed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`);
  }
  closeList();
  return html.join('');
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const root = document.createElement('div');
root.className = 'agent-root';
root.innerHTML = `
  <button class="agent-fab" id="agentFab" title="智能体助手" aria-label="打开智能体助手">
    <span class="agent-fab-icon">🤖</span>
    <span class="agent-fab-text">智能体</span>
  </button>

  <div class="agent-overlay hidden" id="agentOverlay">
    <section class="agent-modal" role="dialog" aria-modal="true" aria-label="智能体问答">
      <header class="agent-header">
        <div class="agent-title">
          <strong>业务智能体</strong>
          <span class="agent-subtitle" id="agentIdentity">游客模式</span>
        </div>
        <div class="agent-header-actions">
          <select class="agent-model" id="agentModel" title="选择模型"></select>
          <button class="agent-ghost" id="agentWarmup" title="把模型预先加载进显存，首次提问会快很多">加载模型</button>
          <button class="agent-ghost" id="agentTts" title="自动播报回答">🔈 播报</button>
          <button class="agent-ghost" id="agentClose" title="关闭">✕</button>
        </div>
      </header>

      <div class="agent-messages" id="agentMessages"></div>

      <footer class="agent-footer">
        <div class="agent-input-row">
          <textarea id="agentInput" rows="2" placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"></textarea>
          <button class="agent-mic" id="agentMic" title="按住说话">🎤</button>
          <button class="agent-send" id="agentSend">发送</button>
        </div>
        <div class="agent-status" id="agentStatus"></div>
      </footer>
    </section>
  </div>
`;

document.body.appendChild(root);

const el = {
  fab: $('#agentFab', root),
  overlay: $('#agentOverlay', root),
  identity: $('#agentIdentity', root),
  model: $('#agentModel', root),
  warmup: $('#agentWarmup', root),
  tts: $('#agentTts', root),
  close: $('#agentClose', root),
  messages: $('#agentMessages', root),
  input: $('#agentInput', root),
  mic: $('#agentMic', root),
  send: $('#agentSend', root),
  status: $('#agentStatus', root)
};

// ---------------------------------------------------------------------------
// 会话状态
// ---------------------------------------------------------------------------

const session = {
  models: [],
  streaming: false,
  // 只保留最近若干轮，跟服务端的裁剪口径对齐
  history: [],
  ttsOn: Boolean(readPrefs().tts),
  // 连续语音对话：播报结束后自动重开麦克风
  voiceLoop: false,
  abort: null
};

function setStatus(text, tone = '') {
  el.status.textContent = text || '';
  el.status.className = `agent-status ${tone}`;
}

function scrollToBottom() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

function appendNode(html) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  const node = wrapper.firstElementChild;
  el.messages.appendChild(node);
  scrollToBottom();
  return node;
}

function addUserMessage(text) {
  appendNode(`<div class="agent-msg agent-msg-user"><div class="agent-bubble">${esc(text)}</div></div>`);
}

function addAssistantMessage() {
  const node = appendNode(`
    <div class="agent-msg agent-msg-bot">
      <details class="agent-thinking" hidden><summary>思考过程</summary><div class="agent-thinking-body"></div></details>
      <div class="agent-tools"></div>
      <div class="agent-bubble"><span class="agent-typing">正在思考…</span></div>
    </div>
  `);
  return {
    node,
    thinking: node.querySelector('.agent-thinking'),
    thinkingBody: node.querySelector('.agent-thinking-body'),
    tools: node.querySelector('.agent-tools'),
    bubble: node.querySelector('.agent-bubble')
  };
}

// ---------------------------------------------------------------------------
// 模型下拉
// ---------------------------------------------------------------------------

/**
 * 模型下拉。体积与"能不能选"都由服务端算好（sizeGb / available / unavailableReason），
 * 前端不再做字节换算：同一个数字在两处各算一遍，迟早会算出两个结果。
 */
function renderModels() {
  const prefs = readPrefs();
  el.model.innerHTML = session.models
    .map((model) => {
      const bits = [model.providerLabel];
      if (model.parameterSize) bits.push(model.parameterSize);
      if (model.quantization) bits.push(model.quantization);
      if (model.remote) bits.push('云端');
      else if (model.loaded) bits.push(`已加载 ${model.sizeGb}GB`);
      else if (model.available) bits.push(`未加载 ${model.sizeGb}GB`);
      // 不可选时把原因直接写进下拉项：用户看到置灰的选项却不知道差在哪，
      // 等于没提示（超出显存上限和没下载，要做的事完全不同）
      else bits.push(model.unavailableReason || '不可用');

      const label = `${model.label}（${bits.filter(Boolean).join(' · ')}）`;
      return `<option value="${esc(model.id)}" ${model.available ? '' : 'disabled'}>${esc(label)}</option>`;
    })
    .join('');

  const preferred = prefs.model && session.models.some((m) => m.id === prefs.model && m.available)
    ? prefs.model
    : session.defaultModel;
  if (preferred) el.model.value = preferred;
}

async function loadModels() {
  try {
    const data = await api('/api/agent/models');
    session.models = data.items || [];
    session.defaultModel = data.defaultModel;
    session.guestEnabled = data.guestEnabled;
    session.maxQuestionChars = data.maxQuestionChars || 2000;
    renderModels();
    updateIdentity();
  } catch (error) {
    el.model.innerHTML = '<option>模型列表加载失败</option>';
    setStatus(`无法获取模型列表：${error.message}`, 'error');
  }
}

function currentModel() {
  return el.model.value || session.defaultModel;
}

function updateIdentity() {
  const user = state.session?.user;
  if (!user) {
    el.identity.textContent = '游客模式 · 仅业务知识问答';
    el.identity.className = 'agent-subtitle warning';
    return;
  }
  // 角色中文名由服务端下发（roles.name）。在这里写一份角色代码到中文的映射，
  // 加了新角色就会显示成一串英文代码 —— 角色是库里的数据，前端不该复制一份。
  el.identity.textContent = `${user.displayName || user.username} · ${user.roleName || user.role}`;
  el.identity.className = 'agent-subtitle';
}

// ---------------------------------------------------------------------------
// 发送 + 流式接收
// ---------------------------------------------------------------------------

function setStreaming(value) {
  session.streaming = value;
  el.send.disabled = value;
  el.send.textContent = value ? '停止' : '发送';
  el.warmup.disabled = value;
  el.model.disabled = value;
}

/** 用 fetch + ReadableStream 消费 SSE：EventSource 不能带 Authorization 头。 */
async function streamChat(question, view, controller) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.session?.token) headers.Authorization = `Bearer ${state.session.token}`;

  const response = await fetch('/api/agent/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      question,
      model: currentModel(),
      history: session.history.slice(-8)
    }),
    signal: controller.signal
  });

  if (!response.ok) {
    // 开流之前就失败的话，错误是普通 JSON，直接抛给调用方展示
    const text = await response.text();
    let message = `HTTP ${response.status}`;
    try {
      message = JSON.parse(text).message || message;
    } catch {
      /* 保留默认文案 */
    }
    throw new Error(message);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let thinking = '';

  const handle = (event) => {
    if (event.type === 'status') {
      setStatus(event.message);
      if (view.bubble.querySelector('.agent-typing')) view.bubble.innerHTML = `<span class="agent-typing">${esc(event.message)}…</span>`;
      return;
    }
    if (event.type === 'thinking') {
      thinking += event.text;
      view.thinking.hidden = false;
      view.thinkingBody.textContent = thinking;
      // 思考流在长，容器也要跟着滚，否则用户看不到最新推理
      if (el.messages.scrollTop + el.messages.clientHeight > el.messages.scrollHeight - 120) scrollToBottom();
      return;
    }
    if (event.type === 'tool_call') {
      view.tools.insertAdjacentHTML(
        'beforeend',
        `<span class="agent-chip" data-call="${esc(event.id)}">🔧 ${esc(event.name)}</span>`
      );
      scrollToBottom();
      return;
    }
    if (event.type === 'tool_result') {
      const chip = view.tools.querySelector(`[data-call="${CSS.escape(event.id)}"]`);
      if (chip) {
        chip.classList.add(event.ok ? 'ok' : 'fail');
        chip.textContent = `${event.ok ? '🔧' : '⚠️'} ${event.name}：${event.summary}`;
      }
      return;
    }
    if (event.type === 'delta') {
      answer += event.text;
      view.bubble.innerHTML = renderRich(answer);
      scrollToBottom();
      return;
    }
    if (event.type === 'error') {
      throw new Error(event.message);
    }
    if (event.type === 'done') {
      answer = event.answer || answer;
      view.bubble.innerHTML = renderRich(answer);
      session.lastAnswer = answer;
      scrollToBottom();
    }
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const raw = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 2);
      if (raw.startsWith('data:')) {
        let parsed = null;
        try {
          parsed = JSON.parse(raw.slice(5).trim());
        } catch {
          parsed = null;
        }
        if (parsed) handle(parsed);
      }
      index = buffer.indexOf('\n\n');
    }
  }

  return answer;
}

async function send(question) {
  const text = String(question ?? el.input.value).trim();
  if (!text) return;
  if (session.streaming) return;

  if (text.length > (session.maxQuestionChars || 2000)) {
    toast(`问题过长，请控制在 ${session.maxQuestionChars} 字以内`, 'warning');
    return;
  }

  el.input.value = '';
  addUserMessage(text);
  const view = addAssistantMessage();

  const controller = new AbortController();
  session.abort = controller;
  setStreaming(true);
  setStatus('正在连接模型…');

  try {
    const answer = await streamChat(text, view, controller);
    session.history.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
    session.history = session.history.slice(-8);
    setStatus('');
    if (session.ttsOn && answer) {
      voice.speak(answer, { onEnd: restartVoiceLoop });
    } else {
      restartVoiceLoop();
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      view.bubble.insertAdjacentHTML('beforeend', '<p class="agent-note">（已停止）</p>');
      setStatus('已停止', 'warning');
    } else {
      view.bubble.innerHTML = `<p class="agent-error">${esc(error.message)}</p>`;
      setStatus(error.message, 'error');
    }
  } finally {
    session.abort = null;
    setStreaming(false);
  }
}

// ---------------------------------------------------------------------------
// 语音
// ---------------------------------------------------------------------------

function updateMicState() {
  const caps = voice.detect();
  if (caps.stt === 'none') {
    el.mic.disabled = true;
    // 不可用的原因要写在按钮上：https、浏览器不支持、无麦克风，
    // 三种情况用户要做的事完全不同，笼统一句"不支持"等于没说
    el.mic.title = caps.reason || '当前环境不支持语音识别';
    return;
  }
  el.mic.title = '点击开始说话（浏览器语音识别）';
  el.mic.disabled = false;
}

function restartVoiceLoop() {
  // 连续对话：上一轮播报完了就自动把麦克风打开，用户可以一直说下去。
  // 延时是等喇叭里的尾音散掉，但用户完全可能在这 300ms 里关掉播报或关掉弹框 ——
  // 所以到点时要重新确认一次，否则弹框都关了麦克风还会自己亮起来。
  if (session.voiceLoop && !session.streaming) {
    setTimeout(() => {
      if (session.voiceLoop) startListening();
    }, 300);
  }
}

function startListening() {
  if (session.streaming) return;
  setStatus('正在聆听…');
  el.mic.classList.add('active');

  voice.startListening({
    continuous: session.voiceLoop,
    onResult: ({ text, isFinal }) => {
      el.input.value = text;
      if (isFinal) {
        stopListening();
        send(text);
      }
    },
    onError: (message) => {
      setStatus(message, 'error');
      stopListening();
    },
    onEnd: () => {
      el.mic.classList.remove('active');
      if (!session.streaming) setStatus('');
    }
  });
}

function stopListening() {
  voice.stopListening();
  el.mic.classList.remove('active');
  setStatus('');
}

function toggleTts() {
  session.ttsOn = !session.ttsOn;
  writePrefs({ tts: session.ttsOn });
  el.tts.classList.toggle('on', session.ttsOn);
  el.tts.textContent = session.ttsOn ? '🔊 播报中' : '🔈 播报';
  if (!session.ttsOn) voice.stopSpeaking();
  // 开着播报就等于开着连续对话，这是"语音对话"最自然的形态
  session.voiceLoop = session.ttsOn;
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

function openModal() {
  el.overlay.classList.remove('hidden');
  updateIdentity();
  if (!session.models.length) loadModels();
  setTimeout(() => el.input.focus(), 50);
}

function closeModal() {
  el.overlay.classList.add('hidden');
  session.voiceLoop = false;
  voice.stopListening();
  voice.stopSpeaking();
  session.abort?.abort();
}

el.fab.addEventListener('click', openModal);
el.close.addEventListener('click', closeModal);
el.overlay.addEventListener('click', (event) => {
  if (event.target === el.overlay) closeModal();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.overlay.classList.contains('hidden')) closeModal();
});

el.model.addEventListener('change', () => {
  writePrefs({ model: el.model.value });
  const model = session.models.find((item) => item.id === el.model.value);
  el.warmup.disabled = !model || model.remote || model.loaded;
  setStatus(model?.loaded ? '' : '该模型尚未加载进显存，首次提问会慢一些');
});

el.warmup.addEventListener('click', async () => {
  const modelId = currentModel();
  if (!modelId) return;
  el.warmup.disabled = true;
  setStatus('正在把模型加载进显存，首次加载可能需要一分钟…');
  try {
    const result = await api('/api/agent/warmup', {
      method: 'POST',
      body: JSON.stringify({ model: modelId })
    });
    // warmup 是唯一还按字节上报的地方（它直接回 Ollama 的原始结果），
    // 所以这里就地换算一次，需要两位小数才看得出 0.5b 与 14b 的差别
    const vramGb = result.sizeVramBytes ? (result.sizeVramBytes / 1e9).toFixed(1) : '—';
    setStatus(`已加载 ${result.model}（占用显存 ${vramGb}GB）`);
    if (result.evicted?.length) {
      toast(`为腾出显存，已卸载：${result.evicted.join('、')}`, 'warning');
    }
    await loadModels();
    el.model.value = modelId;
  } catch (error) {
    setStatus(`加载失败：${error.message}`, 'error');
  } finally {
    el.warmup.disabled = false;
  }
});

el.tts.addEventListener('click', toggleTts);
el.send.addEventListener('click', () => (session.streaming ? session.abort?.abort() : send()));

el.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});

el.mic.addEventListener('click', () => {
  if (voice.listening) stopListening();
  else {
    session.voiceLoop = session.ttsOn;
    startListening();
  }
});

document.addEventListener('visibilitychange', () => {
  // 切走页面就别再占着麦克风了
  if (document.hidden) stopListening();
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

const caps = voice.detect();
updateMicState();
if (session.ttsOn) {
  el.tts.classList.add('on');
  el.tts.textContent = '🔊 播报中';
}
if (caps.stt === 'none') {
  // 置灰之外再留一条控制台记录：语音不可用时用户只会看到按钮点不动，
  // 具体是 https 还是浏览器不支持，排查时这里能直接看到
  console.info(`[agent] 语音识别不可用：${caps.reason}`);
}

loadModels();

// 登录状态变化后（门户页登录/退出）要刷新身份显示
window.addEventListener('storage', (event) => {
  if (event.key === 'session') updateIdentity();
});

export { openModal as openAgent, closeModal as closeAgent };
