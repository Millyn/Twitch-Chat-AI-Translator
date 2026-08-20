import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const OFFSCREEN_SOURCE = readFileSync(new URL("../offscreen.js", import.meta.url), "utf8");
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 4096;

function createHarness(sampleRate = SAMPLE_RATE) {
  const workers = [];
  const sentMessages = [];
  const timers = new Map();
  const runtimeListeners = [];
  let nextTimerId = 1;
  let clock = 0;

  class FakeWorker {
    constructor() {
      this.posts = [];
      this.terminated = false;
      workers.push(this);
    }

    postMessage(message, transfer) {
      this.posts.push({ message, transfer });
    }

    terminate() {
      this.terminated = true;
    }
  }

  class FakeAudioContext {
    constructor() {
      this.sampleRate = sampleRate;
      this.state = "running";
      this.destination = {};
    }

    resume() {
      this.state = "running";
      return Promise.resolve();
    }

    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }

    createScriptProcessor() {
      return { connect() {}, disconnect() {}, onaudioprocess: null };
    }

    close() {
      this.state = "closed";
      return Promise.resolve();
    }
  }

  const context = vm.createContext({
    AudioContext: FakeAudioContext,
    Date,
    Float32Array,
    Map,
    Math,
    Number,
    Promise,
    Worker: FakeWorker,
    console,
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          const tracks = [{ onended: null, stop() {} }];
          return { getTracks: () => tracks };
        },
      },
    },
    performance: { now: () => ++clock },
    setInterval: () => 0,
    setTimeout: (callback, delay) => {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    chrome: {
      runtime: {
        getURL: (path) => path,
        onMessage: { addListener: (listener) => runtimeListeners.push(listener) },
        sendMessage: (message) => {
          sentMessages.push(message);
          return Promise.resolve();
        },
      },
    },
  });

  new vm.Script(OFFSCREEN_SOURCE, { filename: "offscreen.js" }).runInContext(context);

  return {
    context,
    workers,
    sentMessages,
    runtimeListeners,
    start: async (options) => vm.runInContext(`startCapture(${JSON.stringify(options)})`, context),
    session: (tabId) => vm.runInContext(`sessions.get(${tabId})`, context),
    setModelReady: () => vm.runInContext('modelState = "ready"; pumpQueue();', context),
    finalize: (tabId) => vm.runInContext(`finalizeSegment(sessions.get(${tabId}), ${SAMPLE_RATE})`, context),
    result: (tabId, sessionId, text = "recognized speech") => {
      const worker = workers.at(-1);
      worker.onmessage({ data: { type: "RESULT", tabId, sessionId, text, asrMs: 0 } });
    },
    stop: (tabId, sessionId) => vm.runInContext(`stopCapture(${tabId}, ${JSON.stringify(sessionId)})`, context),
    endTrack: (tabId) => {
      const session = vm.runInContext(`sessions.get(${tabId})`, context);
      return session.mediaStream.getTracks()[0].onended?.();
    },
    transcribePosts: () => workers.at(-1).posts.filter(({ message }) => message.type === "TRANSCRIBE"),
    feed: (tabId, amplitude, frames = 1) => {
      const session = vm.runInContext(`sessions.get(${tabId})`, context);
      const callback = session.processor.onaudioprocess;
      for (let index = 0; index < frames; index += 1) {
        const data = new Float32Array(FRAME_SAMPLES).fill(amplitude);
        callback({ inputBuffer: { getChannelData: () => data } });
      }
    },
    feedSamples: (tabId, samples) => {
      const session = vm.runInContext(`sessions.get(${tabId})`, context);
      session.processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
    },
  };
}

async function startSingleSession(harness, tabId = 1, sessionId = "session-1") {
  await harness.start({
    streamId: `stream-${tabId}`,
    tabId,
    sessionId,
    voiceSettings: { voiceMode: "fast" },
  });
  harness.setModelReady();
}

