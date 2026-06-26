import { describe, it, expect } from "vitest";
import { compactBlockToFit, safeAppendToBlock } from "../core-block-compactor";

describe("safeAppendToBlock", () => {
  it("appends normally and never throws when under the limit", () => {
    const r = safeAppendToBlock("line one", "line two", 100);
    expect(r.value).toBe("line one\nline two");
    expect(r.evicted).toEqual([]);
    expect(r.truncatedIncoming).toBe(false);
  });

  it("degrades gracefully instead of throwing when the append overflows", () => {
    // appendToBlock would throw here; we evict oldest to make room.
    const current = "aaaa\nbbbb\ncccc"; // 14 chars incl newlines
    const r = safeAppendToBlock(current, "dddd", 14);
    expect(r.value.length).toBeLessThanOrEqual(14);
    expect(r.value.endsWith("dddd")).toBe(true);
    expect(r.evicted.length).toBeGreaterThan(0);
  });
});

describe("compactBlockToFit", () => {
  it("always preserves the newest incoming text", () => {
    const current = "old1\nold2\nold3\nold4";
    const r = compactBlockToFit(current, "NEWEST", 12);
    expect(r.value.length).toBeLessThanOrEqual(12);
    expect(r.value.endsWith("NEWEST")).toBe(true);
  });

  it("evicts oldest lines first (FIFO) and returns them for archival", () => {
    const current = "oldest\nmiddle\nnewer";
    const r = compactBlockToFit(current, "incoming", 20);
    expect(r.value.length).toBeLessThanOrEqual(20);
    // The oldest line should be the first thing evicted.
    expect(r.evicted[0]).toBe("oldest");
    expect(r.value.endsWith("incoming")).toBe(true);
  });

  it("dedups repeated lines, keeping the most recent occurrence", () => {
    const current = "fact A\nfact B\nfact A";
    const r = compactBlockToFit(current, "fact C", 200);
    // "fact A" appears once now, and dedupedCount reflects the collapse.
    const occurrences = r.value.split("\n").filter((l) => l === "fact A").length;
    expect(occurrences).toBe(1);
    expect(r.dedupedCount).toBeGreaterThanOrEqual(1);
    expect(r.value.endsWith("fact C")).toBe(true);
  });

  it("collapses the incoming line if it duplicates an existing one", () => {
    const current = "keep me\ndup line";
    const r = compactBlockToFit(current, "dup line", 200);
    const occurrences = r.value.split("\n").filter((l) => l === "dup line").length;
    expect(occurrences).toBe(1);
  });

  it("truncates to the tail when the incoming text alone exceeds the limit", () => {
    const r = compactBlockToFit("anything here", "0123456789ABCDEF", 8);
    expect(r.truncatedIncoming).toBe(true);
    expect(r.value).toBe("89ABCDEF");
    expect(r.value.length).toBe(8);
  });

  it("guarantees the result fits for any pathological input", () => {
    const current = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const r = compactBlockToFit(current, "final", 16);
    expect(r.value.length).toBeLessThanOrEqual(16);
    expect(r.value.endsWith("final")).toBe(true);
  });
});
