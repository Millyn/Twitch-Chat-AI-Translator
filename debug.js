/**
 * Twitch Chat AI Translator - Debug Page
 * 表格行式布局：每次翻译请求 = 一行
 */

const MAX_RECORDS = 50;

// DOM 元素引用
const tbody = document.querySelector("#debug-tbody");

// 存储最近记录（合并为统一列表）
const debugLogs = [];

// 消息类型映射
const MESSAGE_TYPES = {
  DEBUG_AUDIO: "audio",
  DEBUG_API_REQUEST: "api_request",
  DEBUG_API_RESPONSE: "api_response",
  DEBUG_PROMPT: "prompt",
  DEBUG_CATEGORY: "category",
  DEBUG_TIMING: "timing",
  DEBUG_TOKEN_USAGE: "token",
  DEBUG_LOG: "log",
};

/**
 * 格式化时间戳
 */
function formatTimestamp(ts) {
  const date = new Date(ts);
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * 转义 HTML 特殊字符
 */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/**
 * JSON 语法高亮
 */
function highlightJson(value, level = 0) {
  const indent = "  ".repeat(level);
  const indentChild = "  ".repeat(level + 1);

  if (value === null) return '<span class="tok-null">null</span>';
  if (value === undefined) return '<span class="tok-null">undefined</span>';
  if (Array.isArray(value)) {
    if (value.length === 0) return '<span class="tok-punct">[]</span>';
    const items = value.map((item) => indentChild + highlightJson(item, level + 1)).join(",\n");
    return '<span class="tok-punct">[</span>\n' + items + "\n" + indent + '<span class="tok-punct">]</span>';
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return '<span class="tok-punct">{}</span>';
    const items = keys
      .map(
        (key) =>
          indentChild +
          '<span class="tok-key">' +
          escapeHtml(JSON.stringify(key)) +
          '</span><span class="tok-punct">: </span>' +
          highlightJson(value[key], level + 1)
      )
      .join(",\n");
    return '<span class="tok-punct">{</span>\n' + items + "\n" + indent + '<span class="tok-punct">}</span>';
  }
  if (typeof value === "string") return '<span class="tok-string">' + escapeHtml(JSON.stringify(value)) + "</span>";
  if (typeof value === "number") return '<span class="tok-number">' + escapeHtml(String(value)) + "</span>";
  if (typeof value === "boolean") return '<span class="tok-boolean">' + String(value) + "</span>";
  return '<span class="tok-value">' + escapeHtml(String(value)) + "</span>";
}

/**
 * 格式化 JSON 数据
 */
function formatJsonData(data) {
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return escapeHtml(data); }
  }
  return highlightJson(data);
}

/**
 * 根据消息类型和数据，提取一行的列信息
 */
function extractRowInfo(msgType, data) {
  const base = { type: "", status: "", summary: "", detail: "", duration: "" };

  switch (msgType) {
    case "audio":
      base.type = "AUDIO";
      if (data.status === "error") {
        base.status = "ERROR";
        base.summary = data.detail || data.status || "音频采集失败";
      } else {
        base.status = "OK";
        base.summary = data.channel || "音频采集";
        base.detail = data.category ? "分区: " + data.category : "";
      }
      break;

    case "api_request":
      base.type = "CHAT";
      base.status = "→";
      const req = data.request || data;
      const body = req.body;
      if (body) {
        const msgs = body.messages;
        if (msgs && msgs.length > 0) {
          const lastMsg = msgs[msgs.length - 1];
          const content = lastMsg.content || "";
          base.summary = content.length > 80 ? content.slice(0, 80) + "..." : content;
        }
        base.detail = body.model || "";
      }
      break;

    case "api_response":
      const resp = data.response || data;
      if (resp.ok === false) {
        base.type = "CHAT";
        base.status = "FAIL";
        base.summary = "HTTP " + (resp.status || "Error");
      } else {
        base.type = "CHAT";
        base.status = "OK";
        const d = resp.data;
        if (d && d.choices && d.choices[0]) {
          const content = d.choices[0].message?.content || "";
          base.summary = content.length > 80 ? content.slice(0, 80) + "..." : content;
        }
        if (resp.elapsedMs != null) base.duration = resp.elapsedMs + "ms";
      }
      break;

    case "prompt":
      base.type = "PROMPT";
      base.status = "—";
      base.summary = (data.context || "") + (data.targetLanguage ? " → " + data.targetLanguage : "");
      break;

    case "category":
      base.type = "CATEGORY";
      base.status = "—";
      base.summary = data.category || data.context || "";
      break;

    case "timing":
      base.type = "TIMING";
      base.status = "—";
      base.summary = data.context || "";
      if (data.elapsedMs != null) base.duration = data.elapsedMs + "ms";
      break;

    case "token":
      base.type = "TOKEN";
      base.status = "—";
      base.summary = data.model || "";
      if (data.total_tokens != null) base.detail = "总 " + data.total_tokens;
      break;

    default:
      base.type = "LOG";
      base.status = "—";
      base.summary = typeof data === "string" ? data.slice(0, 80) : "";
  }

  return base;
}

/**
 * 构建一行 HTML
 */
