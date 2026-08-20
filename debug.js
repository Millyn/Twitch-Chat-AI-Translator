/**
 * Twitch Chat AI Translator - Debug Page
 * 每条记录对应一次完整的翻译请求。
 */

const MAX_RECORDS = 50;
const debugLogs = [];
const expandedIds = new Set();
const tbody = document.querySelector("#debug-tbody");
let statusTimer = null;

/**
 * 格式化时间戳。
 */
function formatTimestamp(timestamp) {
  const numericTimestamp = Number(timestamp);
  const date = new Date(Number.isFinite(numericTimestamp) ? numericTimestamp : Date.now());
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * 将任意值转换为适合展示的文本。
 */
function toDisplayText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/**
 * 转义 HTML 特殊字符。
 */
function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = toDisplayText(value);
  return div.innerHTML;
}

/**
 * JSON 语法高亮。
 */
function highlightJson(value, level = 0) {
  const indent = "  ".repeat(level);
  const indentChild = "  ".repeat(level + 1);

  if (value === null) return '<span class="tok-null">null</span>';
  if (value === undefined) return '<span class="tok-null">undefined</span>';

  if (Array.isArray(value)) {
    if (value.length === 0) return '<span class="tok-punct">[]</span>';
    const items = value
      .map((item) => indentChild + highlightJson(item, level + 1))
      .join(",\n");
    return '<span class="tok-punct">[</span>\n'
      + items
      + "\n"
      + indent
      + '<span class="tok-punct">]</span>';
  }

  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return '<span class="tok-punct">{}</span>';
    const items = keys
      .map((key) => (
        indentChild
        + '<span class="tok-key">'
        + escapeHtml(JSON.stringify(key))
        + '</span><span class="tok-punct">: </span>'
        + highlightJson(value[key], level + 1)
      ))
      .join(",\n");
    return '<span class="tok-punct">{</span>\n'
      + items
      + "\n"
      + indent
      + '<span class="tok-punct">}</span>';
  }

  if (typeof value === "string") {
    return '<span class="tok-string">' + escapeHtml(JSON.stringify(value)) + "</span>";
  }
  if (typeof value === "number") {
    return '<span class="tok-number">' + escapeHtml(String(value)) + "</span>";
  }
  if (typeof value === "boolean") {
    return '<span class="tok-boolean">' + String(value) + "</span>";
  }
  return '<span class="tok-value">' + escapeHtml(value) + "</span>";
}

/**
 * 格式化 JSON 数据；字符串形式的 JSON 也会尝试解析。
 */
function formatJsonData(data) {
  if (data === null || data === undefined) {
    return '<span class="tok-null">暂无数据</span>';
  }

  let value = data;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return '<span class="tok-string">' + escapeHtml(value) + "</span>";
    }
  }

  try {
    return highlightJson(value);
  } catch (error) {
    return '<span class="tok-string">' + escapeHtml(toDisplayText(value)) + "</span>";
  }
}

function truncateText(value, maxLength = 140) {
  const text = toDisplayText(value);
  return text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
}

function getOriginalText(request) {
  const candidates = [
    request?.original,
    request?.audio?.original,
    request?.audio?.text,
    request?.audio?.asrText,
    request?.asrText,
  ];
  const candidate = candidates.find((value) => value !== null && value !== undefined && String(value).trim());
  return candidate === undefined ? "" : toDisplayText(candidate);
}

function formatDuration(duration) {
  if (duration === null || duration === undefined || duration === "") return "—";
  const numericDuration = Number(duration);
  if (Number.isFinite(numericDuration)) return `${Math.max(0, Math.round(numericDuration))} ms`;
  return toDisplayText(duration);
}

function getTypeInfo(type) {
  if (String(type).toLowerCase() === "streaming") {
    return { label: "🎤 Streaming", className: "type-streaming" };
  }
  return { label: "💬 Chat", className: "type-chat" };
}

