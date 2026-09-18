// 语音层：直接使用浏览器原生的 Web Speech API（识别 + 播报）。
//
// 曾经的"安卓原生桥优先"已经去掉：系统只保留 H5 一个端，浏览器能力就是全部能力。
// 好处是少一层抽象，代价是必须自己处理浏览器侧的坑 —— 安全上下文、音色异步就绪、
// 播报回灌麦克风、以及各浏览器实现差异，下面逐条处理。

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

/** 本机调试地址。浏览器把它们当作安全上下文，http:// 也能拿到麦克风。 */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

/**
 * 是否处于安全上下文。getUserMedia / Web Speech 都要求 https 或 localhost，
 * 公网 http 页面上调用会直接被浏览器拒绝，而且报错信息很难懂。
 */
function isSecure() {
  if (window.isSecureContext) return true;
  return LOCAL_HOSTS.includes(window.location.hostname);
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let recognition = null;
let currentUtterance = null;
let listening = false;
const handlers = { result: null, error: null, end: null };

// ---------------------------------------------------------------------------
// 中文音色
// ---------------------------------------------------------------------------

let cachedVoice = null;

/** 从当前音色表里挑一个中文音色。 */
function pickChineseVoice(lang) {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  if (!voices.length) return null;
  return (
    voices.find((v) => v.lang === lang && /Xiaoxiao|Yaoyao|Huihui|Chinese|中文/i.test(v.name)) ||
    voices.find((v) => v.lang === lang) ||
    voices.find((v) => v.lang?.startsWith('zh')) ||
    null
  );
}

/**
 * Chrome 首次调用 getVoices() 往往返回空数组，音色表是异步就绪的。
 * 这里监听 voiceschanged 提前挑好，避免第一句播报用默认（常常是英文）音色。
 */
function warmUpVoices() {
  const synth = window.speechSynthesis;
  if (!synth) return;
  cachedVoice = pickChineseVoice('zh-CN');
  if (cachedVoice) return;
  synth.addEventListener?.('voiceschanged', () => {
    cachedVoice = pickChineseVoice('zh-CN');
  });
}

// ---------------------------------------------------------------------------
// 错误文案
// ---------------------------------------------------------------------------

const ERROR_MESSAGES = {
  'not-allowed': '麦克风权限被拒绝，请在浏览器地址栏的权限设置里允许后重试。',
  'service-not-allowed': '浏览器拒绝了语音识别服务，请确认页面是 https 或 localhost 访问。',
  'audio-capture': '没有检测到可用的麦克风，请检查设备是否插好。',
  'no-speech': '没有听到声音，请再说一次。',
  network: '语音识别服务连接失败，请检查网络后重试。',
  aborted: '' // 主动中止不是错误，不打扰用户
};

export const voice = {
  /**
   * 能力探测结果，UI 据此决定按钮是否置灰。
   * 返回 { stt, tts, reason }：reason 在不可用时给出可直接展示给用户的中文原因。
   */
  detect() {
    if (!isSecure()) {
      const reason = '语音功能需要 https 或 localhost 访问，当前页面不满足。';
      return { stt: 'none', tts: 'none', reason };
    }

    const stt = SpeechRecognitionCtor ? 'browser' : 'none';
    const tts = window.speechSynthesis ? 'browser' : 'none';
    let reason = '';
    if (stt === 'none' && tts === 'none') reason = '当前浏览器不支持语音识别与播报，请改用文字提问。';
    else if (stt === 'none') reason = '当前浏览器不支持语音识别（Web Speech API），请改用文字提问。';
    return { stt, tts, reason };
  },

  get listening() {
    return listening;
  },

  /**
   * 开始识别。
   * @param {object} options
   * @param {(payload: {text: string, isFinal: boolean}) => void} options.onResult
   * @param {(message: string) => void} options.onError
   * @param {() => void} options.onEnd
   * @param {string} options.lang  BCP-47，默认 zh-CN
   * @param {boolean} options.continuous 连续模式：一句话说完自动重开麦克风
   */
  startListening({ onResult, onError, onEnd, lang = 'zh-CN', continuous = false } = {}) {
    const caps = this.detect();
    handlers.result = onResult;
    handlers.error = onError;
    handlers.end = onEnd;

    if (caps.stt === 'none') {
      onError?.(caps.reason || '当前环境不支持语音识别，请改用文字提问。');
      return false;
    }

    // 上一次的实例还挂着事件，先收干净，否则旧回调会和新会话交叉触发
    this.stopListening();

    try {
      recognition = new SpeechRecognitionCtor();
      recognition.lang = lang;
      recognition.continuous = Boolean(continuous);
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          if (result.isFinal) onResult?.({ text: result[0].transcript, isFinal: true });
          else interim += result[0].transcript;
        }
        if (interim) onResult?.({ text: interim, isFinal: false });
      };

      recognition.onerror = (event) => {
        const message = ERROR_MESSAGES[event.error];
        if (message) onError?.(message);
      };

      recognition.onend = () => {
        listening = false;
        onEnd?.();
      };

      recognition.start();
      listening = true;
      return true;
    } catch (error) {
      recognition = null;
      listening = false;
      onError?.(`语音识别启动失败：${error.message}`);
      return false;
    }
  },

  /**
   * 停止识别。
   * 用 abort() 而不是 stop()：stop() 会把已经录到的半句话当成结果发出来，
   * 播报前停麦时就会凭空多出一句没说完的提问。abort() 直接丢弃当前会话。
   */
  stopListening() {
    listening = false;
    const current = recognition;
    recognition = null;
    if (!current) return;
    // 先摘掉回调：abort 会触发 onend，那时再回调上层就会把刚停掉的会话又续上
    current.onresult = null;
    current.onerror = null;
    current.onend = null;
    try {
      current.abort();
    } catch {
      /* 没在跑就忽略 */
    }
  },

  /**
   * 播报文本。
   * @param {string} text
   * @param {object} options
   * @param {string} options.lang
   * @param {() => void} options.onEnd  播完回调（连续对话靠它决定何时重开麦克风）
   */
  speak(text, { lang = 'zh-CN', onEnd } = {}) {
    const caps = this.detect();
    const content = String(text || '').trim();
    if (!content) return false;
    // 播报前先停掉识别，否则麦克风会把喇叭里的声音又收进去
    this.stopListening();

    if (caps.tts === 'none') {
      onEnd?.();
      return false;
    }

    // 停掉上一条（内部先摘回调再 cancel），否则上一条的 onEnd 会把
    // 下一条的连续对话流程提前启动一次。
    this.stopSpeaking();

    const synth = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(content);
    utterance.lang = lang;
    utterance.rate = 1.05;
    if (cachedVoice) utterance.voice = cachedVoice;

    // onend 与 onerror 都可能触发，用一个开关保证 onEnd 只回调一次
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      onEnd?.();
    };
    utterance.onend = finish;
    utterance.onerror = finish;

    currentUtterance = utterance;
    synth.speak(utterance);
    return true;
  },

  /**
   * 停止播报。cancel() 会让未播完的那条触发 onerror，所以先把回调摘掉，
   * 免得调用方以为"播完了"而重开麦克风。
   */
  stopSpeaking() {
    const synth = window.speechSynthesis;
    if (!synth) return;
    if (currentUtterance) {
      currentUtterance.onend = null;
      currentUtterance.onerror = null;
      currentUtterance = null;
    }
    try {
      synth.cancel();
    } catch {
      /* 忽略 */
    }
  },

  isSpeaking() {
    return Boolean(window.speechSynthesis?.speaking);
  }
};

warmUpVoices();

export default voice;