test("low-amplitude speech at peak 0.009 forms a segment", async () => {
  const harness = createHarness();
  await startSingleSession(harness);

  harness.feed(1, 0.009, 10);
  harness.feed(1, 0, 3);

  assert.equal(harness.transcribePosts().length, 1, "0.009-peak speech must reach ASR");
});

test("low-amplitude voice-like audio below the former 0.006 peak threshold forms a segment after steady noise", async () => {
  const harness = createHarness();
  await startSingleSession(harness);

  harness.feed(1, 0.002, 20);
  assert.ok(harness.session(1).noiseFloor <= 0.0016, "steady noise must not raise the VAD floor without bound");
  for (let frame = 0; frame < 10; frame += 1) {
    const offset = frame * FRAME_SAMPLES;
    const voice = Float32Array.from({ length: FRAME_SAMPLES }, (_, index) => {
      const sample = offset + index;
      return 0.005 * (0.7 * Math.sin(sample * 0.028) + 0.3 * Math.sin(sample * 0.071));
    });
    harness.feedSamples(1, voice);
  }
  harness.feed(1, 0, 3);

  assert.equal(harness.transcribePosts().length, 1, "sub-0.006 voice must reach ASR after continuous background noise");
});

test("48 kHz tab audio below the former 0.006 peak threshold reaches ASR after steady noise", async () => {
  const tabSampleRate = 48000;
  const harness = createHarness(tabSampleRate);
  await startSingleSession(harness);

  harness.feed(1, 0.002, 20);
  for (let frame = 0; frame < Math.ceil(tabSampleRate * 2.3 / FRAME_SAMPLES); frame += 1) {
    const offset = frame * FRAME_SAMPLES;
    const voice = Float32Array.from({ length: FRAME_SAMPLES }, (_, index) => {
      const sample = offset + index;
      return 0.005 * (0.7 * Math.sin(sample * 0.028) + 0.3 * Math.sin(sample * 0.071));
    });
    harness.feedSamples(1, voice);
  }
  harness.feed(1, 0, Math.ceil(tabSampleRate * 0.45 / FRAME_SAMPLES));

  const [transcription] = harness.transcribePosts();
  assert.ok(transcription, "48 kHz sub-0.006 voice must reach ASR after continuous background noise");
  assert.ok(transcription.message.audio.length >= 16000 * 2.2, "48 kHz segment must be resampled for Whisper");
});

test("silence does not form a voice segment", async () => {
  const harness = createHarness();
  await startSingleSession(harness);

  harness.feed(1, 0, 20);

  assert.equal(harness.session(1).speechActive, false);
  assert.equal(harness.transcribePosts().length, 0, "silence must not reach ASR");
});

test("speech onset retains the pre-roll instead of clipping the first frames", async () => {
  const harness = createHarness();
  await startSingleSession(harness);
  const session = harness.session(1);

  harness.feed(1, 0, 2);
  harness.feed(1, 0.009, 2);

  assert.equal(session.speechActive, true);
  assert.ok(session.segmentSamples > FRAME_SAMPLES * 2, "the segment should include audio before VAD activation");
  assert.equal(session.segmentParts[0][0], 0, "pre-roll should contain the samples immediately before speech");
});

test("high-amplitude speech still forms a segment", async () => {
  const harness = createHarness();
  await startSingleSession(harness);

  harness.feed(1, 0.02, 10);
  harness.feed(1, 0, 3);

  assert.equal(harness.transcribePosts().length, 1, "high-amplitude speech must remain accepted");
});

