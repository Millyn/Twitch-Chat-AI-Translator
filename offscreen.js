const sessions = new Map();
let asrWorker = null;
let modelState = "idle";
let loadedModel = "";
let activeJob = null;
let lastDispatchedTabId = null;
let jobWatchdog = null;
const HEARTBEAT_TIMEOUT_MS = 90000;
const MAX_PENDING_AUDIO_PER_SESSION = 4;
const DRAIN_TIMEOUT_MS = 60000;
const MAX_NOISE_FLOOR = 0.0016;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OFFSCREEN_START") {
    startCapture(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === "OFFSCREEN_STOP") stopCapture(message.tabId, message.sessionId, false);
  if (message?.type === "OFFSCREEN_GET_SESSIONS") {
    sendResponse({ sessions: [...sessions.values()].map(({ tabId, sessionId }) => ({ tabId, sessionId })) });
    return false;
  }
  if (message?.type === "OFFSCREEN_HEARTBEAT") {
    const session = sessions.get(message.tabId);
    if (session?.sessionId === message.sessionId) session.lastHeartbeat = Date.now();
  }
});

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    // Chrome throttles timers in background tabs (often to roughly once per
    // minute). A 20-second timeout incorrectly killed the second selected room.
    if (now - session.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) stopCapture(session.tabId, session.sessionId, true, "页面连接已断开，字幕资源已释放");
    else if (session.audioContext?.state === "suspended") session.audioContext.resume().catch(() => {});
  }
}, 5000);

async function startCapture({ streamId, tabId, sessionId, voiceSettings = {} }) {
  if (!streamId || !Number.isInteger(tabId) || !sessionId) return;
  await stopCapture(tabId, null, false);
  const session = {
    tabId, sessionId, mediaStream: null, audioContext: null, processor: null, sourceNode: null,
    segmentParts: [], segmentSamples: 0, preRollParts: [], preRollSamples: 0,
    speechActive: false, speechFrames: 0, silenceSamples: 0, noiseFloor: 0.0012, pendingAudioQueue: [],
    lastHeartbeat: Date.now(), consecutiveErrors: 0, lastRawTranscript: "",
    vad: vadProfile(voiceSettings.voiceMode), diagnostics: Boolean(voiceSettings.voiceDiagnostics),
  };
  sessions.set(tabId, session);
  sendStatus(session, "starting", "正在连接直播音频…");
  try {
    session.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }, video: false,
    });
    session.mediaStream.getTracks().forEach((track) => { track.onended = () => stopCapture(tabId, sessionId, true, "直播音频已结束，字幕资源已释放", true); });
    session.audioContext = new AudioContext({ latencyHint: "interactive" });
    await session.audioContext.resume().catch(() => {});
    session.sourceNode = session.audioContext.createMediaStreamSource(session.mediaStream);
    session.sourceNode.connect(session.audioContext.destination);
    session.processor = session.audioContext.createScriptProcessor(4096, 1, 1);
    session.sourceNode.connect(session.processor);
    session.processor.connect(session.audioContext.destination);
    session.processor.onaudioprocess = (event) => collectAudio(session, event);
    await ensureWorker(voiceSettings.voiceModel || "distil-small-webgpu");
    if (modelState === "ready") sendStatus(session, "running", "本地字幕运行中 · WebGPU");
    else sendStatus(session, "starting", "正在加载本地语音模型…");
  } catch (error) {
    await stopCapture(tabId, sessionId, false);
    sendStatus(session, "error", error?.message || "无法获取标签页音频");
    throw error;
  }
}

async function ensureWorker(model) {
  if (asrWorker) {
    if (loadedModel !== model) throw new Error("已有字幕正在使用另一种语音模型，请先停止后再切换模型");
    return;
  }
  loadedModel = model;
  modelState = "loading";
  asrWorker = new Worker(chrome.runtime.getURL("assets/asr-worker.js"), { type: "module" });
  asrWorker.onmessage = onWorkerMessage;
  asrWorker.onerror = (event) => {
    modelState = "failed";
    for (const session of [...sessions.values()]) {
      sendStatus(session, "error", `模型运行失败：${event.message}`);
      stopCapture(session.tabId, session.sessionId, false);
    }
  };
  asrWorker.postMessage({ type: "LOAD_MODEL", wasmBase: chrome.runtime.getURL("assets/"), model });
}

