const DEFAULT_SETTINGS = {
  enabled: true,
  apiKey: "",
  targetLanguage: "简体中文",
  hoverDelay: 350,
};

const MAX_VOICE_SESSIONS = 2;
const MAX_DEBUG_RECORDS = 50;
const sessions = new Map();
const pageContexts = new Map();
const debugRequests = [];
const restorePromise = restoreSessions();

/**
 * 创建一条以翻译请求为中心的调试记录。
 * DEBUG 页面只展示请求记录，不再为每一种 DEBUG 事件单独创建一行。
 */
function createRequestId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function findDebugRequest(requestId) {
  return debugRequests.find((request) => request.id === requestId);
}

function broadcastDebugRequest(request) {
  chrome.runtime.sendMessage({
    type: "DEBUG_REQUEST",
    requestId: request.id,
    data: request,
  }).catch(() => {});
}

function createDebugRequest(type, original, requestId = createRequestId()) {
  const existing = findDebugRequest(requestId);
  if (existing) return requestId;

  const request = {
    id: requestId,
    type: type === "voice" || type === "streaming" ? "streaming" : "chat",
    timestamp: Date.now(),
    original: String(original ?? ""),
    apiRequest: null,
    apiResponse: null,
    status: "pending",
    duration: null,
    prompt: null,
    category: null,
    tokenUsage: null,
    error: null,
  };
  debugRequests.unshift(request);
  if (debugRequests.length > MAX_DEBUG_RECORDS) debugRequests.pop();
  broadcastDebugRequest(request);
  return requestId;
}

function updateDebugRequest(requestId, type, data) {
  const request = findDebugRequest(requestId);
  if (!request) return;

  switch (type) {
    case "DEBUG_AUDIO": {
      request.audio = data;
      const original = data?.original || data?.text || data?.asrText;
      if (original && !request.original) request.original = String(original);
      if (data?.status === "error") {
        request.status = "error";
        request.error = data.detail || "音频采集失败";
      }
      break;
    }
    case "DEBUG_API_REQUEST":
      request.apiRequest = data?.body ?? data;
      request.apiRequestMeta = { url: data?.url || "", method: data?.method || "" };
      break;
    case "DEBUG_API_RESPONSE":
      request.apiResponse = data;
      if (data?.elapsedMs != null) request.duration = Number(data.elapsedMs);
      if (data?.ok === false) {
        request.status = "error";
        request.error = data.error || data.data?.error?.message || `HTTP ${data.status || "Error"}`;
      } else if (data?.ok === true) {
        request.status = "success";
      }
      break;
    case "DEBUG_PROMPT":
      request.prompt = data;
      break;
    case "DEBUG_CATEGORY":
      request.category = data;
      break;
    case "DEBUG_TIMING":
      if (data?.elapsedMs != null) request.duration = Number(data.elapsedMs);
      break;
    case "DEBUG_TOKEN_USAGE":
      request.tokenUsage = data;
      break;
    case "DEBUG_LOG":
      request.logs = [...(request.logs || []), data].slice(-20);
      break;
    default:
      break;
  }
}

/**
 * 发送调试事件到 debug 页面，并把事件合并到对应请求。
 */
function sendDebugMessage(type, data, requestId) {
  if (requestId) updateDebugRequest(requestId, type, data);
  const outboundData = requestId && data && typeof data === "object"
    ? { ...data, requestId }
    : data;
  chrome.runtime.sendMessage({ type, requestId, data: outboundData }).catch(() => {});
}

function finishDebugRequest(requestId, status, patch = {}) {
  const request = findDebugRequest(requestId);
  if (!request) return;
  request.status = status;
  Object.assign(request, patch);
  if (request.duration == null) request.duration = Math.max(0, Date.now() - request.timestamp);
  broadcastDebugRequest(request);
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const missing = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).filter(([key]) => current[key] === undefined));
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
});

