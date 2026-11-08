import { ref, shallowRef } from "vue";
import AudioWorker from "./audio.worker?worker";
import { FRAME_SIZE, type Analysis, type WorkerRequest, type WorkerResponse } from "./tuning";

type Phase = "idle" | "starting" | "listening" | "paused" | "error";

export function microphoneError(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
        return "マイクが許可されていません。ブラウザのサイト設定で許可してから、再試行してください。";
      case "NotFoundError":
        return "マイクが見つかりません。マイクを接続してから、再試行してください。";
      case "NotReadableError":
        return "マイクを使用できません。他のアプリで使用中でないか確認してください。";
    }
  }
  return `音声を開始できませんでした: ${error instanceof Error ? error.message : String(error)}`;
}

export function createTuner() {
  const phase = ref<Phase>("idle");
  const error = ref("");
  const wakeMessage = ref("");
  const wakeActive = ref(false);
  const analysis = shallowRef<Analysis | null>(null);
  let generation = 0;
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wakeLock: WakeLockSentinel | undefined;
  let wakePending: number | undefined;
  let wakeRequested = false;
  let ready = false;
  let busy = false;
  let freshAfter = 0;

  async function releaseWake() {
    const lock = wakeLock;
    wakeLock = undefined;
    wakeActive.value = false;
    if (lock && !lock.released) {
      try {
        await lock.release();
      } catch (cause) {
        wakeMessage.value = `スリープ防止の解除に失敗しました: ${String(cause)}`;
      }
    }
  }

  async function requestWake() {
    if (
      (phase.value !== "starting" && phase.value !== "listening") ||
      document.visibilityState !== "visible" ||
      wakeLock ||
      wakePending === generation
    )
      return;
    if (!("wakeLock" in navigator)) {
      wakeRequested = false;
      wakeMessage.value =
        "このブラウザはスリープ防止に未対応です。必要に応じて画面の自動ロックを変更してください。";
      return;
    }
    const session = generation;
    wakeRequested = true;
    wakePending = session;
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (
        session !== generation ||
        (phase.value !== "starting" && phase.value !== "listening") ||
        document.visibilityState !== "visible"
      ) {
        await lock.release();
        return;
      }
      wakeLock = lock;
      wakeActive.value = true;
      wakeMessage.value = "";
      lock.addEventListener("release", () => {
        if (wakeLock !== lock) return;
        wakeLock = undefined;
        wakeActive.value = false;
        wakeMessage.value = "スリープ防止が解除されました。必要なら再取得してください。";
      });
    } catch (cause) {
      if (
        session !== generation ||
        (phase.value !== "starting" && phase.value !== "listening") ||
        document.visibilityState !== "visible"
      )
        return;
      wakeRequested = false;
      wakeMessage.value = `スリープ防止を有効にできませんでした: ${String(cause)}`;
    } finally {
      if (wakePending === session) wakePending = undefined;
    }
  }

  function resetReading() {
    analysis.value = null;
    freshAfter = performance.now() + (FRAME_SIZE / (context?.sampleRate ?? 48000)) * 1000;
  }

  function tick() {
    if (!context || !analyser || !worker) return;
    if (
      ready &&
      !busy &&
      context.state === "running" &&
      document.visibilityState === "visible" &&
      performance.now() >= freshAfter
    ) {
      const samples = new Float32Array(FRAME_SIZE);
      analyser.getFloatTimeDomainData(samples);
      busy = true;
      const message: WorkerRequest = { type: "analyze", samples, sampleRate: context.sampleRate };
      worker.postMessage(message, [samples.buffer]);
    }
    timer = setTimeout(tick, 80);
  }

  function stop() {
    generation++;
    wakeRequested = false;
    clearTimeout(timer);
    worker?.terminate();
    worker = undefined;
    ready = false;
    busy = false;
    source?.disconnect();
    source = undefined;
    analyser?.disconnect();
    analyser = undefined;
    const oldStream = stream;
    stream = undefined;
    oldStream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    const oldContext = context;
    context = undefined;
    if (oldContext) {
      oldContext.onstatechange = null;
      if (oldContext.state !== "closed") {
        void oldContext.close().catch((cause: unknown) => {
          error.value = `音声の終了処理に失敗しました: ${String(cause)}`;
        });
      }
    }
    void releaseWake();
    analysis.value = null;
    phase.value = "idle";
  }

  function fail(message: string) {
    stop();
    error.value = message;
    phase.value = "error";
  }

  function syncContextState() {
    if (!context) return;
    resetReading();
    if (context.state === "running" && document.visibilityState === "visible") {
      phase.value = ready ? "listening" : "starting";
      if (ready && wakeRequested) void requestWake();
    } else {
      phase.value = "paused";
      void releaseWake();
    }
  }

  async function resume() {
    if (!context) return;
    const session = generation;
    try {
      await context.resume();
      if (session === generation) syncContextState();
    } catch (cause) {
      if (session === generation) fail(microphoneError(cause));
    }
  }

  async function start() {
    stop();
    error.value = "";
    wakeMessage.value = "";
    phase.value = "starting";
    const session = generation;
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      fail("マイクには HTTPS または localhost と、音声入力に対応したブラウザが必要です。");
      return;
    }
    try {
      const audioContext = new AudioContext();
      context = audioContext;
      // Start all permission-sensitive operations in the button's activation, before any await.
      void requestWake();
      const permission = navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      if (audioContext.state === "suspended") void resume();
      const acquired = await permission;
      if (session !== generation) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = acquired;
      for (const track of acquired.getAudioTracks()) {
        track.onended = () => fail("マイクの接続が切れました。接続を確認して再試行してください。");
      }
      analyser = audioContext.createAnalyser();
      analyser.fftSize = FRAME_SIZE;
      analyser.smoothingTimeConstant = 0;
      source = audioContext.createMediaStreamSource(acquired);
      source.connect(analyser);
      // Do not connect to destination: microphone audio must never feed back into speakers.
      worker = new AudioWorker();
      worker.onerror = (event) => {
        event.preventDefault();
        fail(`音声解析を実行できませんでした: ${event.message}`);
      };
      worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        if (session !== generation) return;
        if (data.type === "error") {
          fail(data.message);
        } else if (data.type === "ready") {
          ready = true;
          syncContextState();
        } else {
          busy = false;
          if (
            phase.value === "listening" &&
            document.visibilityState === "visible" &&
            performance.now() >= freshAfter
          ) {
            analysis.value = data.analysis;
          }
        }
      };
      audioContext.onstatechange = syncContextState;
      syncContextState();
      tick();
    } catch (cause) {
      if (session === generation) fail(microphoneError(cause));
    }
  }

  function visibilityChanged() {
    if (!context) return;
    syncContextState();
    if (document.visibilityState === "visible" && context.state === "suspended") void resume();
  }

  return {
    phase,
    error,
    wakeMessage,
    wakeActive,
    analysis,
    start,
    stop,
    resume,
    requestWake,
    visibilityChanged,
  };
}
