import { describe, it, expect, beforeEach } from "vitest";
import {
  clearQualityAISummaryCache,
  deleteQualityAISummaryCache,
  getQualityAISummaryCache,
  setQualityAISummaryCache,
} from "../qualityAIHelpers";

describe("quality AI summary cache", () => {
  beforeEach(() => {
    clearQualityAISummaryCache();
  });

  it("round-trips values via set/get", () => {
    setQualityAISummaryCache("k1", "summary one");
    expect(getQualityAISummaryCache("k1")).toBe("summary one");
  });

  it("returns null for unknown keys", () => {
    expect(getQualityAISummaryCache("does-not-exist")).toBeNull();
  });

  it("deletes a single key without affecting others", () => {
    setQualityAISummaryCache("k1", "a");
    setQualityAISummaryCache("k2", "b");
    deleteQualityAISummaryCache("k1");
    expect(getQualityAISummaryCache("k1")).toBeNull();
    expect(getQualityAISummaryCache("k2")).toBe("b");
  });

  it("clearQualityAISummaryCache wipes everything", () => {
    setQualityAISummaryCache("k1", "a");
    setQualityAISummaryCache("k2", "b");
    clearQualityAISummaryCache();
    expect(getQualityAISummaryCache("k1")).toBeNull();
    expect(getQualityAISummaryCache("k2")).toBeNull();
  });
});