chrome.tabs.onRemoved.addListener((tabId) => stopVoice(tabId, "页面已关闭，字幕资源已释放"));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && !isTwitchChannelUrl(changeInfo.url)) stopVoice(tabId, "已离开直播间，字幕已停止");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id ?? message?.tabId;
  if (message?.type === "PAGE_CONTEXT") {
    console.log("[TCAT] PAGE_CONTEXT: 收到 category", {
      tabId,
      channel: message.channel,
      category: message.category,
    });
    restorePromise
      .then(() => updatePageContext(tabId, message.channel, message.category))
      .catch((error) => console.warn("[TCAT] PAGE_CONTEXT 处理失败", error?.message || error));
    return false;
  }
  if (message?.type === "VOICE_HEARTBEAT") {
    const session = sessions.get(tabId);
    if (session && (!message.sessionId || session.sessionId === message.sessionId)) {
      session.lastHeartbeat = Date.now();
      chrome.runtime.sendMessage({ type: "OFFSCREEN_HEARTBEAT", tabId, sessionId: session.sessionId }).catch(() => {});
    }
    return false;
  }
  if (message?.type === "TOGGLE_PAGE_VOICE") {
    togglePageVoice(tabId).then(sendResponse).catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }
  if (message?.type === "TOGGLE_POPUP_VOICE") {
    togglePageVoice(Number(message.tabId), { captureCurrentTab: true })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }
  if (message?.type === "STOP_PAGE_VOICE") {
    stopVoice(Number(message.tabId ?? tabId), "字幕已手动停止").then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "STOP_ALL_VOICE") {
    Promise.all([...sessions.keys()].map((id) => stopVoice(id, "全部字幕已停止"))).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "GET_VOICE_SESSIONS") {
    sendResponse({ sessions: publicSessions(), max: MAX_VOICE_SESSIONS });
    return false;
  }
  if (message?.type === "VOICE_STATUS") {
    handleVoiceStatus(message);
    return false;
  }
  if (message?.type === "GET_DEBUG_STATE") {
    sendResponse({ data: debugRequests });
    return false;
  }
  if (message?.type === "ASR_TEXT") {
    // Keep the MV3 service worker alive until this room's current translation
    // drain finishes. Fire-and-forget fetches may be terminated when Chrome
    // suspends the worker, which previously produced intermittent missing subtitles.
    handleAsrText(message.text, message.tabId, message.sessionId, message.metrics)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }
  if (message?.type !== "TRANSLATE") return false;
  const storedCategory = normalizeCategory(pageContexts.get(tabId)?.category);
  const messageCategory = normalizeCategory(message.category);
  const category = storedCategory || messageCategory;
  console.log("[TCAT] TRANSLATE: 使用 category", { tabId, storedCategory, messageCategory, category });
  const requestId = createDebugRequest("chat", message.text);
  translateMessage(message.text, message.targetLanguage, message.context || "chat", category, requestId)
    .then((translation) => sendResponse({ ok: true, translation }))
    .catch((error) => {
      finishDebugRequest(requestId, "error", { error: readableError(error) });
      sendResponse({ ok: false, error: readableError(error) });
    });
  return true;
});

async function togglePageVoice(tabId, { captureCurrentTab = false } = {}) {
  await restorePromise;
  if (!Number.isInteger(tabId)) throw new Error("无法识别当前 Twitch 页面");
  if (sessions.has(tabId)) {
    await stopVoice(tabId, "字幕已手动停止");
    return { ok: true, active: false };
  }
  if (sessions.size >= MAX_VOICE_SESSIONS) throw new Error(`最多同时开启 ${MAX_VOICE_SESSIONS} 个直播间字幕`);
  const settings = await chrome.storage.local.get({ apiKey: "", localModelReady: false, voiceMode: "balanced", voiceModel: "distil-small-webgpu", voiceDiagnostics: false });
  if (!settings.localModelReady) throw new Error("请先在插件设置中选择本地 Whisper 模型文件夹");
  if (!String(settings.apiKey || "").trim()) throw new Error("请先在插件设置中填写 DeepSeek API Key");
  const tab = await chrome.tabs.get(tabId);
  if (!isTwitchChannelUrl(tab.url || "")) throw new Error("请先打开 Twitch 直播页面");
  if (!captureCurrentTab) throw new Error("请手动点击 Chrome 工具栏中的插件图标，再开启当前页面字幕");
  // Calling without targetTabId uses the tab that invoked the extension action.
  // This is the reliable activeTab-authorized flow for each Twitch tab.
  const streamId = await chrome.tabCapture.getMediaStreamId();
  const sessionId = crypto.randomUUID();
  const session = {
    tabId,
    sessionId,
    channel: pageContexts.get(tabId)?.channel || channelFromUrl(tab.url),
    category: pageContexts.get(tabId)?.category || "",
    status: "starting",
    detail: "正在加载本地语音模型…",
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
    translationBusy: false,
    pendingAsrText: "",
    lastAsrText: "",
    lastAsrAt: 0,
  };
  sessions.set(tabId, session);
  await persistSessions();
  await ensureOffscreen();
  try {
    const started = await chrome.runtime.sendMessage({
      type: "OFFSCREEN_START",
      streamId,
      tabId,
      sessionId,
      voiceSettings: { voiceMode: settings.voiceMode, voiceModel: settings.voiceModel, voiceDiagnostics: settings.voiceDiagnostics },
    });
    if (!started?.ok) throw new Error(started?.error || "直播音频连接失败");
  } catch (error) {
    sessions.delete(tabId);
    await persistSessions();
    notifyTab(tabId, { type: "VOICE_PAGE_STATUS", active: false, status: "error", detail: readableError(error) });
    throw error;
  }
  notifySession(session);
  return { ok: true, active: true, sessionId };
}

