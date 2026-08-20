const form = document.querySelector("#settings-form");
const enabled = document.querySelector("#enabled");
const apiKey = document.querySelector("#api-key");
const targetLanguage = document.querySelector("#target-language");
const hoverDelay = document.querySelector("#hover-delay");
const status = document.querySelector("#status");
const modelBadge = document.querySelector("#model-badge");
const modelProgress = document.querySelector("#model-progress");
const progressBar = document.querySelector("#progress-bar");
const progressText = document.querySelector("#progress-text");
const voiceModel = document.querySelector("#voice-model");
const voiceMode = document.querySelector("#voice-mode");
const subtitleSize = document.querySelector("#subtitle-size");
const subtitleOpacity = document.querySelector("#subtitle-opacity");
const voiceDiagnostics = document.querySelector("#voice-diagnostics");
const refreshModelCatalogButton = document.querySelector("#refresh-model-catalog");
const modelCatalogStatus = document.querySelector("#model-catalog-status");
const catalogApiUrlInput = document.querySelector("#model-catalog-api-url");
const downloadModelButton = document.querySelector("#download-model");
const selectModelButton = document.querySelector("#select-model");

const MODEL_CATALOG_API_URL = "https://huggingface.co/api/models?author=onnx-community&filter=onnx&pipeline_tag=automatic-speech-recognition&limit=100&expand[]=author&expand[]=sha&expand[]=tags&expand[]=pipeline_tag&expand[]=private&expand[]=gated&expand[]=disabled&expand[]=siblings";
const MODEL_CATALOG_STORAGE_KEY = "modelCatalog";
const MODEL_CATALOG_API_STORAGE_KEY = "modelCatalogApiUrl";
const MODEL_CATALOG_MAX_DYNAMIC_MODELS = 30;
const MODEL_CATALOG_OWNER = "onnx-community";
const MODEL_CATALOG_REQUIRED_FILES = [
  "config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json",
  "preprocessor_config.json", "onnx/encoder_model.onnx",
];

const MODEL_PROFILES = {
  "distil-small-webgpu": {
    repo: "onnx-community/distil-small.en_timestamped",
    name: "Distil-Whisper Small English FP32 + Q4 · WebGPU",
    description: "推荐 · 英语直播低延迟与高准确度",
    backend: "webgpu",
    revision: "main",
    files: ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json",
      "preprocessor_config.json", "onnx/encoder_model.onnx", "onnx/decoder_model_merged_q4.onnx"],
  },
  "base-webgpu": {
    repo: "onnx-community/whisper-base.en",
    name: "Whisper Base English FP32 + Q4 · WebGPU",
    description: "高准确 · 适合显存充足的显卡",
    backend: "webgpu",
    revision: "main",
    files: ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json",
      "preprocessor_config.json", "onnx/encoder_model.onnx", "onnx/decoder_model_merged_q4.onnx"],
  },
  "tiny-fp32": {
    repo: "onnx-community/whisper-tiny.en",
    name: "Whisper Tiny English FP32 · CPU",
    description: "兼容 · 无 WebGPU 显卡也可使用",
    backend: "wasm",
    revision: "main",
    files: ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json",
      "preprocessor_config.json", "onnx/encoder_model.onnx", "onnx/decoder_model_merged.onnx"],
  },
};

function cloneModelProfiles(profiles = MODEL_PROFILES) {
  return Object.fromEntries(Object.entries(profiles || {}).map(([key, profile]) => [key, cloneModelProfile(profile)]));
}

function cloneModelProfile(profile) {
  if (!profile || typeof profile !== "object") return profile;
  return {
    ...profile,
    files: Array.isArray(profile.files) ? [...profile.files] : [],
    fileMeta: profile.fileMeta && typeof profile.fileMeta === "object" ? { ...profile.fileMeta } : undefined,
    metadata: profile.metadata && typeof profile.metadata === "object" ? { ...profile.metadata } : undefined,
  };
}

function isSafeSha(value) {
  return typeof value === "string" && /^[a-f0-9]{7,64}$/i.test(value);
}

function isSafeRepo(value) {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  return parts.length === 2 && parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(part));
}