function getStatusInfo(status) {
  switch (String(status || "pending").toLowerCase()) {
    case "success":
      return { label: "成功", className: "status-success" };
    case "error":
      return { label: "失败", className: "status-error" };
    case "pending":
      return { label: "处理中", className: "status-pending" };
    default:
      return { label: toDisplayText(status) || "未知", className: "status-pending" };
  }
}

function detailDomId(id) {
  return "debug-detail-" + encodeURIComponent(String(id)).replace(/%/g, "_");
}

function findRequest(id) {
  const normalizedId = String(id);
  return debugLogs.find((request) => String(request.id) === normalizedId);
}

function findRequestRow(id) {
  const normalizedId = String(id);
  return Array.from(tbody.querySelectorAll(".request-row"))
    .find((row) => row.dataset.requestId === normalizedId);
}

function normalizeRequest(value, fallbackId = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawId = value.id ?? value.requestId ?? fallbackId;
  if (rawId === null || rawId === undefined || String(rawId) === "") return null;
  return { ...value, id: String(rawId) };
}

function extractRequest(message) {
  const candidate = message?.request ?? message?.data;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  if (candidate.request && typeof candidate.request === "object" && !Array.isArray(candidate.request)) {
    return candidate.request;
  }
  return candidate;
}

/**
 * 插入或更新一条请求记录。
 * DEBUG_REQUEST 的 data 是完整请求对象，request.id 是唯一键。
 */
function upsertDebugRequest(value, fallbackId = "") {
  const request = normalizeRequest(value, fallbackId);
  if (!request) return;

  const index = debugLogs.findIndex((item) => item.id === request.id);
  if (index === -1) {
    debugLogs.unshift(request);
  } else {
    debugLogs[index] = { ...debugLogs[index], ...request };
  }

  while (debugLogs.length > MAX_RECORDS) debugLogs.pop();
  for (const id of expandedIds) {
    if (!debugLogs.some((item) => item.id === id)) expandedIds.delete(id);
  }
  renderTable();
}

function replaceDebugRequests(values) {
  debugLogs.length = 0;
  const seenIds = new Set();

  for (const value of values) {
    const request = normalizeRequest(value);
    if (!request || seenIds.has(request.id)) continue;
    seenIds.add(request.id);
    debugLogs.push(request);
    if (debugLogs.length >= MAX_RECORDS) break;
  }

  for (const id of expandedIds) {
    if (!seenIds.has(id)) expandedIds.delete(id);
  }
  renderTable();
}

function buildMetaHtml(meta) {
  if (!meta || typeof meta !== "object") return "";
  const method = toDisplayText(meta.method).trim();
  const url = toDisplayText(meta.url).trim();
  if (!method && !url) return "";
  return (
    '<div class="api-meta">'
    + (method ? '<span class="api-method">' + escapeHtml(method) + "</span>" : "")
    + (url ? '<span class="api-url" title="' + escapeHtml(url) + '">' + escapeHtml(url) + "</span>" : "")
    + "</div>"
  );
}

function buildPromptHtml(prompt) {
  if (prompt === null || prompt === undefined || prompt === "") {
    return '<div class="detail-empty">暂无 Prompt 内容</div>';
  }

  if (typeof prompt !== "object" || Array.isArray(prompt)) {
    return '<div class="prompt-text">' + escapeHtml(prompt) + "</div>";
  }

  const fields = [
    ["instruction", "Instruction"],
    ["context", "Context"],
    ["targetLanguage", "Target language"],
  ];
  const knownFields = fields.filter(([key]) => prompt[key] !== null && prompt[key] !== undefined && prompt[key] !== "");

  if (knownFields.length === 0) {
    return '<pre class="json-block">' + formatJsonData(prompt) + "</pre>";
  }

  return (
    '<div class="prompt-fields">'
    + knownFields.map(([key, label]) => (
      '<div class="prompt-field">'
      + '<span class="prompt-label">' + label + "</span>"
      + '<div class="prompt-value">' + escapeHtml(prompt[key]) + "</div>"
      + "</div>"
    )).join("")
    + "</div>"
  );
}

