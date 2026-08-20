const toggle = document.querySelector("#enabled");
const autoToggle = document.querySelector("#auto-translate");
const state = document.querySelector("#state");
const list = document.querySelector("#sessions");
const stopAll = document.querySelector("#stop-all");
const currentVoice = document.querySelector("#current-voice");
const subtitlePosition = document.querySelector("#subtitle-position");
let activeTabId = null;
let latestSessions = [];

chrome.storage.local.get({ enabled: true, apiKey: "" }).then((settings) => {
  toggle.checked = settings.enabled;
  state.textContent = settings.apiKey ? "DeepSeek 已配置" : "需要配置 API Key";
});
toggle.addEventListener("change", async () => { await chrome.storage.local.set({ enabled: toggle.checked }); state.textContent = toggle.checked ? "悬停翻译已启用" : "悬停翻译已暂停"; });

// 自动翻译勾选框逻辑 - 使用 chrome.storage.session（临时状态，仅当前会话）
async function loadAutoTranslateState() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabUrl = tab?.url || "";
    const tabId = tab?.id || activeTabId;
    const session = await chrome.storage.session.get("autoTranslate");
    const saved = session.autoTranslate || {};
    // 状态只应用于当前直播间：URL 匹配时恢复状态，否则重置为关闭
    autoToggle.checked = saved.enabled === true && saved.url === tabUrl;
    // 恢复勾选后同步给 content.js，避免出现"勾选但无实际效果"
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: "AUTO_TRANSLATE_CHANGED",
        enabled: autoToggle.checked
      }).catch(() => {});
    }
  } catch {
    autoToggle.checked = false;
  }
}

async function saveAutoTranslateState() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabUrl = tab?.url || "";
    const tabId = tab?.id || activeTabId;
    await chrome.storage.session.set({
      autoTranslate: { enabled: autoToggle.checked, url: tabUrl }
    });
    // 通知 content.js 状态变化
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: "AUTO_TRANSLATE_CHANGED",
        enabled: autoToggle.checked
      }).catch(() => {});
    }
  } catch {
    // 静默失败
  }
}

autoToggle.addEventListener("change", saveAutoTranslateState);
loadAutoTranslateState();
document.querySelector("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.querySelector("#debug-panel").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("debug.html") });
});
stopAll.addEventListener("click", async () => { stopAll.disabled = true; await chrome.runtime.sendMessage({ type: "STOP_ALL_VOICE" }); await refresh(); stopAll.disabled = false; });
currentVoice.addEventListener("click", async () => {
  currentVoice.disabled = true;
  currentVoice.textContent = latestSessions.some((item) => item.tabId === activeTabId) ? "正在停止…" : "正在连接音频…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id ?? activeTabId;
    if (!activeTabId || !String(tab?.url || "").startsWith("https://www.twitch.tv/")) throw new Error("请先切换到 Twitch 直播页面");
    const response = await chrome.runtime.sendMessage({ type: "TOGGLE_POPUP_VOICE", tabId: activeTabId });
    if (!response?.ok) throw new Error(response?.error || "字幕启动失败");
    await refresh();
  } catch (error) {
    state.textContent = error?.message || String(error);
  } finally { currentVoice.disabled = false; renderCurrentButton(); }
});
subtitlePosition.addEventListener("click", async () => {
  subtitlePosition.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id ?? null;
    if (!activeTabId || !String(tab?.url || "").startsWith("https://www.twitch.tv/")) throw new Error("请先切换到 Twitch 直播页面");
    const response = await chrome.tabs.sendMessage(activeTabId, { type: "TOGGLE_SUBTITLE_PREVIEW" });
    if (!response?.ok) throw new Error(response?.error || "无法显示字幕框");
    renderPositionButton(response.active);
  } catch (error) {
    state.textContent = error?.message || String(error);
  } finally { subtitlePosition.disabled = false; }
});
chrome.runtime.onMessage.addListener((message) => { if (message?.type === "VOICE_SESSIONS_CHANGED") render(message.sessions, message.max); });

async function refresh() { const result = await chrome.runtime.sendMessage({ type: "GET_VOICE_SESSIONS" }); render(result?.sessions || [], result?.max || 2); }
function render(sessions, max) {
  latestSessions = sessions;
  list.replaceChildren();
  if (!sessions.length) { const empty=document.createElement("div");empty.className="empty";empty.textContent="没有正在运行的语音字幕";list.append(empty); }
  for (const session of sessions) {
    const row=document.createElement("div");row.className="session";
    const info=document.createElement("div");const name=document.createElement("strong");name.textContent=session.channel||`标签页 ${session.tabId}`;const detail=document.createElement("small");detail.textContent=`${session.category||"未知分区"} · ${session.status==="running"?"运行中":"启动中"}`;info.append(name,detail);
    const stop=document.createElement("button");stop.textContent="停止";stop.addEventListener("click",async()=>{stop.disabled=true;await chrome.runtime.sendMessage({type:"STOP_PAGE_VOICE",tabId:session.tabId});await refresh();});
    row.append(info,stop);list.append(row);
  }
  stopAll.hidden=sessions.length<2;
  state.textContent=sessions.length?`语音字幕 ${sessions.length}/${max}`:state.textContent;
  renderCurrentButton();
}
function renderCurrentButton() {
  const active = latestSessions.some((item) => item.tabId === activeTabId);
  currentVoice.textContent = active ? "停止当前页面字幕" : "开启当前页面字幕";
  currentVoice.classList.toggle("danger", active);
}
function renderPositionButton(active) {
  subtitlePosition.textContent = active ? "隐藏字幕位置预览" : "显示字幕框并调整位置";
  subtitlePosition.classList.toggle("active", Boolean(active));
}
chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  activeTabId = tab?.id || null;
  renderCurrentButton();
  if (!activeTabId || !String(tab?.url || "").startsWith("https://www.twitch.tv/")) return;
  try {
    const response = await chrome.tabs.sendMessage(activeTabId, { type: "GET_SUBTITLE_PREVIEW" });
    renderPositionButton(response?.active);
  } catch { renderPositionButton(false); }
});
refresh();