function isSafeModelKey(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,95}$/.test(value);
}

function isSafeModelPath(value) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")) return false;
  return value.split("/").every((part) => part && part !== "." && part !== ".." &&
    !part.includes("?") && !part.includes("#") && !part.includes("[") && !part.includes("]"));
}

function isSafeRevision(value) {
  return value === "main" || isSafeSha(value);
}

function isSafeDisplayText(value, maxLength = 160) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    !/[<>\u0000-\u001f]/.test(value);
}

function isSafeModelFiles(files) {
  return Array.isArray(files) && files.length > 0 && files.length <= 32 &&
    new Set(files).size === files.length && files.every(isSafeModelPath);
}

function hasWorkerCompatibleFiles(files) {
  if (!isSafeModelFiles(files)) return false;
  if (!MODEL_CATALOG_REQUIRED_FILES.every((path) => files.includes(path))) return false;
  return files.includes("onnx/decoder_model_merged_q4.onnx");
}

function isSafeFileMeta(fileMeta, files = []) {
  if (!fileMeta || typeof fileMeta !== "object" || Array.isArray(fileMeta)) return true;
  return Object.entries(fileMeta).every(([path, value]) => isSafeModelPath(path) && files.includes(path) &&
    Number.isSafeInteger(value) && value > 0);
}

function isSafeCatalogApiUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  let hostname = "";
  if (typeof URL !== "function") {
    const match = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value);
    hostname = match?.[1]?.toLowerCase().replace(/\.$/, "") || "";
  } else {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
      hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    } catch {
      return false;
    }
  }
  return hostname === "huggingface.co" || hostname.endsWith(".huggingface.co") ||
    hostname === "hf.co" || hostname.endsWith(".hf.co");
}

function isLegacyDefaultCatalogApiUrl(value) {
  if (!isSafeCatalogApiUrl(value)) return false;
  try {
    const url = new URL(value);
    if (url.pathname !== "/api/models") return false;
    const params = url.searchParams;
    const author = params.get("author");
    const search = params.get("search");
    return (!author || author === MODEL_CATALOG_OWNER) &&
      (!search || search === "whisper") &&
      params.get("filter") === "onnx" &&
      params.get("pipeline_tag") === "automatic-speech-recognition";
  } catch {
    return false;
  }
}

function normalizeCatalogApiUrl(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && isLegacyDefaultCatalogApiUrl(trimmed) ? MODEL_CATALOG_API_URL : trimmed;
}

function findProfileKeyByRepo(repo, profiles = MODEL_PROFILES) {
  return Object.entries(profiles).find(([, profile]) => profile.repo === repo)?.[0] || null;
}

function readSafeMetadata(entry) {
  const metadata = {};
  if (typeof entry.lastModified === "string" && entry.lastModified.length <= 128) metadata.lastModified = entry.lastModified;
  if (Number.isSafeInteger(entry.downloads) && entry.downloads >= 0) metadata.downloads = entry.downloads;
  if (typeof entry.pipeline_tag === "string" && entry.pipeline_tag.length <= 64) metadata.pipelineTag = entry.pipeline_tag;
  if (Number.isSafeInteger(entry.likes) && entry.likes >= 0) metadata.likes = entry.likes;
  return metadata;
}

