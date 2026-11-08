import { describe, expect, it } from "vite-plus/test";
import { STRINGS, centsLabel, decodeAnalysis, levelPercent } from "./tuning";

describe("tuning contract", () => {
  it("uses A442 and exact 3:2 fifths, not equal temperament", () => {
    expect(STRINGS[2].target).toBe(442);
    for (let index = 1; index < STRINGS.length; index++) {
      expect(STRINGS[index]!.target / STRINGS[index - 1]!.target).toBeCloseTo(1.5, 12);
    }
  });

  it("decodes all four Rust readings and rejects broken payloads", () => {
    const values = new Float32Array([
      0.1, 196.4, -0.4, -20, 294.7, 0.2, -30, 442, 0, -10, 663, 0, -40, 2,
    ]);
    const result = decodeAnalysis(values);
    expect(result.strings).toHaveLength(4);
    expect(result.strings[2]).toEqual({ frequency: 442, cents: 0, db: -10 });
    expect(result.focus).toBe(2);
    expect(() => decodeAnalysis(new Float32Array(12))).toThrow();
    values[1] = NaN;
    expect(() => decodeAnalysis(values)).toThrow();
  });

  it("decodes no focus and rejects invalid focus indices", () => {
    const values = new Float32Array(14);
    values[13] = -1;
    expect(decodeAnalysis(values).focus).toBeNull();
    for (const index of [-2, 0.5, 4]) {
      values[13] = index;
      expect(() => decodeAnalysis(values)).toThrow("弦番号");
    }
  });

  it("formats cents without negative zero and clamps visual levels", () => {
    expect(centsLabel(-0.2)).toBe("0");
    expect(centsLabel(4.6)).toBe("+5");
    expect(centsLabel(-9)).toBe("-9");
    expect(levelPercent(-120)).toBe(0);
    expect(levelPercent(-72)).toBe(0);
    expect(levelPercent(-36)).toBe(50);
    expect(levelPercent(-69)).toBeCloseTo((3 / 72) * 100);
    expect(levelPercent(10)).toBe(100);
  });
});