function buildJsonSection(title, value, extraClass = "") {
  return (
    '<section class="detail-section ' + extraClass + '">'
    + '<h3>' + title + "</h3>"
    + '<pre class="json-block">' + formatJsonData(value) + "</pre>"
    + "</section>"
  );
}

function buildDetailHtml(request) {
  const id = String(request.id);
  const isOpen = expandedIds.has(id);
  const original = getOriginalText(request);
  const audioText = original || "暂无原始音频/原文";
  const errorText = toDisplayText(request.error).trim();
  const translation = toDisplayText(request.translation).trim();
  const categoryText = toDisplayText(request.category?.category || request.category?.context).trim();
  const tokenUsage = request.tokenUsage;

  return (
    '<tr class="detail-row' + (isOpen ? " is-open" : "") + '" id="' + detailDomId(id) + '"'
    + ' data-detail-for="' + escapeHtml(id) + '" aria-hidden="' + (!isOpen) + '">'
    + '<td colspan="6">'
    + '<div class="detail-content">'
    + '<div class="detail-grid">'
    + '<section class="detail-section detail-section-wide">'
    + '<h3>原始音频</h3>'
    + '<div class="original-audio">' + escapeHtml(audioText) + "</div>"
    + "</section>"
    + buildJsonSection("API 请求体", request.apiRequest, "detail-section-request")
    + buildJsonSection("API 响应", request.apiResponse, "detail-section-response")
    + '<section class="detail-section detail-section-wide">'
    + '<h3>Prompt 内容</h3>'
    + buildPromptHtml(request.prompt)
    + "</section>"
    + '<section class="detail-section detail-section-wide request-meta-section">'
    + '<h3>请求信息</h3>'
    + buildMetaHtml(request.apiRequestMeta)
    + (translation ? '<div class="detail-result"><span>译文</span>' + escapeHtml(translation) + "</div>" : "")
    + (categoryText ? '<div class="detail-result"><span>分类</span>' + escapeHtml(categoryText) + "</div>" : "")
    + (tokenUsage ? '<div class="detail-result"><span>Token 用量</span><pre class="json-block compact-json">' + formatJsonData(tokenUsage) + "</pre></div>" : "")
    + (errorText ? '<div class="detail-error"><span>错误</span>' + escapeHtml(errorText) + "</div>" : "")
    + (!translation && !categoryText && !tokenUsage && !errorText && !request.apiRequestMeta ? '<div class="detail-empty">暂无补充信息</div>' : "")
    + "</section>"
    + "</div>"
    + "</div>"
    + "</td>"
    + "</tr>"
  );
}

function buildRowHtml(request) {
  const id = String(request.id);
  const typeInfo = getTypeInfo(request.type);
  const statusInfo = getStatusInfo(request.status);
  const original = getOriginalText(request);
  const expanded = expandedIds.has(id);
  const errorTitle = toDisplayText(request.error).trim();

  return (
    '<tr class="request-row" data-request-id="' + escapeHtml(id) + '" tabindex="0" aria-expanded="' + expanded + '">'
    + '<td class="cell-time">' + escapeHtml(formatTimestamp(request.timestamp)) + "</td>"
    + '<td><span class="type-badge ' + typeInfo.className + '">' + typeInfo.label + "</span></td>"
    + '<td class="cell-original" title="' + escapeHtml(original) + '"><div class="original-preview">'
    + escapeHtml(truncateText(original || "暂无原文"))
    + "</div></td>"
    + '<td class="cell-status"><span class="status-badge ' + statusInfo.className + '"'
    + (errorTitle ? ' title="' + escapeHtml(errorTitle) + '"' : "")
    + ">" + statusInfo.label + "</span></td>"
    + '<td class="cell-duration">' + escapeHtml(formatDuration(request.duration)) + "</td>"
    + '<td class="cell-action"><button class="btn-detail" type="button" data-request-id="'
    + escapeHtml(id) + '" aria-label="' + (expanded ? "收起详情" : "查看详情") + '">'
    + (expanded ? "收起" : "详情")
    + "</button></td>"
    + "</tr>"
    + buildDetailHtml(request)
  );
}