function catalogKeyForRepo(repo) {
  const slug = repo.split("/")[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `hf-${slug}`.slice(0, 96);
}

function readCatalogSiblings(entry) {
  if (!Array.isArray(entry?.siblings)) return [];
  return entry.siblings.map((item) => {
    const path = typeof item === "string" ? item : item?.rfilename;
    if (!isSafeModelPath(path)) return null;
    const size = Number.isSafeInteger(item?.size) && item.size > 0 ? item.size : null;
    return { path, size };
  }).filter(Boolean);
}

function deriveDynamicCatalogProfile(entry, revision) {
  const siblings = readCatalogSiblings(entry);
  const siblingPaths = new Set(siblings.map((item) => item.path));
  if (!MODEL_CATALOG_REQUIRED_FILES.every((path) => siblingPaths.has(path))) return null;
  if (!siblingPaths.has("onnx/decoder_model_merged_q4.onnx")) return null;
  const files = [...MODEL_CATALOG_REQUIRED_FILES, "onnx/decoder_model_merged_q4.onnx"];
  const fileMeta = Object.fromEntries(siblings.filter((item) => files.includes(item.path) && item.size).map((item) => [item.path, item.size]));
  const key = catalogKeyForRepo(entry.id);
  if (!isSafeModelKey(key)) return null;
  return {
    key,
    profile: {
      repo: entry.id,
      name: `目录模型 · ${entry.id}`,
      description: "官方目录 · WebGPU Q4",
      backend: "webgpu",
      revision,
      files,
      fileMeta,
      metadata: readSafeMetadata(entry),
      catalog: true,
    },
  };
}

function parseCatalogEntry(entry, profiles = MODEL_PROFILES) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (!isSafeRepo(entry.id) || entry.author !== entry.id.split("/")[0]) return null;
  if (!Array.isArray(entry.tags) || !entry.tags.includes("onnx") ||
      (!entry.tags.includes("automatic-speech-recognition") && entry.pipeline_tag !== "automatic-speech-recognition")) return null;
  if (entry.private === true || entry.gated === true || entry.disabled === true) return null;
  if (!isSafeSha(entry.sha)) return null;
  const key = findProfileKeyByRepo(entry.id, profiles);
  if (key) {
    return {
      key,
      revision: entry.sha,
      metadata: readSafeMetadata(entry),
    };
  }
  if (entry.id.split("/")[0] !== MODEL_CATALOG_OWNER || !entry.id.toLowerCase().includes("whisper")) return null;
  return deriveDynamicCatalogProfile(entry, entry.sha);
}

function isValidCachedDynamicProfile(key, profile) {
  return isSafeModelKey(key) && key.startsWith("hf-") && profile?.catalog === true &&
    isSafeRepo(profile.repo) && profile.repo.split("/")[0] === MODEL_CATALOG_OWNER &&
    isSafeDisplayText(profile.name) && isSafeDisplayText(profile.description, 200) &&
    profile.backend === "webgpu" && isSafeRevision(profile.revision) &&
    hasWorkerCompatibleFiles(profile.files) && isSafeFileMeta(profile.fileMeta, profile.files);
}

function serializeProfile(profile) {
  const serialized = {
    revision: profile.revision,
    metadata: profile.metadata && typeof profile.metadata === "object" ? { ...profile.metadata } : {},
  };
  if (profile.catalog && isSafeRepo(profile.repo) && hasWorkerCompatibleFiles(profile.files)) {
    serialized.repo = profile.repo;
    serialized.name = profile.name;
    serialized.description = profile.description;
    serialized.backend = profile.backend;
    serialized.files = [...profile.files];
    serialized.fileMeta = profile.fileMeta && typeof profile.fileMeta === "object" ? { ...profile.fileMeta } : {};
    serialized.catalog = true;
  }
  return serialized;
}

function parseCatalogEntries(payload, profiles = MODEL_PROFILES) {
  if (!Array.isArray(payload)) return [];
  const entries = [];
  let dynamicCount = 0;
  for (const item of payload) {
    const entry = parseCatalogEntry(item, profiles);
    if (!entry) continue;
    if (entry.profile) {
      if (dynamicCount >= MODEL_CATALOG_MAX_DYNAMIC_MODELS) continue;
      dynamicCount += 1;
    }
    entries.push(entry);
  }
  return entries;
}

function mergeCatalogProfiles(payload, baseProfiles = MODEL_PROFILES) {
  const merged = cloneModelProfiles(baseProfiles);
  for (const entry of parseCatalogEntries(payload, baseProfiles)) {
    if (!entry.key) continue;
    if (entry.profile) {
      if (isValidCachedDynamicProfile(entry.key, entry.profile)) merged[entry.key] = cloneModelProfile(entry.profile);
      continue;
    }
    if (!merged[entry.key]) continue;
    merged[entry.key] = {
      ...merged[entry.key],
      revision: entry.revision,
      metadata: entry.metadata,
    };
  }
  return merged;
}