async function stopVoice(tabId, detail) {
  await restorePromise;
  const session = sessions.get(tabId);
  if (!session) return;
  sessions.delete(tabId);
  await persistSessions();
  await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP", tabId, sessionId: session.sessionId }).catch(() => {});
  notifyTab(tabId, { type: "VOICE_PAGE_STATUS", active: false, status: "stopped", detail });
  broadcastSessions();
}

async function handleVoiceStatus(message) {
  await restorePromise;
  const session = sessions.get(message.tabId);
  if (!session || session.sessionId !== message.sessionId) return;
  session.status = message.status;
  session.detail = String(message.detail || "");
  // 收集音频调试信息
  sendDebugMessage("DEBUG_AUDIO", {
    tabId: message.tabId,
    sessionId: message.sessionId,
    status: message.status,
    detail: session.detail,
    channel: session.channel,
    category: session.category,
  });
  if (message.status === "stopped" || message.status === "error") sessions.delete(message.tabId);
  await persistSessions();
  notifyTab(message.tabId, {
    type: "VOICE_PAGE_STATUS",
    active: sessions.has(message.tabId),
    sessionId: message.sessionId,
    status: message.status,
    detail: session.detail,
  });
  broadcastSessions();
}

function updatePageContext(tabId, channel, category) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    console.warn("[TCAT] updatePageContext: 无效 tabId", tabId);
    return;
  }
  const next = { channel: String(channel || ""), category: normalizeCategory(category) };
  const previous = pageContexts.get(tabId);
  console.log("[TCAT] updatePageContext: 接收 category", {
    tabId,
    channel: next.channel,
    category: next.category,
    previousCategory: previous?.category || "",
  });
  pageContexts.set(tabId, next);
  console.log("[TCAT] updatePageContext: pageContexts 已存储", { tabId, ...next });
  const session = sessions.get(tabId);
  if (session && previous?.channel && next.channel && previous.channel !== next.channel) {
    stopVoice(tabId, "检测到直播频道已切换，请在新页面重新开启字幕");
  } else if (session) {
    session.channel = next.channel;
    session.category = next.category;
    persistSessions();
    broadcastSessions();
  }
}

async function handleAsrText(text, tabId, sessionId, metrics = {}) {
  await restorePromise;
  const session = sessions.get(tabId);
  if (!session || session.sessionId !== sessionId) return;
  const clean = String(text || "").trim();
  if (!clean) return;
  const now = Date.now();
  if (clean === session.lastAsrText && now - (session.lastAsrAt || 0) < 15000) return;
  session.lastAsrText = clean;
  session.lastAsrAt = now;
  const requestId = createDebugRequest("streaming", clean);
  sendDebugMessage("DEBUG_AUDIO", {
    tabId,
    sessionId,
    original: clean,
    text: clean,
    metrics,
    channel: session.channel,
    category: session.category,
  }, requestId);
  // Keep only the newest waiting utterance. DeepSeek requests must not build an
  // unbounded per-room backlog when recognition is faster than the network.
  if (session.pendingAsrText?.requestId) {
    finishDebugRequest(session.pendingAsrText.requestId, "error", {
      error: "识别到更新语句，已跳过旧请求",
    });
  }
  session.pendingAsrText = { text: clean, metrics, requestId };
  return drainTranslationQueue(tabId, sessionId);
}