test("rapid finalized 1s, 2s, and 3s segments dispatch exactly once in FIFO order", async () => {
  const harness = createHarness();
  await startSingleSession(harness);
  const session = harness.session(1);

  for (const audioMs of [1000, 2000, 3000]) {
    const samples = Math.round(SAMPLE_RATE * audioMs / 1000);
    session.segmentParts = [new Float32Array(samples).fill(audioMs / 100000)];
    session.segmentSamples = samples;
    harness.finalize(1);
  }

  assert.deepEqual(
    harness.transcribePosts().map(({ message }) => message.audio.length),
    [16000],
    "only the first segment may be active before its result is released",
  );

  harness.result(1, "session-1", "one-second");
  harness.result(1, "session-1", "two-seconds");
  harness.result(1, "session-1", "three-seconds");

  assert.deepEqual(
    harness.transcribePosts().map(({ message }) => Math.round(message.audio.length * 1000 / SAMPLE_RATE)),
    [1000, 2000, 3000],
    "all finalized segments must dispatch once and preserve FIFO order",
  );
});

test("bounded per-session queue keeps the newest finalized speech", async () => {
  const harness = createHarness();
  await startSingleSession(harness);
  const session = harness.session(1);

  for (const audioMs of [1000, 2000, 3000, 4000, 5000, 6000]) {
    const samples = Math.round(SAMPLE_RATE * audioMs / 1000);
    session.segmentParts = [new Float32Array(samples).fill(audioMs / 100000)];
    session.segmentSamples = samples;
    harness.finalize(1);
  }

  assert.ok(session.pendingAudioQueue.length <= 4, "queue must have a fixed upper bound");
  assert.deepEqual(
    Array.from(session.pendingAudioQueue, ({ audioMs }) => audioMs),
    [3000, 4000, 5000, 6000],
    "overflow must discard the oldest queued segment and retain newest speech",
  );
});

test("round-robin dispatch still alternates sessions with independent FIFO queues", async () => {
  const harness = createHarness();
  await startSingleSession(harness, 1, "session-1");
  await harness.start({ streamId: "stream-2", tabId: 2, sessionId: "session-2", voiceSettings: { voiceMode: "fast" } });

  for (const tabId of [1, 2, 1, 2]) {
    const session = harness.session(tabId);
    const samples = SAMPLE_RATE;
    session.segmentParts = [new Float32Array(samples).fill(tabId / 100)];
    session.segmentSamples = samples;
    harness.finalize(tabId);
  }

  for (const tabId of [1, 2, 1, 2]) {
    harness.result(tabId, `session-${tabId}`, `tab-${tabId}`);
  }

  assert.deepEqual(
    harness.transcribePosts().map(({ message }) => message.tabId),
    [1, 2, 1, 2],
    "sessions must alternate while each session remains FIFO",
  );
});

test("stopCapture clears queued speech for that session", async () => {
  const harness = createHarness();
  await startSingleSession(harness);
  const session = harness.session(1);

  for (const audioMs of [1000, 2000]) {
    const samples = Math.round(SAMPLE_RATE * audioMs / 1000);
    session.segmentParts = [new Float32Array(samples).fill(0.01)];
    session.segmentSamples = samples;
    harness.finalize(1);
  }

  await harness.stop(1, "session-1");
  assert.equal(session.pendingAudioQueue.length, 0, "stopping a session must release queued audio");
});

test("track end flushes the active speech segment before releasing the session", async () => {
  const harness = createHarness();
  await startSingleSession(harness);

  // Four frames leave the segment active but below the normal pause/max cutoff.
  harness.feed(1, 0.02, 4);
  const draining = harness.endTrack(1);

  assert.equal(harness.transcribePosts().length, 1, "track end must dispatch the in-progress speech");
  assert.ok(harness.transcribePosts()[0].message.audio.length > 0, "flushed audio must not be empty");
  assert.ok(harness.session(1), "session must remain until the flushed result is acknowledged");

  harness.result(1, "session-1", "tail speech");
  await draining;
  assert.equal(harness.session(1), undefined, "session is released after the flushed result");
  assert.ok(harness.sentMessages.some((message) => message.type === "ASR_TEXT" && message.text === "tail speech"));
  assert.ok(harness.sentMessages.some((message) => message.type === "VOICE_STATUS" && message.status === "stopped"));
});