function mergeCachedProfiles(cache, baseProfiles = MODEL_PROFILES) {
  const merged = cloneModelProfiles(baseProfiles);
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) return merged;
  for (const [key, value] of Object.entries(cache)) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !isSafeRevision(value.revision)) continue;
    if (merged[key]) {
      merged[key] = {
        ...merged[key],
        revision: value.revision,
        metadata: value.metadata && typeof value.metadata === "object" ? { ...value.metadata } : {},
      };
    } else if (isValidCachedDynamicProfile(key, value)) {
      merged[key] = cloneModelProfile(value);
    }
  }
  return merged;
}

function serializeCatalogProfiles(profiles) {
  const cache = {};
  for (const [key, profile] of Object.entries(profiles || {})) {
    if (!isSafeModelKey(key) || !isSafeRevision(profile?.revision)) continue;
    cache[key] = serializeProfile(profile);
  }
  return cache;
}

function applyModelProfiles(profiles) {
  const next = cloneModelProfiles(profiles);
  for (const key of Object.keys(MODEL_PROFILES)) {
    if (MODEL_PROFILES[key]?.catalog && !next[key]) delete MODEL_PROFILES[key];
  }
  for (const [key, profile] of Object.entries(next)) {
    if (!profile || !isSafeModelFiles(profile.files)) continue;
    MODEL_PROFILES[key] = cloneModelProfile(profile);
  }
  renderModelOptions(MODEL_PROFILES);
}

async function readCachedModelProfiles(storageArea, baseProfiles) {
  if (!storageArea?.get) return cloneModelProfiles(baseProfiles);
  try {
    const stored = await storageArea.get({ [MODEL_CATALOG_STORAGE_KEY]: null });
    return mergeCachedProfiles(stored?.[MODEL_CATALOG_STORAGE_KEY], baseProfiles);
  } catch {
    return cloneModelProfiles(baseProfiles);
  }
}

async function readCatalogApiUrl(storageArea, explicitUrl) {
  if (typeof explicitUrl === "string" && explicitUrl.trim()) return normalizeCatalogApiUrl(explicitUrl);
  if (storageArea?.get) {
    try {
      const stored = await storageArea.get({ [MODEL_CATALOG_API_STORAGE_KEY]: MODEL_CATALOG_API_URL });
      if (typeof stored?.[MODEL_CATALOG_API_STORAGE_KEY] === "string" && stored[MODEL_CATALOG_API_STORAGE_KEY].trim()) {
        return normalizeCatalogApiUrl(stored[MODEL_CATALOG_API_STORAGE_KEY]);
      }
    } catch {
    }
  }
  return MODEL_CATALOG_API_URL;
}

async function refreshModelCatalog({ fetchImpl, storageArea, apiUrl } = {}) {
  const baseProfiles = cloneModelProfiles(MODEL_PROFILES);
  const storage = storageArea || (typeof chrome !== "undefined" ? chrome.storage.local : null);
  const cachedProfiles = await readCachedModelProfiles(storage, baseProfiles);
  const request = fetchImpl || (typeof fetch === "function" ? fetch : null);
  const catalogUrl = await readCatalogApiUrl(storage, apiUrl);
  if (!request) return { source: "fallback", profiles: cachedProfiles, apiUrl: catalogUrl, error: new Error("fetch unavailable") };
  if (!isSafeCatalogApiUrl(catalogUrl)) {
    return { source: "fallback", profiles: cachedProfiles, apiUrl: catalogUrl, error: new Error("模型目录 API 地址必须使用 Hugging Face 官方域名（huggingface.co 或 hf.co）") };
  }
  try {
    const response = await request(catalogUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response?.ok || typeof response.json !== "function") {
      throw new Error(`模型目录请求失败（HTTP ${response?.status || 0}）`);
    }
    const payload = await response.json();
    const entries = parseCatalogEntries(payload, baseProfiles);
    if (!entries.length) throw new Error("模型目录没有可用的受支持模型");
    const profiles = mergeCatalogProfiles(payload, cachedProfiles);
    try {
      await storage?.set?.({
        [MODEL_CATALOG_STORAGE_KEY]: serializeCatalogProfiles(profiles),
        [MODEL_CATALOG_API_STORAGE_KEY]: catalogUrl,
      });
    } catch {
    }
    return { source: "api", profiles, entries, apiUrl: catalogUrl };
  } catch (error) {
    return { source: "fallback", profiles: cachedProfiles, apiUrl: catalogUrl, error };
  }
}

