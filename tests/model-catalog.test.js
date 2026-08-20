const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const OPTIONS_SOURCE = fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf8");
const SUPPORTED_REPO = "onnx-community/whisper-tiny.en";
const VALID_SHA = "a".repeat(40);
const DYNAMIC_REPO = "onnx-community/whisper-medium.en";
const DYNAMIC_SHA = "c".repeat(40);

function createElement(id) {
  return {
    id,
    value: "",
    checked: false,
    textContent: "",
    disabled: false,
    hidden: false,
    style: { width: "" },
    classList: { toggle() {} },
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
  };
}

function loadOptions() {
  const elements = new Map();
  const document = {
    querySelector(selector) {
      const id = selector.replace(/^#/, "");
      if (!elements.has(id)) elements.set(id, createElement(id));
      return elements.get(id);
    },
  };
  const storageState = {};
  const storage = {
    async get(defaults) { return { ...defaults, ...storageState }; },
    async set(values) { Object.assign(storageState, values); },
  };
  const context = {
    __TCAT_MODEL_CATALOG_TEST__: true,
    clearTimeout,
    console,
    chrome: { storage: { local: storage }, runtime: { sendMessage: async () => ({ ok: true }) } },
    document,
    fetch: async () => { throw new Error("unexpected fetch"); },
    URL,
    setTimeout,
    window: {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(OPTIONS_SOURCE, context, { filename: "options.js" });
  context.__TCAT_MODEL_CATALOG__.__elements = elements;
  context.__TCAT_MODEL_CATALOG__.__storageState = storageState;
  context.__TCAT_MODEL_CATALOG__.__setStorage = (values) => Object.assign(storageState, values);
  return context.__TCAT_MODEL_CATALOG__;
}

function validApiModel(overrides = {}) {
  return {
    id: SUPPORTED_REPO,
    author: "onnx-community",
    tags: ["onnx", "automatic-speech-recognition"],
    private: false,
    gated: false,
    disabled: false,
    sha: VALID_SHA,
    ...overrides,
  };
}

function validDynamicApiModel(overrides = {}) {
  return {
    id: DYNAMIC_REPO,
    author: "onnx-community",
    tags: ["onnx", "automatic-speech-recognition"],
    private: false,
    gated: false,
    disabled: false,
    sha: DYNAMIC_SHA,
    siblings: [
      "config.json",
      "generation_config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "preprocessor_config.json",
      { rfilename: "onnx/encoder_model.onnx", size: 1000 },
      { rfilename: "onnx/decoder_model_merged_q4.onnx", size: 2000 },
    ],
    ...overrides,
  };
}

test("API success refreshes only the curated profile and pins its returned SHA", async () => {
  const hooks = loadOptions();
  assert.ok(hooks, "options.js should expose the model catalog test seam");

  const observed = [];
  const result = await hooks.refreshModelCatalog({
    fetchImpl: async (url) => {
      observed.push(url);
      return { ok: true, json: async () => [validApiModel()] };
    },
    storageArea: { get: async () => ({}), set: async () => {} },
  });

  assert.equal(observed[0], hooks.MODEL_CATALOG_API_URL);
  assert.equal(result.source, "api");
  assert.equal(result.profiles["tiny-fp32"].revision, VALID_SHA);
  assert.deepEqual(Object.keys(result.profiles).sort(), ["base-webgpu", "distil-small-webgpu", "tiny-fp32"]);
});

test("default catalog URL queries the official ONNX Community owner without narrowing to whisper names", () => {
  const hooks = loadOptions();
  const url = new URL(hooks.MODEL_CATALOG_API_URL);
  assert.equal(url.hostname, "huggingface.co");
  assert.equal(url.pathname, "/api/models");
  assert.equal(url.searchParams.get("author"), "onnx-community");
  assert.equal(url.searchParams.get("search"), null);
  assert.equal(url.searchParams.get("filter"), "onnx");
  assert.equal(url.searchParams.get("pipeline_tag"), "automatic-speech-recognition");
  assert.equal(Number(url.searchParams.get("limit")), 100);
  assert.ok(url.searchParams.getAll("expand[]").includes("pipeline_tag"));
});

test("legacy owner/search catalog URLs are migrated to the broad official owner query", async () => {
  const hooks = loadOptions();
  const legacyUrl = "https://huggingface.co/api/models?author=onnx-community&search=whisper&filter=onnx&pipeline_tag=automatic-speech-recognition&limit=50";
  assert.equal(hooks.normalizeCatalogApiUrl(legacyUrl), hooks.MODEL_CATALOG_API_URL);

  const observed = [];
  const result = await hooks.refreshModelCatalog({
    apiUrl: legacyUrl,
    fetchImpl: async (url) => {
      observed.push(url);
      return { ok: true, json: async () => [validApiModel()] };
    },
    storageArea: { get: async () => ({}), set: async () => {} },
  });
  assert.equal(observed[0], hooks.MODEL_CATALOG_API_URL);
  assert.equal(result.source, "api");
});

test("API sibling manifest exposes a safe dynamic Whisper profile", () => {
  const hooks = loadOptions();
  const entries = hooks.parseCatalogEntries([validDynamicApiModel()]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, "hf-whisper-medium-en");
  assert.equal(entries[0].profile.repo, DYNAMIC_REPO);
  assert.equal(entries[0].profile.revision, DYNAMIC_SHA);
  assert.equal(entries[0].profile.catalog, true);
  assert.equal(entries[0].profile.backend, "webgpu");
  assert.ok(entries[0].profile.files.includes("onnx/decoder_model_merged_q4.onnx"));

  const profiles = hooks.mergeCatalogProfiles([validDynamicApiModel()]);
  assert.equal(profiles["hf-whisper-medium-en"].repo, DYNAMIC_REPO);
  assert.equal(profiles["hf-whisper-medium-en"].revision, DYNAMIC_SHA);
});

test("catalog API URL stays within the existing Hugging Face host permissions", () => {
  const hooks = loadOptions();
  assert.equal(hooks.isSafeCatalogApiUrl("https://huggingface.co/api/models"), true);
  assert.equal(hooks.isSafeCatalogApiUrl("https://api.huggingface.co/api/models"), true);
  assert.equal(hooks.isSafeCatalogApiUrl("https://hf.co/api/models"), true);
  assert.equal(hooks.isSafeCatalogApiUrl("https://mirror.example.com/api/models"), false);
  assert.equal(hooks.isSafeCatalogApiUrl("http://huggingface.co/api/models"), false);
  assert.equal(hooks.isSafeCatalogApiUrl("https://huggingface.co.attacker.example/api/models"), false);
});

test("offline refresh keeps a previously cached safe revision", async () => {
  const hooks = loadOptions();
  const cachedRevision = "b".repeat(40);
  const result = await hooks.refreshModelCatalog({
    fetchImpl: async () => { throw new Error("offline"); },
    storageArea: {
      get: async () => ({
        modelCatalog: {
          "tiny-fp32": {
            revision: cachedRevision,
            metadata: { downloads: 1234, pipelineTag: "automatic-speech-recognition" },
          },
          "base-webgpu": { revision: "not-a-revision" },
        },
      }),
      set: async () => {},
    },
  });

  assert.equal(result.source, "fallback");
  assert.equal(result.profiles["tiny-fp32"].revision, cachedRevision);
  assert.equal(result.profiles["tiny-fp32"].metadata.downloads, 1234);
  assert.equal(result.profiles["base-webgpu"].revision, "main");
  assert.equal(result.profiles["distil-small-webgpu"].revision, "main");
});

test("malicious or unsupported API entries never add profiles or alter the built-ins", () => {
  const hooks = loadOptions();
  const profiles = hooks.mergeCatalogProfiles([
    validApiModel({ id: "attacker/unknown-model" }),
    validApiModel({ author: "attacker" }),
    validApiModel({ tags: ["onnx"] }),
    validApiModel({ private: true }),
    validApiModel({ gated: true }),
    validApiModel({ disabled: true }),
    validApiModel({ sha: "../../evil" }),
  ]);

  assert.deepEqual(Object.keys(profiles).sort(), ["base-webgpu", "distil-small-webgpu", "tiny-fp32"]);
  assert.equal(profiles["tiny-fp32"].revision, "main");
});

test("model file URLs encode path segments and use the pinned revision", () => {
  const hooks = loadOptions();
  const url = hooks.buildModelFileUrl(SUPPORTED_REPO, VALID_SHA, "onnx/decoder model.onnx");

  assert.equal(
    url,
    `https://huggingface.co/onnx-community/whisper-tiny.en/resolve/${VALID_SHA}/onnx/decoder%20model.onnx?download=true`,
  );
  assert.throws(() => hooks.buildModelFileUrl(SUPPORTED_REPO, VALID_SHA, "../escape.onnx"), /unsafe model path/i);
});

test("changing the selected model invalidates a ready local model from another profile", async () => {
  const hooks = loadOptions();
  // loadSettings() runs during script evaluation; let it settle before this
  // test changes the same select element, otherwise startup can win the race.
  await new Promise((resolve) => setImmediate(resolve));
  hooks.__setStorage({ localModelProfile: "distil-small-webgpu", localModelReady: true });
  const voiceModel = hooks.__elements.get("voice-model");
  voiceModel.value = "base-webgpu";

  await voiceModel.listeners.change();

  assert.equal(hooks.__storageState.localModelReady, false);
});

test("network failure keeps all three built-ins usable through the fallback", async () => {
  const hooks = loadOptions();
  const responses = [
    async () => { throw new Error("offline"); },
    async () => ({ ok: false, status: 429, json: async () => ({}) }),
    async () => ({ ok: true, status: 200, json: async () => ({ malformed: true }) }),
  ];

  for (const fetchImpl of responses) {
    const result = await hooks.refreshModelCatalog({
      fetchImpl,
      storageArea: { get: async () => ({}), set: async () => {} },
    });
    assert.equal(result.source, "fallback");
    assert.deepEqual(Object.keys(result.profiles).sort(), ["base-webgpu", "distil-small-webgpu", "tiny-fp32"]);
    assert.equal(result.profiles["distil-small-webgpu"].revision, "main");
  }
});

test("refresh UI surfaces a diagnostic failure while retaining the offline fallback", async () => {
  const hooks = loadOptions();
  await new Promise((resolve) => setImmediate(resolve));
  hooks.__elements.get("model-catalog-api-url").value = "https://mirror.example.com/api/models";

  await hooks.__elements.get("refresh-model-catalog").listeners.click();

  const message = hooks.__elements.get("model-catalog-status").textContent;
  assert.match(message, /刷新失败：模型目录 API 地址必须使用 Hugging Face 官方域名/);
  assert.match(message, /继续使用已缓存\/内置模型/);
});

function modelDirectoryFromFiles(files) {
  const root = { directories: new Map(), files: new Map() };
  for (const [pathName, size] of Object.entries(files)) {
    const parts = pathName.split("/");
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      if (!directory.directories.has(part)) directory.directories.set(part, { directories: new Map(), files: new Map() });
      directory = directory.directories.get(part);
    }
    directory.files.set(parts.at(-1), { size });
  }
  function expose(directory) {
    return {
      async getDirectoryHandle(name) {
        const child = directory.directories.get(name);
        if (!child) throw new Error("missing directory");
        return expose(child);
      },
      async getFileHandle(name) {
        const file = directory.files.get(name);
        if (!file) throw new Error("missing file");
        return { async getFile() { return file; } };
      },
    };
  }
  return expose(root);
}

test("installation validation reports missing and size-mismatched files", async () => {
  const hooks = loadOptions();
  const profile = hooks.parseCatalogEntries([validDynamicApiModel()])[0].profile;
  const files = Object.fromEntries(profile.files.map((pathName) => [pathName, profile.fileMeta[pathName] || 100]));
  files["onnx/decoder_model_merged_q4.onnx"] -= 1;
  const result = await hooks.validateModelInstallation(modelDirectoryFromFiles(files), profile);
  assert.deepEqual(Array.from(result.missing), []);
  assert.deepEqual(Array.from(result.invalid), ["onnx/decoder_model_merged_q4.onnx"]);
});