function buildRowHtml(entry) {
  const info = extractRowInfo(entry.msgType, entry.data);

  let statusClass = "";
  if (info.status === "OK") statusClass = "status-ok";
  else if (info.status === "ERROR" || info.status === "FAIL") statusClass = "status-error";
  else statusClass = "status-pending";

  const badgeClass = "badge-" + entry.msgType.replace("api_", "");

  return (
    '<tr data-id="' + entry.id + '">' +
    '<td class="cell-time">' + formatTimestamp(entry.timestamp) + "</td>" +
    '<td><span class="type-badge ' + badgeClass + '">' + info.type + "</span></td>" +
    '<td class="cell-status"><span class="' + statusClass + '">' + info.status + "</span></td>" +
    '<td class="cell-summary">' +
      '<div class="summary-text">' + escapeHtml(info.summary) + "</div>" +
      (info.detail ? '<div class="summary-detail">' + escapeHtml(info.detail) + "</div>" : "") +
    "</td>" +
    '<td class="cell-duration">' + info.duration + "</td>" +
    '<td><button class="btn-detail" data-detail-id="' + entry.id + '">详情</button></td>' +
    "</tr>"
  );
}

/**
 * 构建详情展开行 HTML
 */
function buildDetailHtml(entry) {
  const jsonHtml = formatJsonData(entry.data);
  return (
    '<tr class="detail-row" id="detail-' + entry.id + '">' +
    '<td colspan="6">' +
      '<div class="detail-content">' +
        '<pre class="json-block">' + jsonHtml + "</pre>" +
      "</div>" +
    "</td>" +
    "</tr>"
  );
}

/**
 * 切换详情展开/收起（事件委托）
 */
function handleDetailClick(e) {
  const btn = e.target.closest(".btn-detail");
  if (!btn) return;

  const id = Number(btn.dataset.detailId);
  const detailRow = document.querySelector("#detail-" + id);

  if (detailRow) {
    detailRow.remove();
    btn.textContent = "详情";
    return;
  }

  const entry = debugLogs.find((e) => e.id === id);
  if (!entry) return;

  const targetRow = document.querySelector('tr[data-id="' + id + '"]');
  if (!targetRow) return;

  targetRow.insertAdjacentHTML("afterend", buildDetailHtml(entry));
  btn.textContent = "收起";
}

/**
 * 渲染表格
 */
function renderTable() {
  if (debugLogs.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6"><div class="empty-state">等待数据...</div></td></tr>';
    return;
  }

  tbody.innerHTML = debugLogs.map((entry) => buildRowHtml(entry)).join("");
}

/**
 * 添加调试条目
 */
let entryIdCounter = 0;
function addDebugEntry(msgType, data, type = "info") {
  const entry = {
    id: ++entryIdCounter,
    timestamp: Date.now(),
    msgType,
    data,
    type,
  };

  debugLogs.unshift(entry);

  if (debugLogs.length > MAX_RECORDS) {
    debugLogs.pop();
  }

  renderTable();
}

/**
 * 处理来自 background 的消息
 */
function handleDebugMessage(message) {
  const { type, data } = message;

  switch (type) {
    case "DEBUG_AUDIO":
      addDebugEntry("audio", data);
      break;
    case "DEBUG_API_REQUEST":
      addDebugEntry("api_request", data, "info");
      break;
    case "DEBUG_API_RESPONSE":
      addDebugEntry("api_response", data, "info");
      break;
    case "DEBUG_PROMPT":
      addDebugEntry("prompt", data);
      break;
    case "DEBUG_CATEGORY":
      addDebugEntry("category", data);
      break;
    case "DEBUG_TIMING":
      addDebugEntry("timing", data);
      break;
    case "DEBUG_TOKEN_USAGE":
      addDebugEntry("token", data);
      break;
    case "DEBUG_LOG":
      if (data.category) addDebugEntry(data.category, data);
      break;
    default:
      console.log("Unknown debug message type:", type, data);
  }
}

/**
 * 清除所有记录
 */
function clearAllLogs() {
  debugLogs.length = 0;
  renderTable();
  showStatus("已清除所有记录");
}

/**
 * 导出日志
 */
function exportLogs() {
  const exportData = {
    exportTime: new Date().toISOString(),
    logs: debugLogs,
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "debug-logs-" + Date.now() + ".json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showStatus("日志已导出");
}

/**
 * 显示状态信息
 */
function showStatus(message, isError = false) {
  const status = document.querySelector("#status");
  status.textContent = message;
  status.classList.toggle("error", isError);
  setTimeout(() => { status.textContent = ""; }, 3000);
}

/**
 * 初始化
 */
function init() {
  chrome.runtime.onMessage.addListener((message) => {
    if (typeof message?.type === "string" && message.type.startsWith("DEBUG_")) {
      handleDebugMessage(message);
    }
  });

  // 事件委托：所有详情按钮点击
  tbody.addEventListener("click", handleDetailClick);

  document.querySelector("#clear-all").addEventListener("click", clearAllLogs);
  document.querySelector("#export-logs").addEventListener("click", exportLogs);

  chrome.runtime.sendMessage({ type: "GET_DEBUG_STATE" }, (response) => {
    if (response?.data) {
      Object.entries(response.data).forEach(([key, logs]) => {
        if (Array.isArray(logs)) {
          logs.forEach((log) => {
            addDebugEntry(key, log.data, log.type || "info");
          });
        }
      });
    }
  });

  showStatus("调试页面已就绪");
}

document.addEventListener("DOMContentLoaded", init);