function buildModelFileUrl(repo, revision, path) {
  if (!isSafeRepo(repo)) throw new Error("Unsafe model repository");
  if (!isSafeRevision(revision)) throw new Error("Unsafe model revision");
  if (!isSafeModelPath(path)) throw new Error("Unsafe model path");
  const encodedRepo = repo.split("/").map((part) => encodeURIComponent(part)).join("/");
  const encodedPath = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `https://huggingface.co/${encodedRepo}/resolve/${encodeURIComponent(revision)}/${encodedPath}?download=true`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function modelOptionLabel(key, profile) {
  const prefix = profile.catalog ? "官方目录" : (profile.backend === "wasm" ? "兼容" : "内置");
  return `${prefix} · ${profile.name || key}`;
}

function renderModelOptions(profiles = MODEL_PROFILES) {
  if (!voiceModel) return;
  const previous = voiceModel.value;
  const entries = Object.entries(profiles || {}).filter(([, profile]) => profile && isSafeModelFiles(profile.files));
  const builtInOrder = ["distil-small-webgpu", "base-webgpu", "tiny-fp32"];
  entries.sort(([a], [b]) => {
    const ai = builtInOrder.indexOf(a);
    const bi = builtInOrder.indexOf(b);
    if (ai >= 0 || bi >= 0) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return a.localeCompare(b);
  });
  const markup = entries.map(([key, profile]) => `<option value="${escapeHtml(key)}">${escapeHtml(modelOptionLabel(key, profile))}</option>`).join("");
  voiceModel.innerHTML = markup;
  if (entries.some(([key]) => key === previous)) voiceModel.value = previous;
  else if (entries.length && !voiceModel.value) voiceModel.value = entries[0][0];
}

function setCatalogStatus(message, isError = false) {
  if (!modelCatalogStatus) return;
  modelCatalogStatus.textContent = message;
  modelCatalogStatus.classList.toggle("error", isError);
}

function catalogErrorMessage(error) {
  const message = String(error?.message || error || "未知错误").replace(/\s+/g, " ").trim();
  if (!message) return "未知错误";
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "网络请求失败（请检查网络、跨域设置或扩展联网权限）";
  }
  return message.slice(0, 240);
}

async function initializeModelCatalog() {
  setCatalogStatus("正在检查模型目录…");
  const result = await refreshModelCatalog();
  applyModelProfiles(result.profiles);
  if (catalogApiUrlInput && result.apiUrl) catalogApiUrlInput.value = result.apiUrl;
  const count = Object.keys(result.profiles).length;
  setCatalogStatus(result.source === "api" ? `模型目录已更新 · 可用 ${count} 个模型` :
    `模型目录更新失败：${catalogErrorMessage(result.error)}；继续使用已缓存/内置模型`, result.source !== "api");
  return result;
}

async function refreshModelCatalogFromUi() {
  if (refreshModelCatalogButton) refreshModelCatalogButton.disabled = true;
  setCatalogStatus("正在刷新模型目录…");
  try {
    const apiUrl = catalogApiUrlInput?.value?.trim() || undefined;
    const result = await refreshModelCatalog({ apiUrl });
    applyModelProfiles(result.profiles);
    if (catalogApiUrlInput && result.apiUrl) catalogApiUrlInput.value = result.apiUrl;
    const count = Object.keys(result.profiles).length;
    setCatalogStatus(result.source === "api" ? `模型目录已更新 · 可用 ${count} 个模型` :
      `刷新失败：${catalogErrorMessage(result.error)}；继续使用已缓存/内置模型`, result.source !== "api");
  } finally {
    if (refreshModelCatalogButton) refreshModelCatalogButton.disabled = false;
  }
}

renderModelOptions(MODEL_PROFILES);
void initializeModelCatalog()
  .then(() => loadSettings())
  .then(() => refreshModelStatus())
  .catch((error) => setCatalogStatus(`模型目录初始化失败，继续使用内置模型：${error?.message || error}`, true));