function collectAudio(session, event) {
  if (sessions.get(session.tabId)?.sessionId !== session.sessionId) return;
  const data = new Float32Array(event.inputBuffer.getChannelData(0));
  let energy = 0;
  let peak = 0;
  for (const value of data) {
    energy += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  const rms = Math.sqrt(energy / data.length);
  const sampleRate = session.audioContext.sampleRate;
  // Tab audio is commonly much quieter than microphone input. Keep the
  // adaptive floor bounded so a steady stream bed cannot lock out speech.
  const threshold = Math.max(0.0015, Math.min(0.0025, session.noiseFloor * 1.6));
  const peakThreshold = Math.max(0.003, Math.min(0.0036, session.noiseFloor * 2));
  const speech = rms >= threshold && peak >= peakThreshold;

  if (!session.speechActive) {
    if (!speech) {
      session.speechFrames = 0;
      session.noiseFloor = Math.min(MAX_NOISE_FLOOR, session.noiseFloor * 0.96 + rms * 0.04);
      pushPreRoll(session, data, sampleRate);
      return;
    }
    session.speechFrames += 1;
    if (session.speechFrames < 2) {
      pushPreRoll(session, data, sampleRate);
      return;
    }
    session.speechActive = true;
    session.segmentParts = [...session.preRollParts, data];
    session.segmentSamples = session.preRollSamples + data.length;
    session.preRollParts = [];
    session.preRollSamples = 0;
    session.silenceSamples = 0;
    session.speechFrames = 0;
    return;
  }

  session.segmentParts.push(data);
  session.segmentSamples += data.length;
  session.silenceSamples = speech ? 0 : session.silenceSamples + data.length;
  const seconds = session.segmentSamples / sampleRate;
  const endedOnPause = seconds >= session.vad.minSeconds && session.silenceSamples / sampleRate >= session.vad.silenceSeconds;
  if (endedOnPause || seconds >= session.vad.maxSeconds) finalizeSegment(session, sampleRate);
}

function pushPreRoll(session, data, sampleRate) {
  session.preRollParts.push(data);
  session.preRollSamples += data.length;
  const limit = sampleRate * session.vad.overlapSeconds;
  while (session.preRollSamples > limit && session.preRollParts.length > 1) {
    session.preRollSamples -= session.preRollParts.shift().length;
  }
}

function finalizeSegment(session, sampleRate) {
  const merged = mergeAudio(session.segmentParts, session.segmentSamples);
  const audioMs = Math.round(merged.length / sampleRate * 1000);
  const tailLength = Math.min(merged.length, Math.round(sampleRate * session.vad.overlapSeconds));
  const tail = new Float32Array(merged.subarray(merged.length - tailLength));
  session.segmentParts = [];
  session.segmentSamples = 0;
  session.speechActive = false;
  session.speechFrames = 0;
  session.silenceSamples = 0;
  session.preRollParts = tail.length ? [tail] : [];
  session.preRollSamples = tail.length;
  const audio = resample(merged, sampleRate, 16000);
  session.pendingAudioQueue.push({ audio, audioMs, createdAt: performance.now() });
  if (session.pendingAudioQueue.length > MAX_PENDING_AUDIO_PER_SESSION) session.pendingAudioQueue.shift();
  pumpQueue();
}

function vadProfile(mode) {
  return ({
    fast: { minSeconds: 2.2, maxSeconds: 6, silenceSeconds: 0.45, overlapSeconds: 0.6 },
    balanced: { minSeconds: 3, maxSeconds: 8, silenceSeconds: 0.65, overlapSeconds: 0.8 },
    accurate: { minSeconds: 4, maxSeconds: 10, silenceSeconds: 0.8, overlapSeconds: 1 },
  })[mode] || { minSeconds: 3, maxSeconds: 8, silenceSeconds: 0.65, overlapSeconds: 0.8 };
}

function pumpQueue() {
  if (modelState !== "ready" || activeJob || !asrWorker) return;
  const available = [...sessions.values()].filter((item) => item.pendingAudioQueue.length);
  if (!available.length) return;
  // Round-robin dispatch prevents the first opened room from monopolising the
  // shared Whisper model when two rooms continuously produce audio.
  const previousIndex = available.findIndex((item) => item.tabId === lastDispatchedTabId);
  const session = available[(previousIndex + 1) % available.length];
  if (!session) return;
  const pending = session.pendingAudioQueue.shift();
  activeJob = { tabId: session.tabId, sessionId: session.sessionId, audioMs: pending.audioMs, queuedAt: pending.createdAt };
  lastDispatchedTabId = session.tabId;
  asrWorker.postMessage({ type: "TRANSCRIBE", audio: pending.audio, tabId: activeJob.tabId, sessionId: activeJob.sessionId }, [pending.audio.buffer]);
  clearTimeout(jobWatchdog);
  const dispatchedJob = { ...activeJob };
  jobWatchdog = setTimeout(() => recoverStalledWorker(dispatchedJob), 60000);
}

function onWorkerMessage(event) {
  const message = event.data || {};
  if (message.type === "READY") {
    modelState = "ready";
    for (const session of sessions.values()) sendStatus(session, "running", `本地字幕运行中 · ${message.backend}`);
    pumpQueue();
    return;
  }
  if (message.type === "RESULT") {
    const session = sessions.get(message.tabId);
    if (session?.sessionId === message.sessionId && message.text) {
      session.consecutiveErrors = 0;
      const text = removeOverlap(session.lastRawTranscript, message.text);
      session.lastRawTranscript = message.text;
      if (text) chrome.runtime.sendMessage({
        type: "ASR_TEXT", text, tabId: message.tabId, sessionId: message.sessionId,
        metrics: { audioMs: activeJob?.audioMs || 0, queueMs: Math.max(0, Math.round(performance.now() - (activeJob?.queuedAt || performance.now()) - (message.asrMs || 0))), asrMs: message.asrMs || 0 },
      }).catch(() => {});
    }
  }
  if (message.type === "ERROR") {
    console.error("Local Whisper worker error", message.error, message.stack || "");
    if (message.operation === "model-load") {
      modelState = "failed";
      for (const session of [...sessions.values()]) {
        sendStatus(session, "error", message.error);
        stopCapture(session.tabId, session.sessionId, false);
      }
    } else {
      const session = sessions.get(message.tabId);
      if (session?.sessionId === message.sessionId) {
        session.consecutiveErrors += 1;
        if (session.consecutiveErrors >= 3) {
          sendStatus(session, "error", `语音识别连续失败：${message.error}`);
          stopCapture(session.tabId, session.sessionId, false);
        } else {
          sendStatus(session, "running", "本地字幕运行中 · 正在跳过一段识别失败的音频");
        }
      }
    }
  }
  if ((message.type === "RESULT" || message.type === "ERROR") && activeJob && message.tabId === activeJob.tabId && message.sessionId === activeJob.sessionId) {
    clearTimeout(jobWatchdog);
    jobWatchdog = null;
    activeJob = null;
    pumpQueue();
    finishDrainedSessions();
  }
}

function recoverStalledWorker(job) {
  if (!activeJob || activeJob.tabId !== job?.tabId || activeJob.sessionId !== job?.sessionId) return;
  const affected = sessions.get(job.tabId);
  if (affected?.sessionId === job.sessionId) {
    sendStatus(affected, "starting", "语音识别响应超时，正在重新加载模型…");
  }
  asrWorker?.terminate();
  asrWorker = null;
  activeJob = null;
  jobWatchdog = null;
  modelState = "idle";
  const model = loadedModel;
  loadedModel = "";
  if (!sessions.size) return;
  ensureWorker(model).catch((error) => {
    for (const session of [...sessions.values()]) {
      sendStatus(session, "error", `模型重新加载失败：${error?.message || error}`);
      stopCapture(session.tabId, session.sessionId, false);
    }
  });
}

async function stopCapture(tabId, sessionId, report = false, detail = "本地字幕已停止", flushSegment = false) {
  const session = sessions.get(tabId);
  if (!session || (sessionId && session.sessionId !== sessionId)) return;
  if (session.draining) return session.drainPromise;
  const canDrain = flushSegment && modelState === "ready" && asrWorker;
  if (canDrain) {
    session.draining = true;
    session.drainDetail = detail;
    session.drainReport = report;
    session.drainPromise = new Promise((resolve) => { session.resolveDrain = resolve; });
    if (session.speechActive && session.segmentSamples > 0) {
      finalizeSegment(session, session.audioContext?.sampleRate || 16000);
    }
  }
  sessions.delete(tabId);
  if (canDrain) sessions.set(tabId, session);
  session.processor?.disconnect();
  if (session.processor) session.processor.onaudioprocess = null;
  session.sourceNode?.disconnect();
  session.mediaStream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
  await session.audioContext?.close().catch(() => {});
  session.segmentParts = [];
  session.preRollParts = [];
  if (!canDrain) session.pendingAudioQueue.length = 0;
  // Do not clear an in-flight job here. The worker still owns that pipeline
  // invocation; dispatching another job now would run two WebGPU inference
  // calls concurrently. Its eventual result is discarded, then the queue moves on.
  if (canDrain) return waitForDrain(session);
  if (report) sendStatus(session, "stopped", detail);
  if (!sessions.size) {
    asrWorker?.terminate();
    asrWorker = null;
    clearTimeout(jobWatchdog);
    jobWatchdog = null;
    activeJob = null;
    modelState = "idle";
    loadedModel = "";
  } else {
    pumpQueue();
  }
}

function waitForDrain(session) {
  if (!session.pendingAudioQueue.length && !ownsActiveJob(session)) {
    finishDrainedSession(session);
    return Promise.resolve();
  }
  session.drainTimer = setTimeout(() => finishDrainedSession(session), DRAIN_TIMEOUT_MS);
  pumpQueue();
  finishDrainedSessions();
  return session.drainPromise;
}

function finishDrainedSessions() {
  for (const session of [...sessions.values()]) {
    if (session.draining && !session.pendingAudioQueue.length && !ownsActiveJob(session)) finishDrainedSession(session);
  }
}

function ownsActiveJob(session) {
  return activeJob?.tabId === session.tabId && activeJob?.sessionId === session.sessionId;
}

function finishDrainedSession(session) {
  if (!session.draining || sessions.get(session.tabId) !== session) return;
  clearTimeout(session.drainTimer);
  session.drainTimer = null;
  session.draining = false;
  sessions.delete(session.tabId);
  session.pendingAudioQueue.length = 0;
  session.segmentParts = [];
  session.preRollParts = [];
  if (session.drainReport) sendStatus(session, "stopped", session.drainDetail);
  session.resolveDrain?.();
  session.resolveDrain = null;
  if (!sessions.size) {
    asrWorker?.terminate();
    asrWorker = null;
    clearTimeout(jobWatchdog);
    jobWatchdog = null;
    activeJob = null;
    modelState = "idle";
    loadedModel = "";
  } else {
    pumpQueue();
  }
}

function mergeAudio(parts, length) { const result = new Float32Array(length); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
function resample(input, fromRate, toRate) { if (fromRate === toRate) return input; const result = new Float32Array(Math.round(input.length * toRate / fromRate)); const ratio = fromRate / toRate; for (let i = 0; i < result.length; i += 1) { const p = i * ratio; const left = Math.floor(p); const f = p - left; result[i] = input[left] * (1 - f) + (input[Math.min(left + 1, input.length - 1)] || 0) * f; } return result; }
function sendStatus(session, status, detail) { chrome.runtime.sendMessage({ type: "VOICE_STATUS", tabId: session.tabId, sessionId: session.sessionId, status, detail }).catch(() => {}); }

function removeOverlap(previous, current) {
  const clean = String(current || "").trim();
  if (!previous || !clean) return clean;
  const left = String(previous).trim().split(/\s+/);
  const right = clean.split(/\s+/);
  const normalize = (word) => word.toLowerCase().replace(/[^a-z0-9']/g, "");
  const max = Math.min(12, left.length, right.length);
  for (let size = max; size >= 2; size -= 1) {
    const a = left.slice(-size).map(normalize).join(" ");
    const b = right.slice(0, size).map(normalize).join(" ");
    if (a && a === b) return right.slice(size).join(" ").trim();
  }
  return clean;
}
