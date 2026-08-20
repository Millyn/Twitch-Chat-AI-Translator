(() => {
  const MESSAGE_SELECTOR = ['[data-a-target="chat-line-message"]', '[data-test-selector="chat-line-message"]', ".chat-line__message"].join(",");
  const BODY_SELECTORS = ['[data-a-target="chat-message-text"]', '[data-test-selector="chat-line-message-body"]', ".text-fragment"];
  const CACHE_LIMIT = 500;
  let settings = { enabled: true, targetLanguage: "简体中文", hoverDelay: 350, subtitleSize: 22, subtitleOpacity: 0.75, subtitlePositionV2: null, voiceDiagnostics: false };
  let pageUrl = location.href;
  let pageContext = { channel: "", category: "" };
  let voiceState = { active: false, status: "stopped", sessionId: "" };
  let hoverTimer = null;
  let activeLine = null;
  let requestSequence = 0;
  let translatingOutgoing = false;
  let subtitlePreview = false;
  let observedPlayer = null;
  let playerResizeObserver = null;
  let autoTranslate = false;
  let autoTranslateObserver = null;
  let autoTranslateDebounceTimer = null;
  const pageCache = new Map();

  initialize();

  async function initialize() {
    settings = { ...settings, ...(await chrome.storage.local.get(settings)) };
    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("keydown", onOutgoingHotkey, true);
    chrome.storage.onChanged.addListener(onSettingsChanged);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    refreshPageContext();
    ensureOutgoingButton();
    await loadAutoTranslateState();
    setupAutoTranslateObserver();
    setInterval(maintenance, 1500);
    setInterval(() => {
      if (voiceState.active) chrome.runtime.sendMessage({ type: "VOICE_HEARTBEAT", sessionId: voiceState.sessionId }).catch(() => {});
    }, 5000);
  }

  function maintenance() {
    if (location.href !== pageUrl) {
      pageUrl = location.href;
      clearPageState();
      refreshPageContext(true);
      // URL 变化后重新读取 session 中保存的自动翻译状态并恢复监听器，
      // 否则 autoTranslate 会被 clearPageState() 永久关闭，导致"勾选但无实际效果"
      loadAutoTranslateState().then(() => setupAutoTranslateObserver());
    } else refreshPageContext(false);
    ensureOutgoingButton();
    ensureOverlayHost();
  }

  function onRuntimeMessage(message, sender, sendResponse) {
    if (message?.type === "TCAT_PING") { sendResponse({ twitchPage: true, ...pageContext }); return false; }
    if (message?.type === "GET_SUBTITLE_PREVIEW") { sendResponse({ ok: true, active: subtitlePreview }); return false; }
    if (message?.type === "TOGGLE_SUBTITLE_PREVIEW") {
      sendResponse({ ok: true, active: toggleSubtitlePreview() });
      return false;
    }
    if (message?.type === "AUTO_TRANSLATE_CHANGED") {
      autoTranslate = Boolean(message.enabled);
      if (!autoTranslate) stopAutoTranslateObserver();
      else setupAutoTranslateObserver();
      return false;
    }
    if (message?.type === "VOICE_PAGE_STATUS") {
      voiceState = { active: Boolean(message.active), status: message.status || "stopped", sessionId: message.sessionId || "" };
      if (!voiceState.active) hideSubtitle();
      return false;
    }
    if (message?.type !== "SUBTITLE") return false;
    if (voiceState.sessionId && message.sessionId && voiceState.sessionId !== message.sessionId) return false;
    showSubtitle(message);
    return false;
  }

  // === 自动翻译相关函数 ===

  async function loadAutoTranslateState() {
    try {
      const session = await chrome.storage.session.get("autoTranslate");
      const saved = session.autoTranslate || {};
      // 状态只应用于当前直播间：URL 匹配时恢复状态
      autoTranslate = saved.enabled === true && saved.url === location.href;
    } catch {
      autoTranslate = false;
    }
  }

  function setupAutoTranslateObserver() {
    if (!autoTranslate) {
      console.log("[TCAT] setupAutoTranslateObserver: 自动翻译未启用，跳过");
      return;
    }
    if (autoTranslateObserver) {
      console.log("[TCAT] setupAutoTranslateObserver: 已有监听器，跳过");
      return;
    }

    // 查找聊天消息容器
    const chatContainer = findChatContainer();
    if (!chatContainer) {
      // 容器可能还没加载，延迟重试
      console.log("[TCAT] setupAutoTranslateObserver: 未找到容器，1秒后重试");
      setTimeout(setupAutoTranslateObserver, 1000);
      return;
    }

    console.log("[TCAT] setupAutoTranslateObserver: 创建监听器", {
      containerTag: chatContainer.tagName,
      containerClass: chatContainer.className?.substring(0, 80)
    });

    autoTranslateObserver = new MutationObserver((mutations) => {
      if (!autoTranslate) return;
      clearTimeout(autoTranslateDebounceTimer);
      autoTranslateDebounceTimer = setTimeout(() => {
        processNewMessages(mutations);
      }, 300); // 300ms 防抖
    });

    autoTranslateObserver.observe(chatContainer, { childList: true, subtree: true });
    console.log("[TCAT] setupAutoTranslateObserver: 监听器已启动");
  }

  function stopAutoTranslateObserver() {
    if (autoTranslateObserver) {
      autoTranslateObserver.disconnect();
      autoTranslateObserver = null;
    }
    clearTimeout(autoTranslateDebounceTimer);
  }

  function findChatContainer() {
    // 尝试多种选择器找到聊天容器
    const selectors = [
      '[data-a-target="chat-scrollable-area"]',
      '.chat-scrollable-area__message-container',
      '[role="log"]',
      '.chat-room__content'
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        // 找到元素后，检查它或其祖先是否是实际的可滚动容器
        const scrollable = findScrollableParent(el);
        if (scrollable) {
          console.log("[TCAT] findChatContainer: 找到可滚动容器", {
            selector,
            tagName: scrollable.tagName,
            className: scrollable.className?.substring(0, 80),
            overflowY: getComputedStyle(scrollable).overflowY,
            scrollHeight: scrollable.scrollHeight,
            clientHeight: scrollable.clientHeight
          });
          return scrollable;
        }
      }
    }
    // 回退：查找页面上任何包含聊天消息的可滚动容器
    const fallback = findScrollableParentByContent();
    if (fallback) {
      console.log("[TCAT] findChatContainer: 使用回退方案找到容器", {
        tagName: fallback.tagName,
        className: fallback.className?.substring(0, 80),
        overflowY: getComputedStyle(fallback).overflowY
      });
      return fallback;
    }
    console.warn("[TCAT] findChatContainer: 未找到聊天容器");
    return null;
  }

  function findScrollableParent(element) {
    // 从元素向上查找，找到第一个实际可滚动的容器
    let current = element;
    while (current && current !== document.body) {
      const style = getComputedStyle(current);
      const overflowY = style.overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight) {
        return current;
      }
      current = current.parentElement;
    }
    // 如果向上没找到，检查元素本身是否可滚动
    if ((element.scrollHeight > element.clientHeight) || element.style.overflow === 'auto' || element.style.overflow === 'scroll') {
      return element;
    }
    return null;
  }

  function findScrollableParentByContent() {
    // 回退方案：查找包含聊天消息行的可滚动容器
    const messageSelectors = MESSAGE_SELECTOR.split(',');
    for (const msgSelector of messageSelectors) {
      const firstMessage = document.querySelector(msgSelector);
      if (!firstMessage) continue;
      // 从消息向上查找可滚动容器
      let current = firstMessage.parentElement;
      while (current && current !== document.body) {
        const style = getComputedStyle(current);
        const overflowY = style.overflowY;
        if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight) {
          return current;
        }
        current = current.parentElement;
      }
    }
    return null;
  }

  function processNewMessages(mutations) {
    const newLines = new Set();
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        // 检查节点本身是否是消息
        if (node.matches?.(MESSAGE_SELECTOR)) {
          newLines.add(node);
        }
        // 检查子节点
        node.querySelectorAll?.(MESSAGE_SELECTOR).forEach((line) => newLines.add(line));
      }
    }
    // 翻译所有新消息
    for (const line of newLines) {
      autoTranslateLine(line);
    }
  }

  async function autoTranslateLine(line) {
    if (!line.isConnected || !autoTranslate) return;
    const text = extractMessageText(line);
    if (!shouldTranslate(text)) return;
    // 检查是否已经有翻译
    const existing = line.querySelector(":scope > .tcat-translation");
    if (existing?.dataset.state === "done") return;
    // 检查缓存
    if (pageCache.has(text)) {
      renderTranslation(line, pageCache.get(text), "done");
      return;
    }
    renderTranslation(line, "正在翻译…", "loading");
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "TRANSLATE",
        context: "chat",
        text,
        targetLanguage: settings.targetLanguage,
        category: pageContext.category
      });
      console.log("[TCAT] 自动翻译响应:", JSON.stringify(response, null, 2));
    } catch (error) {
      console.error("[TCAT] 自动翻译请求失败:", error);
      response = { ok: false, error: error.message || "插件后台连接失败" };
    }
    if (!line.isConnected) return;
    if (!response?.ok) {
      const errorMsg = response?.error || "翻译失败";
      console.error("[TCAT] 自动翻译失败:", errorMsg, JSON.stringify(response, null, 2));
      renderTranslation(line, errorMsg, "error");
      return;
    }
    remember(text, response.translation);
    renderTranslation(line, response.translation, "done");
  }
  // === 页面上下文 ===

  function refreshPageContext(force = false) {
    const channel = channelFromPath();
    const category = readCategory();
    if (!force && channel === pageContext.channel && category === pageContext.category) return;
    pageContext = { channel, category };
    chrome.runtime.sendMessage({ type: "PAGE_CONTEXT", channel, category }).catch(() => {});
  }

  function readCategory() {
    const selectors = ['[data-a-target="stream-game-link"]', '[data-a-target="game-link"]', 'a[href*="/directory/category/"]'];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const text = normalize(node.textContent || node.getAttribute("aria-label") || "");
        if (text && text.length <= 120) return text;
      }
    }
    return "";
  }

  function channelFromPath() {
    const first = location.pathname.split("/").filter(Boolean)[0] || "";
    return new Set(["directory", "downloads", "jobs", "p", "search", "settings", "subscriptions", "videos", "wallet"]).has(first.toLowerCase()) ? "" : first;
  }

  function toggleSubtitlePreview() {
    subtitlePreview = !subtitlePreview;
    const overlay = ensureSubtitleOverlay();
    if (!overlay) return;
    overlay.classList.toggle("is-preview", subtitlePreview);
    if (subtitlePreview) {
      if (!overlay.dataset.hasSubtitle) {
        overlay.querySelector(".tcat-subtitle-original").textContent = "字幕位置预览";
        overlay.querySelector(".tcat-subtitle-translation").textContent = "拖动此字幕框调整位置";
      }
      overlay.classList.add("is-visible");
    } else if (!overlay.dataset.hasSubtitle) {
      overlay.classList.remove("is-visible");
    }
    return subtitlePreview;
  }

  function ensureOutgoingButton() {
    const send = document.querySelector('[data-a-target="chat-send-button"]');
    if (!findChatInput() || !send?.parentElement) return;
    let button = document.querySelector("#tcat-outgoing-translate");
    if (!button) {
      button = document.createElement("button");
      button.id = "tcat-outgoing-translate";
      button.type = "button";
      button.textContent = "中→EN";
      button.title = "把聊天框中的中文翻译成英文；Shift + Alt + Enter 可翻译并发送";
      button.addEventListener("click", () => translateOutgoing(button));
    }
    if (button.parentElement !== send.parentElement || button.nextElementSibling !== send) {
      send.parentElement.insertBefore(button, send);
    }
  }

  function findChatInput() {
    // 优先匹配 Slate 编辑器（contenteditable）；textarea 仅作兜底。
    // 保留 v0.5.5 原有选择器组合，并补充“chat-input 容器内 contenteditable / data-slate-editor”结构变体。
    const selectors = [
      '[data-a-target="chat-input"][contenteditable="true"]',
      '[contenteditable="true"][data-a-target="chat-input"]',
      '[data-a-target="chat-input"] [contenteditable="true"]',
      '[data-a-target="chat-input"] [data-slate-editor="true"]',
      '[data-a-target="chat-input"] textarea',
      'textarea[data-a-target="chat-input"]',
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function onOutgoingHotkey(event) {
    if (event.key !== "Enter" || !event.shiftKey || !event.altKey || event.ctrlKey || event.metaKey) return;
    const input = findChatInput();
    if (!input || (event.target !== input && !input.contains(event.target))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    ensureOutgoingButton();
    const button = document.querySelector("#tcat-outgoing-translate");
    if (button) translateOutgoing(button, { sendAfterTranslate: true });
  }

  async function translateOutgoing(button, { sendAfterTranslate = false } = {}) {
    if (translatingOutgoing) return;
    let input = findChatInput();
    if (!input) { flashButton(button, "未找到聊天框"); return; }
    const original = readInput(input).trim();
    if (!original) { flashButton(button, "请先输入中文"); return; }
    if (original.length > 500) { flashButton(button, "内容过长"); return; }
    translatingOutgoing = true;
    button.disabled = true;
    button.textContent = "翻译中…";
    try {
      const response = await chrome.runtime.sendMessage({ type: "TRANSLATE", context: "outgoing", text: original, category: pageContext.category });
      if (!response?.ok) throw new Error(response?.error || "翻译失败");
      const translated = String(response.translation || "").trim();
      if (!translated) throw new Error("没有返回英文译文");
      input = await writeInputStable(translated);
      if (!input) throw new Error("Twitch 输入框未接受译文，请重试");
      if (sendAfterTranslate) {
        await delay(100);
        const live = findChatInput();
        if (!live || !textMatchesState(live, translated)) throw new Error("发送前译文校验失败，已取消发送");
        const send = document.querySelector('[data-a-target="chat-send-button"]');
        if (!send) throw new Error("未找到 Twitch 发送按钮");
        send.click();
        button.textContent = "已翻译并发送";
      } else {
        button.textContent = "已填入，请手动发送";
      }
    } catch (error) {
      button.textContent = error?.message || "翻译失败";
    } finally {
      translatingOutgoing = false;
      setTimeout(() => { button.disabled = false; button.textContent = "中→EN"; }, 2600);
    }
  }

  function readInput(input) { return "value" in input ? input.value : input.innerText || input.textContent || ""; }

  async function writeInputStable(text) {
    // Never retry an insertion: retries previously appended the same translation
    // three times. Slate performs one model-level replacement, followed only by
    // read-only stability checks.
    const input = findChatInput();
    if (!input || !(await writeInputOnce(input, text))) return null;
    for (const wait of [60, 140, 280]) {
      await delay(wait);
      const live = findChatInput();
      if (!live || !textMatchesState(live, text)) {
        console.warn("[TCAT] writeInputStable: 稳定性校验失败", { at: wait, domText: live ? readInput(live).slice(0, 60) : "(未找到输入框)" });
        return null;
      }
    }
    const live = findChatInput();
    live.blur();
    await delay(140);
    const reconciled = findChatInput();
    if (!reconciled || !textMatchesState(reconciled, text)) {
      console.warn("[TCAT] writeInputStable: blur 后状态校验失败", { domText: reconciled ? readInput(reconciled).slice(0, 60) : "(未找到输入框)" });
      return null;
    }
    reconciled.focus();
    placeCaretAtEnd(reconciled);
    return reconciled;
  }

  

  // --- Slate input strategies (extracted for clear fallback chain) ---
  async function tryInsertReplacementStrategy(input, text) {
    selectSlateEditorContents(input);
    await delay(30);
    if (dispatchSlateReplacement(input, text, "insertReplacementText")) {
      await delay(60);
      if (textMatchesState(input, text)) return true;
      await delay(150);
      if (textMatchesState(input, text)) return true;
      console.warn("[TCAT] tryInsertReplacementStrategy: 被拦截但状态未同步");
    } else {
      console.log("[TCAT] tryInsertReplacementStrategy: Slate 未拦截 insertReplacementText");
      try { input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: readInput(input) })); } catch {}
    }
    return false;
  }

  async function tryInsertTextStrategy(input, text) {
    selectSlateEditorContents(input);
    await delay(30);
    if (dispatchSlateReplacement(input, text, "insertText")) {
      await delay(60);
      if (textMatchesState(input, text)) return true;
      await delay(150);
      if (textMatchesState(input, text)) return true;
      console.warn("[TCAT] tryInsertTextStrategy: 被拦截但状态未同步");
    } else {
      console.log("[TCAT] tryInsertTextStrategy: Slate 未拦截 insertText");
    }
    return false;
  }

  async function tryClipboardPasteStrategy(input, text) {
    try {
      const previousClipboard = await navigator.clipboard.readText().catch(() => "");
      await navigator.clipboard.writeText(text);
      selectSlateEditorContents(input);
      await delay(30);
      document.execCommand("paste");
      await delay(80);
      if (textMatchesState(input, text)) {
        console.log("[TCAT] tryClipboardPasteStrategy: 剪贴板粘贴成功");
        if (previousClipboard) navigator.clipboard.writeText(previousClipboard).catch(() => {});
        return true;
      }
      console.warn("[TCAT] tryClipboardPasteStrategy: 剪贴板粘贴后状态未同步");
      if (previousClipboard) navigator.clipboard.writeText(previousClipboard).catch(() => {});
    } catch (err) {
      console.warn("[TCAT] tryClipboardPasteStrategy: 剪贴板操作失败", { error: err?.message });
    }
    return false;
  }

  async function writeInputOnce(input, text) {
    input.focus();
    if ("value" in input) {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(input, text);
      else input.value = text;
      input.setSelectionRange?.(text.length, text.length);
      input.dispatchEvent(createInputEvent("input", text));
      return true;
    }
    if (!selectSlateEditorContents(input)) {
      console.warn("[TCAT] writeInputOnce: 无法选中 Slate 编辑器内容", { tag: input.tagName, cls: input.className?.slice(0, 80) });
      return false;
    }
    if (await tryInsertReplacementStrategy(input, text)) return true;
    if (await tryInsertTextStrategy(input, text)) return true;
    if (await tryClipboardPasteStrategy(input, text)) return true;
    console.warn("[TCAT] writeInputOnce: 所有写入策略均失败");
    return false;
  }

  function selectSlateEditorContents(input) {
    input.focus();
    const selection = getSelection();
    const textNodes = collectSlateTextNodes(input);
    let applied = false;
    if (textNodes.length) {
      try {
        const range = document.createRange();
        range.setStart(textNodes[0], 0);
        range.setEnd(textNodes[textNodes.length - 1], textNodes[textNodes.length - 1].data.length);
        selection.removeAllRanges();
        selection.addRange(range);
        applied = true;
      } catch (error) {
        console.warn("[TCAT] selectSlateEditorContents: 设置选区失败", { error: error?.message });
      }
    } else {
      // 编辑器内没有任何文本节点（空编辑器），退化为全选编辑器容器。
      try {
        const range = document.createRange();
        range.selectNodeContents(input);
        selection.removeAllRanges();
        selection.addRange(range);
        applied = true;
      } catch { /* ignore */ }
    }
    // 选区未落在编辑器内时，回退到浏览器原生全选（会触发真实 selectionchange 事件）。
    if (!selectionCoversInput(input)) {
      try { document.execCommand("selectAll"); } catch { /* ignore */ }
    }
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    return applied || selectionCoversInput(input);
  }

  function dispatchSlateReplacement(input, text, inputType = "insertReplacementText") {
    try {
      const event = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType,
        data: text,
      });
      input.dispatchEvent(event);
      // Slate 会 preventDefault 表示接管了该输入并已应用到自身模型。
      // 注意：defaultPrevented=true 只代表“被拦截”，不代表文本一定插入成功，
      // 是否真正同步由调用方通过 textMatchesState 校验。
      return event.defaultPrevented;
    } catch (error) {
      console.warn("[TCAT] dispatchSlateReplacement: 派发 beforeinput 失败", { inputType, error: error?.message });
      return false;
    }
  }

  function editorStateLooksSynced(input, text) {
    if ("value" in input) return slateTextEquals(input.value, text);
    // Slate 编辑器：把叶子文本拼接后与目标比对（空白差异归一化）。
    const slateText = [...input.querySelectorAll('[data-slate-string="true"]')]
      .map((node) => node.textContent || "")
      .join("");
    if (slateText) return slateTextEquals(slateText, text);
    // 非 Slate（普通 contenteditable 等）：按可见文本比对。
    return slateTextEquals(readInput(input), text);
  }

  function placeCaretAtEnd(input) {
    if ("value" in input) { input.setSelectionRange?.(input.value.length, input.value.length); return; }
    const textNodes = collectSlateTextNodes(input);
    const last = textNodes[textNodes.length - 1];
    if (!last) {
      try {
        const range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } catch { /* ignore */ }
      return;
    }
    const range = document.createRange();
    range.setStart(last, last.data.length);
    range.collapse(true);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // === 出站翻译内部辅助函数 ===

  // 收集 Slate 编辑器内的文本节点：优先收集叶子（data-slate-string / data-slate-zero-width）
  // 的直接文本子节点；找不到时退化为编辑器内所有文本节点（兼容叶子结构变化）。
  function collectSlateTextNodes(input) {
    const leaves = [...input.querySelectorAll('[data-slate-string="true"], [data-slate-zero-width]')];
    const direct = leaves
      .map((leaf) => [...leaf.childNodes].find((node) => node.nodeType === Node.TEXT_NODE))
      .filter(Boolean);
    if (direct.length) return direct;
    const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT);
    const all = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.data && node.data.length > 0) all.push(node);
    }
    return all;
  }

  // 空白归一化后比较文本（忽略连续空白、换行、零宽字符等渲染差异）。
  function slateTextEquals(actual, expected) {
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    return norm(actual) === norm(expected);
  }

  // 判断输入框的真实状态是否已包含目标译文（只读校验）。
  function textMatchesState(input, text) {
    return editorStateLooksSynced(input, text) || slateTextEquals(readInput(input), text);
  }

  // 判断当前 DOM 选区是否落在编辑器内（用于校验全选是否生效）。
  function selectionCoversInput(input) {
    const selection = getSelection();
    if (!selection || !selection.anchorNode || !selection.focusNode) return false;
    return input.contains(selection.anchorNode) && input.contains(selection.focusNode);
  }

  function createInputEvent(type, text) {
    try { return new InputEvent(type, { bubbles: true, composed: true, inputType: "insertReplacementText", data: text }); }
    catch { return new Event(type, { bubbles: true, composed: true }); }
  }
  function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function flashButton(button, text) { button.textContent = text; setTimeout(() => { button.textContent = "中→EN"; }, 1400); }

  function showSubtitle(message) {
    const overlay = ensureSubtitleOverlay();
    if (!overlay) return;
    overlay.dataset.hasSubtitle = "true";
    overlay.classList.toggle("is-error", Boolean(message.error));
    overlay.querySelector(".tcat-subtitle-original").textContent = message.original;
    overlay.querySelector(".tcat-subtitle-translation").textContent = message.translation;
    const diagnostics = overlay.querySelector(".tcat-subtitle-diagnostics");
    const metric = message.diagnostics || {};
    diagnostics.textContent = settings.voiceDiagnostics
      ? `音频 ${formatMs(metric.audioMs)} · 排队 ${formatMs(metric.queueMs)} · 识别 ${formatMs(metric.asrMs)}${metric.translationMs ? ` · 翻译 ${formatMs(metric.translationMs)}` : ""}`
      : "";
    diagnostics.hidden = !settings.voiceDiagnostics;
    overlay.classList.add("is-visible");
    clearTimeout(overlay.hideTimer);
    overlay.hideTimer = setTimeout(() => {
      delete overlay.dataset.hasSubtitle;
      if (!subtitlePreview) overlay.classList.remove("is-visible");
    }, 9000);
  }
  function hideSubtitle() { const overlay=document.querySelector("#tcat-subtitle-overlay"); if(overlay&&!subtitlePreview) overlay.classList.remove("is-visible"); }

  function ensureSubtitleOverlay() {
    const host = findPlayerHost();
    if (!host) return null;
    let overlay = document.querySelector("#tcat-subtitle-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "tcat-subtitle-overlay";
      overlay.innerHTML = '<div class="tcat-subtitle-original"></div><div class="tcat-subtitle-translation"></div><div class="tcat-subtitle-diagnostics"></div>';
      overlay.title = "拖动可移动字幕；双击恢复默认位置";
      enableOverlayDragging(overlay);
    }
    if (overlay.parentElement !== host) host.append(overlay);
    observePlayer(host);
    applyOverlaySettings(overlay);
    return overlay;
  }

  function ensureOverlayHost() {
    const overlay = document.querySelector("#tcat-subtitle-overlay");
    if (!overlay) return;
    const host = findPlayerHost();
    if (!host) return;
    if (overlay.parentElement !== host) host.append(overlay);
    observePlayer(host);
    applyOverlaySettings(overlay);
  }

  function findPlayerHost() {
    const direct = document.querySelector('[data-a-target="video-player"], .video-player');
    if (direct) return direct;
    const video = document.querySelector("video");
    return video?.closest('[data-a-target="video-player"], .video-player') || video?.parentElement || null;
  }

  function observePlayer(host) {
    if (observedPlayer === host) return;
    playerResizeObserver?.disconnect();
    observedPlayer = host;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    playerResizeObserver = new ResizeObserver(() => {
      const overlay = document.querySelector("#tcat-subtitle-overlay");
      if (overlay) applyOverlaySettings(overlay);
    });
    playerResizeObserver.observe(host);
  }

  function onSettingsChanged(changes, area) {
    if (area === "local") {
      for (const [key, change] of Object.entries(changes)) settings[key] = change.newValue;
      const overlay = document.querySelector("#tcat-subtitle-overlay");
      if (overlay) {
        applyOverlaySettings(overlay);
        const diagnostics = overlay.querySelector(".tcat-subtitle-diagnostics");
        if (diagnostics) diagnostics.hidden = !settings.voiceDiagnostics;
      }
      return;
    }
    // session 区域：同步自动翻译状态（popup 保存/恢复状态时触发）
    if (area === "session" && "autoTranslate" in changes) {
      const saved = changes.autoTranslate.newValue || {};
      autoTranslate = saved.enabled === true && saved.url === location.href;
      if (autoTranslate) setupAutoTranslateObserver();
      else stopAutoTranslateObserver();
    }
  }
  function applyOverlaySettings(overlay) {
    overlay.style.setProperty("--tcat-font-size", `${Number(settings.subtitleSize) || 22}px`);
    overlay.style.setProperty("--tcat-bg-opacity", String(Number(settings.subtitleOpacity) || 0.75));
    const p = settings.subtitlePositionV2;
    const host = overlay.parentElement;
    const halfX = Math.min(0.45, overlay.offsetWidth / Math.max(1, host?.clientWidth || 1) / 2);
    const halfY = Math.min(0.4, overlay.offsetHeight / Math.max(1, host?.clientHeight || 1) / 2);
    const x = clamp(Number.isFinite(p?.x) ? p.x : 0.5, halfX, 1 - halfX);
    const y = clamp(Number.isFinite(p?.y) ? p.y : 0.82, halfY, 1 - halfY);
    overlay.style.left = `${x * 100}%`;
    overlay.style.top = `${y * 100}%`;
    overlay.style.bottom = "auto";
    overlay.style.transform = "translate(-50%, -50%)";
  }

  function enableOverlayDragging(overlay) {
    let drag = null;
    overlay.addEventListener("pointerdown", (event) => {
      const rect = overlay.getBoundingClientRect();
      drag = { dx: event.clientX - (rect.left + rect.width / 2), dy: event.clientY - (rect.top + rect.height / 2) };
      overlay.setPointerCapture(event.pointerId);
      overlay.classList.add("is-dragging");
      event.preventDefault();
    });
    overlay.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const host = overlay.parentElement;
      const rect = host.getBoundingClientRect();
      const halfX = Math.min(0.45, overlay.offsetWidth / Math.max(1, rect.width) / 2);
      const halfY = Math.min(0.4, overlay.offsetHeight / Math.max(1, rect.height) / 2);
      const x = clamp((event.clientX - drag.dx - rect.left) / rect.width, halfX, 1 - halfX);
      const y = clamp((event.clientY - drag.dy - rect.top) / rect.height, halfY, 1 - halfY);
      settings.subtitlePositionV2 = { x, y };
      overlay.style.left = `${x * 100}%`;
      overlay.style.top = `${y * 100}%`;
    });
    overlay.addEventListener("pointerup", (event) => {
      if (!drag) return;
      drag = null;
      overlay.releasePointerCapture(event.pointerId);
      overlay.classList.remove("is-dragging");
      chrome.storage.local.set({ subtitlePositionV2: settings.subtitlePositionV2 });
    });
    overlay.addEventListener("dblclick", () => {
      settings.subtitlePositionV2 = null;
      chrome.storage.local.remove("subtitlePositionV2");
      applyOverlaySettings(overlay);
    });
  }

  function onPointerOver(event) { if (!settings.enabled) return; const line=event.target.closest?.(MESSAGE_SELECTOR); if(!line||line===activeLine||line.contains(event.relatedTarget))return; clearTimeout(hoverTimer);activeLine=line;const seq=++requestSequence;hoverTimer=setTimeout(()=>translateLine(line,seq),clamp(Number(settings.hoverDelay)||350,100,1500)); }
  function onPointerOut(event) { const line=event.target.closest?.(MESSAGE_SELECTOR);if(!line||line.contains(event.relatedTarget))return;if(line===activeLine){clearTimeout(hoverTimer);activeLine=null;requestSequence+=1;} }
  async function translateLine(line) { if(!line.isConnected||line!==activeLine)return;const text=extractMessageText(line);if(!shouldTranslate(text))return;const existing=line.querySelector(":scope > .tcat-translation");if(existing?.dataset.state==="done")return;if(pageCache.has(text)){renderTranslation(line,pageCache.get(text),"done");return;}renderTranslation(line,"正在翻译…","loading");let response;try{response=await chrome.runtime.sendMessage({type:"TRANSLATE",context:"chat",text,targetLanguage:settings.targetLanguage,category:pageContext.category});}catch(error){response={ok:false,error:error.message||"插件后台连接失败"};}if(!line.isConnected)return;if(!response?.ok){renderTranslation(line,response?.error||"翻译失败","error");return;}remember(text,response.translation);renderTranslation(line,response.translation,"done"); }
  function extractMessageText(line) { const fragments=[...line.querySelectorAll(BODY_SELECTORS.join(","))];if(fragments.length){const leaves=fragments.filter(node=>!fragments.some(other=>other!==node&&node.contains(other)));const text=leaves.map(readNodeText).join(" ");if(text.trim())return normalize(text);}const clone=line.cloneNode(true);clone.querySelectorAll(".tcat-translation, [data-a-target*=badge], [data-a-target*=username], .chat-author__display-name").forEach(node=>node.remove());return normalize(readNodeText(clone)); }
  function readNodeText(node){const clone=node.cloneNode(true);clone.querySelectorAll("img[alt]").forEach(image=>image.replaceWith(` ${image.alt} `));return clone.textContent||"";}
  function shouldTranslate(text){if(!text||text.length<2||/^https?:\/\/\S+$/i.test(text)||!/[\p{L}\p{N}]/u.test(text))return false;if(settings.targetLanguage==="简体中文"){const letters=[...text].filter(c=>/\p{L}/u.test(c));const chinese=letters.filter(c=>/\p{Script=Han}/u.test(c));if(letters.length&&chinese.length/letters.length>.7)return false;}return true;}
  function renderTranslation(line,text,state){let output=line.querySelector(":scope > .tcat-translation");if(!output){output=document.createElement("div");output.className="tcat-translation";line.append(output);}output.dataset.state=state;output.textContent=text;if(state==="done"||state==="error"){console.log("[TCAT] renderTranslation: 翻译完成，尝试滚动", {state, text: text?.substring(0, 50)});requestAnimationFrame(()=>scrollToTranslationIfNeeded(output));}}
  function scrollToTranslationIfNeeded(element) {
    try {
      const chatContainer = findChatContainer();
      if (!chatContainer) {
        console.warn("[TCAT] scrollToTranslationIfNeeded: 未找到聊天容器，无法滚动");
        return;
      }

      const containerRect = chatContainer.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();

      console.log("[TCAT] scrollToTranslationIfNeeded: 位置检查", {
        elementBottom: Math.round(elementRect.bottom),
        containerBottom: Math.round(containerRect.bottom),
        elementTop: Math.round(elementRect.top),
        containerTop: Math.round(containerRect.top),
        containerScrollHeight: chatContainer.scrollHeight,
        containerClientHeight: chatContainer.clientHeight,
        containerScrollTop: chatContainer.scrollTop,
        needsScroll: elementRect.bottom > containerRect.bottom
      });

      // 检查元素是否在容器可视区域下方（需要向下滚动）
      if (elementRect.bottom > containerRect.bottom) {
        const scrollDistance = elementRect.bottom - containerRect.bottom;
        console.log("[TCAT] scrollToTranslationIfNeeded: 执行滚动", {
          scrollDistance: Math.round(scrollDistance),
          behavior: "smooth"
        });
        chatContainer.scrollBy({ top: scrollDistance, behavior: "smooth" });
      }
      // 也检查元素是否在容器可视区域上方（需要向上滚动）
      else if (elementRect.top < containerRect.top) {
        const scrollDistance = containerRect.top - elementRect.top;
        console.log("[TCAT] scrollToTranslationIfNeeded: 向上滚动", {
          scrollDistance: Math.round(scrollDistance),
          behavior: "smooth"
        });
        chatContainer.scrollBy({ top: -scrollDistance, behavior: "smooth" });
      }
    } catch (e) {
      console.error("[TCAT] scrollToTranslationIfNeeded: 滚动出错", e);
    }
  }
  function remember(key,value){pageCache.set(key,value);if(pageCache.size>CACHE_LIMIT)pageCache.delete(pageCache.keys().next().value);}
  function clearPageState(){pageCache.clear();clearTimeout(hoverTimer);activeLine=null;requestSequence+=1;document.querySelectorAll(".tcat-translation").forEach(node=>node.remove());autoTranslate=false;stopAutoTranslateObserver();}
  function normalize(text){return String(text||"").replace(/\s+/g," ").trim().slice(0,2000);}
  function clamp(value,min,max){return Math.min(max,Math.max(min,value));}
  function formatMs(value){const ms=Math.max(0,Number(value)||0);return ms>=1000?`${(ms/1000).toFixed(1)}s`:`${Math.round(ms)}ms`;}
})();
