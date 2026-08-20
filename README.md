# Twitch Chat AI Translator

Chrome MV3 扩展：翻译 Twitch 聊天消息，并在本机使用 Whisper 识别直播音频，再通过 DeepSeek 翻译字幕。聊天文本和识别出的文字会发送到 DeepSeek；原始直播音频只在本机处理。

## 1.0.0 迭代内容

- 改进直播音频分段：使用噪声底估计、语音前置缓冲、停顿收尾和有界队列，降低低音量语音被漏掉或队列阻塞的概率。
- 设置页可从 Hugging Face 模型 API 刷新受支持模型的 revision；网络不可用时继续使用内置模型或已缓存的安全 revision。下载始终写入用户选择的普通磁盘文件夹。
- 本地 ASR worker 显式使用扩展内置 ORT WASM 资源。WebGPU 模型使用 JSEP 资源，Tiny CPU 模型使用普通 WASM 资源；远程模型和浏览器模型缓存均关闭，并保留 ORT 错误诊断。

## 运行环境与依赖

- Chrome 116 或更高版本，支持 Manifest V3。
- DeepSeek API Key（聊天翻译和字幕翻译都需要）。
- WebGPU 是 Distil Small/Base 模型的推荐后端；没有 WebGPU 时请选择 Tiny English CPU/WASM 模型。
- 选择本地模型时需要 Chrome 的 File System Access API。模型目录权限保存在扩展本地存储中。
- 项目不使用 npm 构建脚本，也没有需要编译的源代码；`assets/` 中已包含 Transformers.js 与 ONNX Runtime 的运行时资源。

## 安装与首次配置

1. 打开 `chrome://extensions`，启用右上角的“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择本项目根目录。
3. 打开扩展设置，填写 DeepSeek API Key，并按需设置目标语言和悬停触发时间。
4. 在“本地语音模型”中选择模型。推荐点击“刷新模型目录”，然后点击“选择文件夹并自动下载”；也可以选择已经下载完整的模型目录。
5. 打开或刷新 Twitch 直播页，点击扩展图标，再点击“开启当前页面字幕”。每个 Twitch 标签页都需要在该标签页上手动开启一次 Chrome 捕获授权。

## 模型与下载

设置页内置三个受支持 profile：

| Profile | 后端 | 适用场景 |
| --- | --- | --- |
| Distil Small English | WebGPU | 有现代显卡时的推荐质量 |
| Whisper Base English | WebGPU | 更高准确度、可接受更高开销 |
| Whisper Tiny English | CPU/WASM | 没有 WebGPU 时的兼容模式 |

“刷新模型目录”接受上述内置 profile，以及通过文件清单安全检查的 `onnx-community` Whisper ONNX profile，并把 API 返回的安全 commit SHA 缓存为下载 revision；不会把任意 API 条目变成可执行模型。请求失败时继续使用内置 profile；已经成功缓存的安全 revision 也可离线使用。

下载过程会逐个下载并写入 profile 所需文件，进度显示在设置页。模型文件保存到用户选择的普通磁盘文件夹，不使用 Chrome 浏览器缓存。若模型选择发生变化、目录权限变为 `prompt`，或文件不完整，请重新选择目录或重新下载。

## 使用

- 将鼠标停留在 Twitch 聊天消息上，等待悬停延迟后显示译文。
- 在聊天框输入中文，点击翻译按钮；也可以按 `Shift + Alt + Enter` 翻译并发送。
- 开启本地字幕后，可在设置中选择“低延迟 / 均衡 / 高准确”识别模式。
- “字幕诊断模式”会显示音频分段、排队、识别和翻译耗时；“调试面板”可查看并导出结构化日志。

## 故障排查

- **没有识别到语音**：确认 Twitch 直播正在播放且当前标签页已开启字幕；尝试“低延迟”模式，并确认系统没有把标签页静音。
- **WebGPU 或 ORT 初始化失败**：先停止字幕，再在设置中改用 Tiny CPU/WASM；若模型文件来自旧版本，使用“选择文件夹并自动下载”重新下载完整 profile。
- **提示模型文件不完整或需要重新授权**：重新点击“使用已有模型文件夹”，授予读取权限；必要时重新下载。
- **模型目录刷新失败**：检查网络连接。刷新失败不会删除内置模型或已缓存 revision。
- **聊天译文没有发送**：确认聊天框仍处于可输入状态，并重试一次；调试面板可用于查看翻译请求和 Slate 输入校验结果。

## 测试与加载

本项目没有单独的编译步骤。修改 JavaScript 后，直接在 `chrome://extensions` 中点击扩展的“重新加载”即可验证浏览器行为。

需要 Node.js 22 或更高版本运行回归测试：

```powershell
node --test tests/*.test.js
```

如果运行环境禁止 Node 测试运行器创建子进程，可逐文件执行：

```powershell
Get-ChildItem tests\*.test.js | ForEach-Object { node $_.FullName }
```

测试覆盖音频分段与队列、模型目录 API 的安全过滤和离线缓存回退、ORT WASM 资源选择及错误诊断。测试不会下载真实模型，也不会替代 Chrome/Twitch 实际页面验收。

## 数据、权限与隐私

- `storage`：保存 API Key、设置和模型目录句柄。
- `tabCapture`、`offscreen`、`activeTab`：捕获当前 Twitch 标签页音频并在 offscreen 文档中处理。
- `https://www.twitch.tv/*`：读取聊天消息并显示译文。
- `https://api.deepseek.com/*`：请求聊天和字幕翻译。
- `https://huggingface.co/*` 及其子域：刷新模型目录和下载模型文件。
- API Key 只保存在 Chrome 扩展本地存储中，不写入 Twitch 页面；音频不上传到语音识别服务，但 ASR 文字会发送到 DeepSeek 进行翻译。