function renderTable() {
  if (!tbody) return;
  if (debugLogs.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6"><div class="empty-state">等待数据...</div></td></tr>';
    return;
  }
  tbody.innerHTML = debugLogs.map((request) => buildRowHtml(request)).join("");
}

function setRowExpanded(id, expanded) {
  const row = findRequestRow(id);
  const detail = document.getElementById(detailDomId(id));
  if (!row || !detail) return false;

  row.setAttribute("aria-expanded", String(expanded));
  detail.classList.toggle("is-open", expanded);
  detail.setAttribute("aria-hidden", String(!expanded));
  const button = row.querySelector(".btn-detail");
  if (button) {
    button.textContent = expanded ? "收起" : "详情";
    button.setAttribute("aria-label", expanded ? "收起详情" : "查看详情");
  }
  return true;
}

function toggleDetails(id) {
  const normalizedId = String(id);
  const expanded = !expandedIds.has(normalizedId);
  if (expanded) expandedIds.add(normalizedId);
  else expandedIds.delete(normalizedId);

  if (!setRowExpanded(normalizedId, expanded)) renderTable();
}

function handleTableClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== "function") return;

  const button = target.closest(".btn-detail");
  if (button && tbody.contains(button)) {
    event.stopPropagation();
    toggleDetails(button.dataset.requestId);
    return;
  }

  const row = target.closest(".request-row");
  if (row && tbody.contains(row)) toggleDetails(row.dataset.requestId);
}

function handleTableKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target;
  if (!target || typeof target.closest !== "function") return;
  if (target.closest(".btn-detail")) return;
  const row = target.closest(".request-row");
  if (!row || !tbody.contains(row)) return;
  event.preventDefault();
  toggleDetails(row.dataset.requestId);
}

function clearAllLogs() {
  debugLogs.length = 0;
  expandedIds.clear();
  renderTable();
  showStatus("已清除所有记录");
}

function exportLogs() {
  const exportData = {
    exportTime: new Date().toISOString(),
    requests: debugLogs,
  };
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "debug-requests-" + Date.now() + ".json";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  showStatus("日志已导出");
}

function showStatus(message, isError = false) {
  const status = document.querySelector("#status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("error", isError);
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    status.textContent = "";
    status.classList.remove("error");
  }, 3000);
}

function handleDebugMessage(message) {
  if (message?.type !== "DEBUG_REQUEST") return;
  upsertDebugRequest(extractRequest(message), message.requestId);
}

function loadDebugState() {
  chrome.runtime.sendMessage({ type: "GET_DEBUG_STATE" }, (response) => {
    if (chrome.runtime.lastError) {
      showStatus("无法读取调试状态", true);
      return;
    }
    if (Array.isArray(response?.data)) replaceDebugRequests(response.data);
  });
}

function init() {
  if (!tbody) return;

  // 只接收整条请求更新，避免 DEBUG 页面抢占 TRANSLATE 的响应。
  chrome.runtime.onMessage.addListener(handleDebugMessage);
  tbody.addEventListener("click", handleTableClick);
  tbody.addEventListener("keydown", handleTableKeydown);

  document.querySelector("#clear-all")?.addEventListener("click", clearAllLogs);
  document.querySelector("#export-logs")?.addEventListener("click", exportLogs);

  loadDebugState();
  showStatus("调试页面已就绪");
}

document.addEventListener("DOMContentLoaded", init);