if (refreshModelCatalogButton) refreshModelCatalogButton.addEventListener("click", refreshModelCatalogFromUi);

if (typeof globalThis !== "undefined" && globalThis.__TCAT_MODEL_CATALOG_TEST__) {
  globalThis.__TCAT_MODEL_CATALOG__ = {
    MODEL_CATALOG_API_URL,
    MODEL_CATALOG_API_STORAGE_KEY,
    buildModelFileUrl,
    cloneModelProfiles,
    catalogErrorMessage,
    isSafeCatalogApiUrl,
    normalizeCatalogApiUrl,
    mergeCatalogProfiles,
    mergeCachedProfiles,
    parseCatalogEntries,
    refreshModelCatalog,
    renderModelOptions,
    validateModelInstallation,
  };
}

async function loadSettings() {
  const saved = await chrome.storage.local.get({
    enabled: true,
    apiKey: "",
    targetLanguage: "简体中文",
    hoverDelay: 350,
    voiceModel: "distil-small-webgpu",
    voiceMode: "balanced",
    subtitleSize: 22,
    subtitleOpacity: 0.75,
    voiceDiagnostics: false,
    modelCatalogApiUrl: MODEL_CATALOG_API_URL,
  });
  if (!MODEL_PROFILES[saved.voiceModel]) {
    saved.voiceModel = "distil-small-webgpu";
    saved.localModelReady = false;
    await chrome.storage.local.set({ voiceModel: saved.voiceModel, localModelReady: false });
  }
  enabled.checked = saved.enabled;
  apiKey.value = saved.apiKey;
  targetLanguage.value = saved.targetLanguage;
  hoverDelay.value = String(saved.hoverDelay);
  voiceModel.value = saved.voiceModel;
  voiceMode.value = saved.voiceMode;
  subtitleSize.value = String(saved.subtitleSize);
  subtitleOpacity.value = String(saved.subtitleOpacity);
  voiceDiagnostics.checked = saved.voiceDiagnostics;
  if (catalogApiUrlInput) {
    catalogApiUrlInput.value = normalizeCatalogApiUrl(saved.modelCatalogApiUrl || MODEL_CATALOG_API_URL) || MODEL_CATALOG_API_URL;
  }
}

function selectedModelProfile() {
  return MODEL_PROFILES[voiceModel?.value] || null;
}

async function setModelInstallState(state, details = {}) {
  try {
    const values = {
      localModelInstallState: state,
      localModelError: state === "error" ? String(details.error || "") : "",
    };
    if (Number.isFinite(details.progress)) values.localModelProgress = Math.max(0, Math.min(100, details.progress));
    await chrome.storage.local.set(values);
  } catch {
  }
}

downloadModelButton?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (!window.showDirectoryPicker) return showStatus("当前 Chrome 不支持选择本地模型目录，请升级 Chrome 后重试", true);
  const profile = selectedModelProfile();
  if (!profile) return showStatus("未找到所选模型，请先刷新模型目录", true);
  button.disabled = true;
  try {
    const directory = await window.showDirectoryPicker({ mode: "readwrite", id: "tcat-whisper-model" });
    await saveModelDirectory(directory);
    await chrome.storage.local.set({ localModelReady: false, localModelProfile: voiceModel.value, localModelName: profile.name });
    await setModelInstallState("downloading", { progress: 0 });
    modelProgress.hidden = false;
    progressBar.style.width = "0%";
    let completed = 0;
    for (const path of profile.files) {
      progressText.textContent = `正在下载 ${path}（${completed + 1}/${profile.files.length}）`;
      await downloadFileToDirectory(directory, profile.repo, path, (bytes) => {
        progressText.textContent = `正在下载 ${path} · ${(bytes / 1024 / 1024).toFixed(1)} MB`;
      }, profile.revision, profile.fileMeta?.[path]);
      completed += 1;
      const progress = Math.round(completed / profile.files.length * 100);
      progressBar.style.width = `${progress}%`;
      await setModelInstallState("downloading", { progress });
    }
    const validation = await validateModelInstallation(directory, profile);
    if (validation.missing.length || validation.invalid.length) {
      const problem = validation.missing[0] || validation.invalid[0];
      throw new Error(`下载后校验失败：${problem}`);
    }
    await chrome.storage.local.set({ localModelReady: true, localModelName: profile.name, localModelProfile: voiceModel.value, voiceModel: voiceModel.value });
    await setModelInstallState("ready", { progress: 100 });
    showStatus("本地模型下载完成");
    await refreshModelStatus();
  } catch (error) {
    if (error.name !== "AbortError") {
      await chrome.storage.local.set({ localModelReady: false });
      await setModelInstallState("error", { error: error?.message || error });
      showStatus(`模型下载失败：${error?.message || error}`, true);
      setModelBadge("下载失败", false);
    }
  } finally {
    button.disabled = false;
  }
});

