import init, { Analyzer } from "@violin-tuner/dsp";
import {
  FRAME_SIZE,
  STRINGS,
  decodeAnalysis,
  type WorkerRequest,
  type WorkerResponse,
} from "./tuning";

const respond = (message: WorkerResponse) => self.postMessage(message);

try {
  await init();
  const analyzer = new Analyzer(
    FRAME_SIZE,
    new Float32Array(STRINGS.map((string) => string.target)),
  );
  self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
    try {
      const values = analyzer.analyze(data.samples, data.sampleRate);
      respond({ type: "result", analysis: decodeAnalysis(values) });
    } catch (error) {
      respond({ type: "error", message: String(error) });
    }
  };
  respond({ type: "ready" });
} catch (error) {
  respond({ type: "error", message: `音声解析の初期化に失敗しました: ${String(error)}` });
}
