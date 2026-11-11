import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_USAGE, applyContextResult, contextFromResult } from "../src/features/pure/usage.js";

test("a _kiro/session/context reply is read from nested keys", () => {
  const found = contextFromResult({
    ok: true,
    contextWindow: { usagePercentage: 37.4, usedTokens: 74_800, contextWindowSize: 200_000 },
  });
  assert.deepEqual(found, { contextPercent: 37, contextUsed: 74_800, contextSize: 200_000 });
});

test("the percentage is derived from counts, also inside arrays, and the fake agent's echo yields nothing", () => {
  assert.deepEqual(contextFromResult({ items: [{ name: "files", count: 1 }], total: { tokens: 50_000, limit: 200_000 } }), {
    contextPercent: 25,
    contextUsed: 50_000,
    contextSize: 200_000,
  });
  assert.equal(contextFromResult({ ok: true, echoed: { sessionId: "s1" } }), null);
  assert.deepEqual(
    contextFromResult({ summary: { tokens: 9 }, window: { usedTokens: 20, contextWindow: 80 } }),
    { contextPercent: 25, contextUsed: 20, contextSize: 80 },
    "a specific key deeper down beats a generic one higher up",
  );
  assert.equal(contextFromResult("plain text without numbers"), null);
  assert.equal(contextFromResult(null), null);
});

test("text replies are parsed: '42% used' and '84k of 200k tokens'", () => {
  assert.deepEqual(contextFromResult({ content: "Context window: 42% used (84k of 200k tokens)" }), {
    contextPercent: 42,
    contextUsed: 84_000,
    contextSize: 200_000,
  });
  assert.deepEqual(contextFromResult([{ type: "text", text: "12,345 / 1.5M tokens in context" }]), {
    contextPercent: 1,
    contextUsed: 12_345,
    contextSize: 1_500_000,
  });
  assert.deepEqual(contextFromResult("Usage: 7%"), { contextPercent: 7, contextUsed: null, contextSize: null });
});

test("applyContextResult keeps the token totals and reports no change for the same numbers", () => {
  const before = { ...EMPTY_USAGE, tokensSpent: 1500 };
  const next = applyContextResult(before, { usagePercentage: 7, contextWindowSize: 200_000 });
  assert.deepEqual(next, { ...before, contextPercent: 7, contextSize: 200_000 });
  assert.equal(applyContextResult(next!, { usagePercentage: 7, contextWindowSize: 200_000 }), null);
  assert.equal(applyContextResult(next!, { ok: true }), null, "nothing usable is no change");
  assert.doesNotThrow(() => applyContextResult(next!, { a: { b: { c: { d: { e: { usagePercentage: 99 } } } } } }));
});
