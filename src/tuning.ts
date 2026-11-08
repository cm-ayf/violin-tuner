export const FRAME_SIZE = 16384;
export const MONITOR_FLOOR_DB = -72;
export const STRINGS = [
  { name: "G", octave: 3, label: "G線", target: (442 * 4) / 9 },
  { name: "D", octave: 4, label: "D線", target: (442 * 2) / 3 },
  { name: "A", octave: 4, label: "A線", target: 442 },
  { name: "E", octave: 5, label: "E線", target: 663 },
] as const;
export type StringIndex = 0 | 1 | 2 | 3;
export interface Reading {
  frequency: number;
  cents: number;
  db: number;
}
export interface Analysis {
  rms: number;
  strings: [Reading, Reading, Reading, Reading];
  focus: StringIndex | null;
}
export type WorkerRequest = { type: "analyze"; samples: Float32Array; sampleRate: number };
export type WorkerResponse =
  | { type: "ready" }
  | { type: "result"; analysis: Analysis }
  | { type: "error"; message: string };

export function decodeAnalysis(values: Float32Array): Analysis {
  if (values.length !== 14 || !values.every(Number.isFinite)) {
    throw new Error("音声解析から不正な結果が返されました。");
  }
  const focus = values[13];
  if (focus !== -1 && focus !== 0 && focus !== 1 && focus !== 2 && focus !== 3) {
    throw new Error("音声解析から不正な弦番号が返されました。");
  }
  const reading = (index: number): Reading => ({
    frequency: values[index]!,
    cents: values[index + 1]!,
    db: values[index + 2]!,
  });
  return {
    rms: values[0]!,
    strings: [reading(1), reading(4), reading(7), reading(10)],
    focus: focus === -1 ? null : focus,
  };
}

export function centsLabel(cents: number): string {
  const rounded = Math.round(cents);
  return `${rounded > 0 ? "+" : ""}${rounded === 0 ? 0 : rounded}`;
}

export function levelPercent(db: number): number {
  return Math.max(0, Math.min(100, ((db - MONITOR_FLOOR_DB) / -MONITOR_FLOOR_DB) * 100));
}
