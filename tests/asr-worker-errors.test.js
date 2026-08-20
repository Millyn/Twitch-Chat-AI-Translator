const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const workerSource = fs.readFileSync(
  path.join(__dirname, "..", "assets", "asr-worker.js"),
  "utf8"
);
const workerTail = workerSource.slice(workerSource.lastIndexOf("// src/asr-worker.js"));

function createIndexedDb(directoryHandle) {
  return {
    open() {
      const request = { result: null };
      queueMicrotask(() => {
        request.result = {
          createObjectStore() {},
          transaction() {
            return {
              objectStore() {
                return {
                  get() {
                    const valueRequest = { result: directoryHandle };
                    queueMicrotask(() => valueRequest.onsuccess?.());
                    return valueRequest;
                  }
                };
              }
            };
          }
        };
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  };
}

async function runModelLoad({ model = "distil-small-webgpu", pipelineImpl } = {}) {
  const messages = [];
  const logs = [];
  const pipelineCalls = [];
  const cause = new Error("WebGPU provider was not initialized");
  cause.name = "ProviderInitError";
  const injectedError = new Error("pipeline initialization failed", { cause });
  injectedError.name = "ORTExecutionError";
  injectedError.stack = "ORTExecutionError: pipeline initialization failed\n    at injectedPipeline (test:1:1)";
  const directoryHandle = {
    async queryPermission() {
      return "granted";
    }
  };
  const worker = {
    location: { href: "chrome-extension://test/assets/asr-worker.js" },
    postMessage(message) {
      messages.push(message);
    }
  };
  const pipeline = pipelineImpl || (async () => {
    throw injectedError;
  });
  const context = {
    self: worker,
    navigator: model === "tiny-fp32" ? {} : { gpu: { requestAdapter: async () => ({}) } },
    crossOriginIsolated: true,
    indexedDB: createIndexedDb(directoryHandle),
    Headers,
    Response,
    URL,
    performance: { now: () => 0 },
    fetch: async () => {
      throw new Error("unexpected network access");
    },
    console: {
      error(...args) {
        logs.push(args);
      }
    },
    __webpack_exports__env: {
      allowRemoteModels: true,
      allowLocalModels: false,
      useBrowserCache: true,
      localModelPath: "",
      backends: { onnx: { wasm: {} } }
    },
    __webpack_exports__pipeline: async (...args) => {
      pipelineCalls.push(args);
      return pipeline(...args);
    }
  };

  vm.runInNewContext(workerTail, context, { filename: "assets/asr-worker.js" });
  worker.onmessage({
    data: {
      type: "LOAD_MODEL",
      wasmBase: "chrome-extension://test/assets/",
      model,
      tabId: 42,
      sessionId: "session-1"
    }
  });
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  return { context, injectedError, logs, messages, pipelineCalls };
}

async function runInjectedModelLoadFailure() {
  return runModelLoad();
}

test("model-load ERROR preserves the original ORT failure and runtime diagnostics", async () => {
  const { context, injectedError, logs, messages } = await runInjectedModelLoadFailure();
  assert.equal(messages.length, 1);
  const payload = messages[0];
  assert.equal(payload.type, "ERROR");
  assert.equal(payload.error, "pipeline initialization failed");
  assert.equal(payload.diagnostic.name, injectedError.name);
  assert.equal(payload.diagnostic.message, injectedError.message);
  assert.equal(payload.diagnostic.stack, injectedError.stack);
  assert.deepEqual(toPlainJson(payload.diagnostic.cause), {
    name: "ProviderInitError",
    message: "WebGPU provider was not initialized",
    stack: causeStack(injectedError.cause)
  });
  assert.equal(payload.diagnostic.operation, "model-load");
  assert.equal(payload.diagnostic.selectedModel, "distil-small-webgpu");
  assert.equal(payload.diagnostic.intendedBackend, "webgpu");
  assert.deepEqual(toPlainJson(payload.diagnostic.worker), {
    context: "dedicated-module-worker",
    location: "chrome-extension://test/assets/asr-worker.js",
    hasGPU: true,
    crossOriginIsolated: true
  });
  assert.deepEqual(toPlainJson(payload.diagnostic.wasmPaths), {
    mjs: "chrome-extension://test/assets/ort-wasm-simd-threaded.jsep.mjs",
    wasm: "chrome-extension://test/assets/ort-wasm-simd-threaded.jsep.wasm"
  });
  assert.equal(context.__webpack_exports__env.allowRemoteModels, false);
  assert.equal(context.__webpack_exports__env.allowLocalModels, true);
  assert.equal(context.__webpack_exports__env.useBrowserCache, false);
  assert.equal(context.__webpack_exports__env.localModelPath, "local-models/");
  assert.equal(context.__webpack_exports__env.logLevel, "error");
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0][1], payload.diagnostic);
});

test("Tiny CPU model uses the non-JSEP WASM assets and local-only pipeline", async () => {
  const { context, messages, pipelineCalls } = await runModelLoad({
    model: "tiny-fp32",
    pipelineImpl: async () => async () => ({ text: "" }),
  });

  assert.deepEqual(toPlainJson(messages), [{ type: "READY", backend: "CPU/WASM" }]);
  assert.deepEqual(toPlainJson(pipelineCalls[0]), [
    "automatic-speech-recognition",
    "local/whisper-model",
    { device: "wasm", dtype: "fp32" },
  ]);
  assert.deepEqual(toPlainJson(context.__webpack_exports__env.backends.onnx.wasm.wasmPaths), {
    mjs: "chrome-extension://test/assets/ort-wasm-simd-threaded.mjs",
    wasm: "chrome-extension://test/assets/ort-wasm-simd-threaded.wasm",
  });
  assert.equal(context.__webpack_exports__env.allowRemoteModels, false);
  assert.equal(context.__webpack_exports__env.allowLocalModels, true);
  assert.equal(context.__webpack_exports__env.useBrowserCache, false);
  assert.equal(context.__webpack_exports__env.logLevel, "error");
});

function causeStack(error) {
  return error.stack;
}

function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value));
}