async function drainTranslationQueue(tabId, sessionId) {
  const initial = sessions.get(tabId);
  if (!initial || initial.sessionId !== sessionId || initial.translationBusy) return;
  initial.translationBusy = true;
  try {
    while (true) {
      const session = sessions.get(tabId);
      if (!session || session.sessionId !== sessionId) return;
      const pending = session.pendingAsrText;
      session.pendingAsrText = null;
      if (!pending) return;
      const clean = pending.text;
      notifyTab(tabId, { type: "SUBTITLE", sessionId, original: clean, translation: "翻译中…", diagnostics: pending.metrics });
      try {
        const translationStartedAt = performance.now();
        const translation = await translateMessage(clean, null, "voice", pageContexts.get(tabId)?.category || session.category, pending.requestId);
        const diagnostics = { ...pending.metrics, translationMs: Math.round(performance.now() - translationStartedAt) };
        const current = sessions.get(tabId);
        if (!current || current.sessionId !== sessionId) return;
        // If a newer sentence arrived, skip painting this stale translation;
        // the loop immediately starts the newest request instead.
        if (!current.pendingAsrText) notifyTab(tabId, { type: "SUBTITLE", sessionId, original: clean, translation, diagnostics });
      } catch (error) {
        const current = sessions.get(tabId);
        if (!current || current.sessionId !== sessionId) return;
        if (!current.pendingAsrText) notifyTab(tabId, { type: "SUBTITLE", sessionId, original: clean, translation: `翻译失败：${readableError(error)}`, error: true });
      }
    }
  } finally {
    const current = sessions.get(tabId);
    if (current?.sessionId === sessionId) {
      current.translationBusy = false;
      if (current.pendingAsrText) drainTranslationQueue(tabId, sessionId);
    }
  }
}

async function translateMessage(text, requestedLanguage, context, category, requestId) {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const apiKey = String(settings.apiKey || "").trim();
  if (!apiKey) throw new Error("请先在插件设置中填写 DeepSeek API Key");
  if (!text || typeof text !== "string") throw new Error("没有可翻译的文字");
  const normalizedCategory = normalizeCategory(category);
  console.log("[TCAT] translateMessage: 使用 category", { context, category: normalizedCategory });
  const categoryLine = `当前 Twitch 直播分区：${normalizedCategory || "未知分区"}。仅将分区作为用词语境，不推测主播当前操作。`;
  const targetLanguage = requestedLanguage || settings.targetLanguage;
  let instruction;
  if (context === "outgoing") {
    instruction = `你是 Twitch 聊天翻译器。把用户输入的中文翻译成自然、简洁、适合直播聊天的英文。${categoryLine}只输出英文译文，不解释，不加引号。`;
  } else {
    instruction = context === "voice"
      ? `你是 Twitch 直播字幕翻译器。输入来自英文语音识别。只根据句子本身和当前直播分区，轻度修正明显的断句、重复词和同音识别错误，再翻译成${targetLanguage}。${categoryLine}无法确定时保留原意，禁止编造内容。保留用户名、专有名词和原有语气。只输出译文，不解释，不加引号。`
      : `你是 Twitch 聊天翻译器。把用户消息翻译成${targetLanguage}。${categoryLine}保留用户名、专有名词、表情和原有语气。只输出译文，不解释，不加引号。`;
  }

  // 调试：发送 PROMPT 内容和直播分类
  sendDebugMessage("DEBUG_PROMPT", { instruction, context, targetLanguage, category: normalizedCategory }, requestId);
  sendDebugMessage("DEBUG_CATEGORY", { category: normalizedCategory, context }, requestId);

  const requestBody = { model: "deepseek-chat", messages: [{ role: "system", content: instruction }, { role: "user", content: text.slice(0, 2000) }], temperature: 0.2, max_tokens: 500, stream: false };
  // 调试：发送 API 请求信息（隐藏 API Key）
  sendDebugMessage("DEBUG_API_REQUEST", {
    url: "https://api.deepseek.com/chat/completions",
    method: "POST",
    body: requestBody,
  }, requestId);

  const requestStartedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let response;
  let data;
  try {
    response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    // Keep the timeout active until the response body is fully consumed. fetch()
    // resolves when headers arrive, while a stalled body could otherwise block a
    // per-room latest-only queue indefinitely.
    data = await response.json().catch((error) => {
      if (error?.name === "AbortError") throw error;
      return null;
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("DeepSeek 响应超时，请检查网络后重试");
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const elapsedMs = Math.round(performance.now() - requestStartedAt);

  // 调试：发送 API 响应信息
  sendDebugMessage("DEBUG_API_RESPONSE", {
    ok: response.ok,
    status: response.status,
    data: data,
    elapsedMs,
  }, requestId);

  // 调试：发送翻译耗时
  sendDebugMessage("DEBUG_TIMING", {
    elapsedMs,
    context,
    textLength: text.length,
  }, requestId);

  // 调试：发送 TOKEN 用量（如果 API 返回）
  if (data?.usage) {
    sendDebugMessage("DEBUG_TOKEN_USAGE", {
      prompt_tokens: data.usage.prompt_tokens,
      completion_tokens: data.usage.completion_tokens,
      total_tokens: data.usage.total_tokens,
      model: data.model,
    }, requestId);
  }

  if (!response.ok) throw new Error(`DeepSeek 请求失败：${data?.error?.message || `HTTP ${response.status}`}`);
  const translation = data?.choices?.[0]?.message?.content?.trim();
  if (!translation) throw new Error("DeepSeek 没有返回译文");
  finishDebugRequest(requestId, "success", { translation });
  return translation;
}

async function ensureOffscreen() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (!contexts.length) await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["USER_MEDIA"], justification: "Capture selected Twitch tab audio for local speech recognition" });
}

