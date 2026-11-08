import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createTuner, microphoneError } from "./tuner";

class FakeContext {
  static instances: FakeContext[] = [];
  static initialState = "running";
  state = FakeContext.initialState;
  sampleRate = 48000;
  onstatechange: (() => void) | null = null;
  analyser = {
    fftSize: 0,
    smoothingTimeConstant: 0,
    getFloatTimeDomainData: vi.fn(),
    disconnect: vi.fn(),
  };
  source = { connect: vi.fn(), disconnect: vi.fn() };
  constructor() {
    FakeContext.instances.push(this);
  }
  createAnalyser() {
    return this.analyser;
  }
  createMediaStreamSource() {
    return this.source;
  }
  close = vi.fn(async () => {
    this.state = "closed";
  });
  resume = vi.fn(async () => {
    this.state = "running";
  });
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string; preventDefault: () => void }) => void;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  send(data: unknown) {
    this.onmessage?.({ data });
  }
}

function mediaStream() {
  const track = { stop: vi.fn(), onended: null };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}

describe("audio lifecycle", () => {
  let tuner: ReturnType<typeof createTuner>;
  let acquired: ReturnType<typeof mediaStream>;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let lock: {
    released: boolean;
    release: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
  };
  let requestWake: ReturnType<typeof vi.fn>;
  let activation: { isActive: boolean };

  beforeEach(() => {
    vi.useFakeTimers();
    FakeContext.instances = [];
    FakeContext.initialState = "running";
    FakeWorker.instances = [];
    acquired = mediaStream();
    getUserMedia = vi.fn().mockResolvedValue(acquired);
    lock = {
      released: false,
      release: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
    };
    requestWake = vi.fn().mockResolvedValue(lock);
    activation = { isActive: false };
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia },
      wakeLock: { request: requestWake },
      userActivation: activation,
    });
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("AudioContext", FakeContext);
    vi.stubGlobal("Worker", FakeWorker);
    tuner = createTuner();
  });

  afterEach(() => {
    tuner.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function ready() {
    await tuner.start();
    FakeWorker.instances[0]!.send({ type: "ready" });
    await Promise.resolve();
  }

  it("does not request permissions or create audio resources before start", () => {
    expect(tuner.phase.value).toBe("idle");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(requestWake).not.toHaveBeenCalled();
    expect(FakeContext.instances).toHaveLength(0);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("requests unprocessed microphone input, acquires wake lock, and releases every resource", async () => {
    await ready();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    expect(tuner.phase.value).toBe("listening");
    expect(tuner.wakeActive.value).toBe(true);
    const context = FakeContext.instances[0]!;
    expect(context.source.connect).toHaveBeenCalledExactlyOnceWith(context.analyser);
    tuner.stop();
    expect(acquired.track.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    expect(lock.release).toHaveBeenCalledOnce();
    expect(tuner.analysis.value).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a microphone granted after cancellation", async () => {
    let grant!: (value: ReturnType<typeof mediaStream>) => void;
    getUserMedia.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    const starting = tuner.start();
    tuner.stop();
    grant(acquired);
    await starting;
    expect(acquired.track.stop).toHaveBeenCalledOnce();
    expect(FakeContext.instances[0]!.close).toHaveBeenCalledOnce();
    expect(tuner.phase.value).toBe("idle");
  });

  it("requests both permissions and resumes audio in the same start activation", async () => {
    let grant!: (value: ReturnType<typeof mediaStream>) => void;
    getUserMedia.mockImplementation(() => {
      expect(activation.isActive).toBe(true);
      return new Promise((resolve) => {
        grant = resolve;
      });
    });
    requestWake.mockImplementation(async () => {
      expect(activation.isActive).toBe(true);
      return lock;
    });
    FakeContext.initialState = "suspended";
    activation.isActive = true;
    const starting = tuner.start();
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(requestWake).toHaveBeenCalledOnce();
    expect(FakeContext.instances[0]!.resume).toHaveBeenCalledOnce();
    activation.isActive = false;
    await Promise.resolve();
    expect(tuner.phase.value).toBe("starting");
    expect(tuner.wakeActive.value).toBe(true);
    grant(acquired);
    await starting;
    FakeWorker.instances[0]!.send({ type: "ready" });
    await Promise.resolve();
    expect(requestWake).toHaveBeenCalledOnce();
    expect(tuner.phase.value).toBe("listening");
  });

  it("does not automatically retry a refused wake lock when audio becomes ready", async () => {
    requestWake.mockRejectedValue(new DOMException("Permission was denied", "NotAllowedError"));
    activation.isActive = true;
    await ready();
    expect(tuner.phase.value).toBe("listening");
    expect(tuner.wakeMessage.value).toContain("Permission was denied");
    expect(tuner.wakeActive.value).toBe(false);
    expect(requestWake).toHaveBeenCalledOnce();
    requestWake.mockResolvedValue(lock);
    await tuner.requestWake();
    expect(tuner.wakeActive.value).toBe(true);
    expect(requestWake).toHaveBeenCalledTimes(2);
  });

  it("releases a wake lock granted after cancellation", async () => {
    let grant!: (value: typeof lock) => void;
    requestWake.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    await ready();
    tuner.stop();
    grant(lock);
    await Promise.resolve();
    expect(lock.release).toHaveBeenCalledOnce();
    expect(tuner.wakeActive.value).toBe(false);
    expect(tuner.phase.value).toBe("idle");
    expect(requestWake).toHaveBeenCalledOnce();
  });

  it("starts a fresh wake request without waiting for a cancelled session", async () => {
    let grantOld!: (value: typeof lock) => void;
    const oldLock = { ...lock, release: vi.fn().mockResolvedValue(undefined) };
    requestWake.mockReturnValueOnce(
      new Promise((resolve) => {
        grantOld = resolve;
      }),
    );
    await tuner.start();
    tuner.stop();
    const nextStart = tuner.start();
    expect(requestWake).toHaveBeenCalledTimes(2);
    await nextStart;
    expect(tuner.wakeActive.value).toBe(true);
    grantOld(oldLock);
    await Promise.resolve();
    expect(oldLock.release).toHaveBeenCalledOnce();
    expect(lock.release).not.toHaveBeenCalled();
    expect(tuner.wakeActive.value).toBe(true);
  });

  it("ignores wake permission rejection after stopping", async () => {
    let reject!: (reason: unknown) => void;
    requestWake.mockReturnValue(
      new Promise((_resolve, rejectRequest) => {
        reject = rejectRequest;
      }),
    );
    await ready();
    tuner.stop();
    reject(new DOMException("Permission was denied", "NotAllowedError"));
    await Promise.resolve();
    expect(tuner.phase.value).toBe("idle");
    expect(tuner.wakeActive.value).toBe(false);
    expect(tuner.wakeMessage.value).toBe("");
    expect(requestWake).toHaveBeenCalledOnce();
  });

  it("shows a permission error and allows retry", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    await tuner.start();
    expect(tuner.phase.value).toBe("error");
    expect(tuner.error.value).toContain("許可");
    expect(lock.release).toHaveBeenCalledOnce();
    expect(FakeContext.instances[0]!.close).toHaveBeenCalledOnce();
    expect(tuner.wakeActive.value).toBe(false);
    await tuner.start();
    expect(tuner.error.value).toBe("");
  });

  it("pauses analysis while hidden and reacquires wake lock on return", async () => {
    await ready();
    vi.stubGlobal("document", { visibilityState: "hidden" });
    tuner.visibilityChanged();
    expect(tuner.phase.value).toBe("paused");
    expect(tuner.analysis.value).toBeNull();
    expect(lock.release).toHaveBeenCalledOnce();
    vi.stubGlobal("document", { visibilityState: "visible" });
    tuner.visibilityChanged();
    await Promise.resolve();
    expect(tuner.phase.value).toBe("listening");
    expect(requestWake).toHaveBeenCalledTimes(2);
  });

  it("surfaces worker failure and releases the microphone", async () => {
    await ready();
    FakeWorker.instances[0]!.send({ type: "error", message: "WASM failed" });
    expect(tuner.phase.value).toBe("error");
    expect(tuner.error.value).toBe("WASM failed");
    expect(acquired.track.stop).toHaveBeenCalledOnce();
  });

  it("continues tuning with an explicit warning when wake lock fails", async () => {
    requestWake.mockRejectedValueOnce(new Error("Unavailable"));
    await ready();
    expect(tuner.phase.value).toBe("listening");
    expect(tuner.wakeActive.value).toBe(false);
    expect(tuner.wakeMessage.value).toContain("Unavailable");
  });

  it("reports missing microphones and insecure contexts", async () => {
    expect(microphoneError(new DOMException("", "NotFoundError"))).toContain("見つかりません");
    vi.stubGlobal("isSecureContext", false);
    await tuner.start();
    expect(tuner.error.value).toContain("HTTPS");
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