selectModelButton?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (!window.showDirectoryPicker) return showStatus("当前 Chrome 不支持选择本地模型目录，请升级 Chrome 后重试", true);
  const profile = selectedModelProfile();
  if (!profile) return showStatus("未找到所选模型，请先刷新模型目录", true);
  button.disabled = true;
  try {
    const directory = await window.showDirectoryPicker({ mode: "read", id: "tcat-whisper-model" });
    const validation = await validateModelInstallation(directory, profile);
    if (validation.missing.length) throw new Error(`缺少文件：${validation.missing[0]}`);
    if (validation.invalid.length) throw new Error(`文件校验失败：${validation.invalid[0]}`);
    await saveModelDirectory(directory);
    await chrome.storage.local.set({ localModelReady: true, localModelName: profile.name, localModelProfile: voiceModel.value, voiceModel: voiceModel.value });
    await setModelInstallState("ready", { progress: 100 });
    showStatus("模型文件夹验证成功");
    await refreshModelStatus();
  } catch (error) {
    if (error.name !== "AbortError") {
      await chrome.storage.local.set({ localModelReady: false });
      await setModelInstallState("error", { error: error?.message || error });
      showStatus(`无法使用该文件夹：${error?.message || error}`, true);
      setModelBadge("校验失败", false);
    }
  } finally {
    button.disabled = false;
  }
});

voiceModel.addEventListener("change", async () => {
  const saved = await chrome.storage.local.get({ localModelProfile: "", localModelReady: false });
  if (saved.localModelProfile !== voiceModel.value) {
    await chrome.storage.local.set({ localModelReady: false, localModelInstallState: "unconfigured" });
  }
  await refreshModelStatus();
});

async function refreshModelStatus() {
  try {
    const directory = await getModelDirectory();
    if (!directory) return setModelBadge("未配置", false);
    const permission = await directory.queryPermission({ mode: "read" });
    if (permission === "prompt") return setModelBadge("需要重新授权", false);
    if (permission !== "granted") return setModelBadge("目录权限被拒绝", false);
    const saved = await chrome.storage.local.get({ voiceModel: voiceModel?.value || "distil-small-webgpu", localModelReady: false, localModelProfile: "" });
    const profile = selectedModelProfile() || MODEL_PROFILES[saved.voiceModel] || MODEL_PROFILES["distil-small-webgpu"];
    if (!profile) return setModelBadge("未找到模型", false);
    const validation = await validateModelInstallation(directory, profile);
    if (validation.missing.length) {
      setModelBadge("文件不完整", false);
      return;
    }
    if (validation.invalid.length) {
      setModelBadge("校验失败", false);
      return;
    }
    setModelBadge(saved.localModelReady && saved.localModelProfile === (voiceModel?.value || saved.voiceModel) ? "模型可用" : "已安装待确认", true);
  } catch (error) {
    setModelBadge("需要重新选择", false);
  }
}

function setModelBadge(text, ready) {
  modelBadge.textContent = text;
  modelBadge.classList.toggle("ready", ready);
}

