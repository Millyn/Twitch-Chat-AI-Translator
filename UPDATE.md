# 当前版本 1.2.0

# 1.2 版本
1. [bug] 在直播间语音流获取到翻译时有时会出现获取到`[?...` 的情况，首先我们要避免这种情况，其次，如果有这种情况那么就不要向 API 发出请求，直接 PASS 掉这个语音。✅ 已完成

# 1.2 版本完成内容
- background.js: 新增 isGarbageAsrText() 垃圾文本检测函数，过滤 Whisper 幻觉片段
- background.js: handleAsrText() 入口处增加垃圾文本过滤，命中后直接跳过不发送翻译请求
- background.js: 垃圾文本跳过时输出 console.log 日志便于排查
- manifest.json: 版本号更新为 1.2.0

完成时间：2026-08-20

# 1.1 版本更新目的

1. [bug] 关于直播间的翻译，我有要求向 Deepseek 翻译英文时提供当前游戏分区，作为更专业化的翻译结果，但这个功能似乎没有正常实现，需要检查。✅ 已完成
2. [opt] 优化DEBUG页面的显示，首先 DEBUG 页面应该是列表，是每一个请求就出现一列，这一列里要包含本地模型采集到的原始音频，向 DEEPSEEK API 发送的请求体内容，以及 DEEPSEEK 返回的结果，现在这种 DEBUG 页面太乱了，根本排查不了问题。在向 API 请求时，有 2 种，一种是直播间语音原文，我们定义为 Streaming，一种是直播间CHAT文字，我们定义为 Chat，作为区分。✅ 已完成

完成时间：2026-08-20

# 1.1 版本完成内容
- content.js: readCategory() 增加 10+ 个备用选择器（data-testid、data-test-selector、ARIA、meta 标签等），支持 /directory/game/ 链接，增加防御性检查和调试日志。
- background.js: translateMessage() 签名增加 requestId 参数，所有 sendDebugMessage 调用传入 requestId，翻译成功时调用 finishDebugRequest。
- background.js: 新增 createRequestId()、createDebugRequest()、updateDebugRequest()、finishDebugRequest() 等函数，实现按请求聚合的调试数据结构。
- background.js: normalizeCategory() 增强防御空值、对象、数组等异常输入。
- debug.js: 支持 DEBUG_REQUEST 消息类型，按 request.id 更新或插入记录。
- debug.html: 表格列更新为时间、类型、原文、状态、耗时、操作。
- debug.js: Streaming/Chat 徽章分别使用蓝色/绿色，点击行展开查看详情。
- debug.css: 增加展开/收起动画及键盘操作支持。
- manifest.json: 版本号更新为 1.1.0。

# 1.0 版本更新目的

1. [bug] 现在对直播间的字幕识别有问题，主播讲话经常识别不到语音内容。✅ 已完成
2. [opt] 我看的大多都是英文直播间，优化可选的本地语音模型，建议通过 API 可获取模型列表，然后直接下载到本地。✅ 已完成
3. [bug] Chrome 插件提示有 Error "assets/ort-wasm-simd-threaded.jsep.mjs:100 (Bc)" ✅ 已完成

完成时间：2026-08-20

# 1.0 版本完成内容
- offscreen.js: 增加语音前置缓冲、噪声底自适应、直播音频结束时收尾识别和有界 FIFO 调度，降低漏识别。
- options.js/model-store.js: 通过 Hugging Face API 获取并安全筛选可用 ONNX Whisper 模型，支持缓存回退、动态模型下载、文件校验和目录权限状态。
- assets/asr-worker.js: 固定使用扩展内置 ORT WASM 资源，区分 WebGPU JSEP 与 Tiny CPU/WASM，并保留原始 ORT 错误诊断。
- manifest.json: 版本号更新为 1.0.0。

# 0.9 版本更新目的

1. [opz] 优化debug页面的样式，现在的 debug 页面不利于观看，应为列表样式，并且优化长 JSON 串的浏览视觉，方便用户。✅ 已完成

完成时间：2026-08-20

# 0.9 版本完成内容
- debug.html: 改为单一表格布局，每行 = 一次完整翻译请求
- debug.js: 重构为统一日志列表，每条记录包含时间、类型、状态、摘要、耗时、详情
- debug.js: 支持点击"详情"展开查看完整 JSON，再次点击收起
- debug.css: 表格行式布局样式，类型徽章按类别着色
- manifest.json: 版本号更新为 0.9.0

# 0.8 版本更新目的

1. [bug] 发送 Chat 的翻译功能出现问题，当我输入中文，点击翻译按钮之后自动发送时会提示"Twitch 输入框未接受译文" 类似提示，无法正常发送 Chat ✅ 已完成

完成时间：2026-08-20

# 0.8 版本完成内容
- content.js: writeInputOnce() 重构为多策略降级链
- content.js: 新增 tryInsertReplacementStrategy() — insertReplacementText beforeinput
- content.js: 新增 tryInsertTextStrategy() — insertText beforeinput  
- content.js: 新增 tryClipboardPasteStrategy() — 剪贴板粘贴作为最后手段
- manifest.json: 版本号更新为 0.8.0

# 0.7 版本更新目的

1. [bug] 修复自动翻译按钮如果是相同的直播间重新进入时是默认勾选，但实际并无任何自动翻译效果。✅ 已完成
2. [bug] 修复 debug 页面打开时抢占 TRANSLATE 消息响应，导致自动/手动聊天翻译间歇性显示"翻译失败"。✅ 已完成

完成时间：2026-08-19

# 0.7 版本完成内容
- content.js: maintenance() URL 变化后重新读取自动翻译会话状态并恢复监听器
- content.js: onSettingsChanged() 监听 chrome.storage.session 变化，实时同步自动翻译状态
- popup.js: loadAutoTranslateState() 恢复勾选后向页面发送 AUTO_TRANSLATE_CHANGED 同步消息
- debug.js: onMessage 监听器仅处理 DEBUG_* 消息，不再无条件响应，避免抢占 background 的 TRANSLATE 响应
- manifest.json: 版本号更新为 0.7.0

# 0.6 版本更新目的
1. [feature] 在 Twitch Chat 方面新增一个勾选，自动识别新聊天内容并翻译，当用户勾选此按钮时，当Chat出现新的聊天内容，自动为用户翻译，减少用户重复的交互行为，这个勾选只应用于当前 Twitch 直播间，并且关闭直播间后，下次在进入相同直播间时，需要用户在次点击，仅为临时保存状态。✅ 已完成
2. [feature] 增加独立的 debug 页面，当 debug 模式启动时，启动独立页面展示更多的 debug 内容，包括但不限于【采集到的原始音频】【DEEPSEEK API 请求】【PROMPT】【当前识别到的直播分类】【耗时】【TOKEN 用量】等详细的内容，便于后期调优。✅ 已完成

# 0.6 版本完成内容
- popup.html: 添加"自动翻译"勾选框
- popup.js: 添加自动翻译状态管理（chrome.storage.session）
- content.js: 添加 MutationObserver 自动翻译新消息
- debug.html: 新建独立调试页面
- debug.js: 实现调试信息监听和展示
- debug.css: 调试页面样式
- background.js: 实现调试数据收集和发送
- manifest.json: 添加 contextMenus 权限和快捷键配置（Ctrl+Shift+D）