function notifySession(session) {
  notifyTab(session.tabId, { type: "VOICE_PAGE_STATUS", active: true, sessionId: session.sessionId, status: session.status, detail: session.detail });
  broadcastSessions();
}
function notifyTab(tabId, message) { chrome.tabs.sendMessage(tabId, message).catch(() => {}); }
function broadcastSessions() { chrome.runtime.sendMessage({ type: "VOICE_SESSIONS_CHANGED", sessions: publicSessions(), max: MAX_VOICE_SESSIONS }).catch(() => {}); }
function publicSessions() { return [...sessions.values()].map(({ tabId, sessionId, channel, category, status, detail, startedAt }) => ({ tabId, sessionId, channel, category, status, detail, startedAt })); }
async function persistSessions() {
  await chrome.storage.session.set({ voiceSessions: publicSessions() });
}
async function restoreSessions() {
  const saved = await chrome.storage.session.get({ voiceSessions: [] });
  let liveSessions = null;
  try {
    const response = await chrome.runtime.sendMessage({ type: "OFFSCREEN_GET_SESSIONS" });
    liveSessions = new Set((response?.sessions || []).map((item) => `${item.tabId}:${item.sessionId}`));
  } catch {
    liveSessions = new Set();
  }
  for (const item of saved.voiceSessions || []) {
    if (!Number.isInteger(item?.tabId) || !item?.sessionId) continue;
    if (!liveSessions.has(`${item.tabId}:${item.sessionId}`)) continue;
    sessions.set(item.tabId, {
      ...item,
      lastHeartbeat: Date.now(),
      translationBusy: false,
      pendingAsrText: "",
      lastAsrText: "",
      lastAsrAt: 0,
    });
  }
  await persistSessions();
}
function normalizeCategory(value) {
  // 页面消息应该传递纯字符串；拒绝对象、数组和其他异常值，避免把
  // "[object Object]" 等无意义内容拼进 DeepSeek prompt。
  if (typeof value !== "string") return "";
  try {
    return value.replace(/\s+/g, " ").trim().slice(0, 120);
  } catch {
    return "";
  }
}
function channelFromUrl(url) { try { return new URL(url).pathname.split("/").filter(Boolean)[0] || ""; } catch { return ""; } }
function isTwitchChannelUrl(url) { const channel = channelFromUrl(url); return String(url).startsWith("https://www.twitch.tv/") && channel && !new Set(["directory", "downloads", "jobs", "p", "search", "settings", "subscriptions", "videos", "wallet"]).has(channel.toLowerCase()); }
function readableError(error) {
  const text = String(error?.message || error || "未知错误");
  if (text.includes("active stream")) return "该页面已有音频捕获，请停止旧版插件或刷新页面后重试";
  if (text.includes("Extension has not been invoked") || text.includes("activeTab permission")) return "请切换到该 Twitch 页面，手动点击 Chrome 工具栏中的插件图标后再开启字幕";
  return text;
}