async function downloadFileToDirectory(root, repo, path, onProgress = () => {}, revision = "main", expectedSize = null) {
  if (!root || !isSafeRepo(repo) || !isSafeRevision(revision) || !isSafeModelPath(path)) {
    throw new Error(`${path || "模型文件"} 下载路径校验失败`);
  }
  if (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize <= 0)) {
    throw new Error(`${path} 文件大小校验信息无效`);
  }
  const url = buildModelFileUrl(repo, revision, path);
  const response = await fetch(url, { cache: "no-store" });
  if (!response?.ok || !response.body || typeof response.body.getReader !== "function") {
    throw new Error(`${path} 下载失败（HTTP ${response?.status || 0}，响应内容不完整）`);
  }
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isSafeInteger(contentLength) && contentLength > 0 && expectedSize && contentLength !== expectedSize) {
    throw new Error(`${path} 下载校验失败（大小 ${contentLength}，预期 ${expectedSize}）`);
  }
  const parts = path.split("/");
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
  const handle = await directory.getFileHandle(parts.at(-1), { create: true });
  const writable = await handle.createWritable();
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || typeof value.byteLength !== "number") throw new Error(`${path} 下载响应包含无效数据`);
      await writable.write(value);
      received += value.byteLength;
      onProgress(received);
    }
    if (!received || (expectedSize && received !== expectedSize)) {
      throw new Error(`${path} 下载校验失败（大小 ${received}，预期 ${expectedSize || "大于 0"}）`);
    }
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

async function findMissingModelFiles(root, files = MODEL_PROFILES[voiceModel.value].files) {
  const missing = [];
  for (const path of files) {
    try {
      const file = await getFileByPath(root, path);
      if (typeof file?.size === "number" && file.size <= 0) missing.push(path);
    } catch { missing.push(path); }
  }
  return missing;
}

async function validateModelInstallation(root, profile = selectedModelProfile()) {
  const result = { missing: [], invalid: [] };
  if (!profile || !isSafeModelFiles(profile.files)) {
    result.invalid.push("模型配置");
    return result;
  }
  for (const path of profile.files) {
    try {
      const file = await getFileByPath(root, path);
      if (typeof file?.size === "number" && file.size <= 0) {
        result.invalid.push(path);
      } else if (Number.isSafeInteger(profile.fileMeta?.[path]) && file.size !== profile.fileMeta[path]) {
        result.invalid.push(path);
      }
    } catch {
      result.missing.push(path);
    }
  }
  return result;
}

async function getFileByPath(root, path) {
  if (!root || !isSafeModelPath(path)) throw new Error("模型文件路径校验失败");
  const parts = path.split("/");
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
  return (await directory.getFileHandle(parts.at(-1))).getFile();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveSettings();
  showStatus("设置已保存");
});

document.querySelector("#toggle-key").addEventListener("click", (event) => {
  const reveal = apiKey.type === "password";
  apiKey.type = reveal ? "text" : "password";
  event.currentTarget.textContent = reveal ? "隐藏" : "显示";
});

document.querySelector("#test-api").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  showStatus("正在连接 DeepSeek…");
  try {
    await saveSettings();
    const response = await chrome.runtime.sendMessage({
      type: "TRANSLATE",
      text: "Hello, welcome to the stream!",
      targetLanguage: targetLanguage.value,
    });
    if (!response?.ok) throw new Error(response?.error || "测试失败");
    showStatus(`连接成功：${response.translation}`);
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
});

async function saveSettings() {
  const modelState = await chrome.storage.local.get({ localModelProfile: "", localModelReady: false });
  const catalogUrl = catalogApiUrlInput?.value?.trim() || MODEL_CATALOG_API_URL;
  await chrome.storage.local.set({
    enabled: enabled.checked,
    apiKey: apiKey.value.trim(),
    targetLanguage: targetLanguage.value,
    hoverDelay: Number(hoverDelay.value),
    voiceModel: voiceModel.value,
    voiceMode: voiceMode.value,
    subtitleSize: Number(subtitleSize.value),
    subtitleOpacity: Number(subtitleOpacity.value),
    voiceDiagnostics: voiceDiagnostics.checked,
    modelCatalogApiUrl: catalogUrl,
    localModelReady: modelState.localModelReady === true && modelState.localModelProfile === voiceModel.value,
  });
}

let statusTimer;
function showStatus(message, isError = false) {
  clearTimeout(statusTimer);
  status.textContent = message;
  status.classList.toggle("error", isError);
  statusTimer = setTimeout(() => { status.textContent = ""; }, 6000);
}
