import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_USAGE, applyUsageUpdate, tokenTotal } from "../src/features/pure/usage.js";
import { formatTokens, usageText } from "../src/webview/usageText.js";

test("usage_update sets the context numbers, the percentage and the cost", () => {
  const next = applyUsageUpdate(EMPTY_USAGE, {
    sessionUpdate: "usage_update",
    used: 8400,
    size: 200_000,
    cost: { amount: 0.1234, currency: "USD" },
  });
  assert.deepEqual(next, {
    contextPercent: 4,
    contextUsed: 8400,
    contextSize: 200_000,
    tokensSpent: null,
    cost: { amount: 0.1234, currency: "USD" },
  });
});

test("Kiro context_usage carries usagePercentage in _meta.kiro", () => {
  const update = { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "context_usage", usagePercentage: 42.6 } } };
  const next = applyUsageUpdate(EMPTY_USAGE, update);
  assert.equal(next?.contextPercent, 43);
  assert.equal(next?.contextUsed, null);
  assert.equal(applyUsageUpdate(next!, update), null, "the same value again is nothing new");
});

test("context_usage percentages are clamped and may come with token counts", () => {
  const next = applyUsageUpdate(EMPTY_USAGE, {
    sessionUpdate: "session_info_update",
    _meta: { kiro: { kind: "context_usage", usagePercentage: 140, usedTokens: 10, contextWindow: 100 } },
  });
  assert.deepEqual(next, { ...EMPTY_USAGE, contextPercent: 100, contextUsed: 10, contextSize: 100 });
  const derived = applyUsageUpdate(EMPTY_USAGE, {
    sessionUpdate: "session_info_update",
    _meta: { kiro: { kind: "context_usage", usedTokens: 25, contextWindow: 100 } },
  });
  assert.equal(derived?.contextPercent, 25, "derived from the counts when no percentage is given");
});

test("turn_completion summaries add up across turns", () => {
  const one = applyUsageUpdate(EMPTY_USAGE, {
    sessionUpdate: "session_info_update",
    _meta: {
      kiro: {
        kind: "turn_completion",
        promptTurnSummaries: [{ inputTokens: 1200, outputTokens: 300 }, { usage: { input_tokens: 10, output_tokens: 5 } }],
      },
    },
  });
  assert.equal(one?.tokensSpent, 1515);
  const two = applyUsageUpdate(one!, {
    sessionUpdate: "session_info_update",
    _meta: { kiro: { kind: "turn_completion", promptTurnSummaries: [{ totalTokens: 100, inputTokens: 90, outputTokens: 10 }] } },
  });
  assert.equal(two?.tokensSpent, 1615, "totalTokens wins over the parts");
  assert.equal(
    applyUsageUpdate(two!, { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "turn_completion", promptTurnSummaries: [] } } }),
    null,
    "an empty summary changes nothing",
  );
});

test("tokenTotal ignores non-token numbers and stops at depth 3", () => {
  assert.equal(tokenTotal({ durationMs: 500, inputTokens: 3, nested: { outputTokens: 4, deeper: { cacheReadTokens: 5 } } }), 12);
  assert.equal(tokenTotal({ a: { b: { c: { d: { inputTokens: 99 } } } } }), 0);
  assert.equal(tokenTotal("nope"), 0);
});

test("updates without usage information are ignored", () => {
  assert.equal(applyUsageUpdate(EMPTY_USAGE, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }), null);
  assert.equal(applyUsageUpdate(EMPTY_USAGE, { sessionUpdate: "session_info_update", title: "T" }), null);
  assert.equal(applyUsageUpdate(EMPTY_USAGE, { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "steering_injected" } } }), null);
  assert.equal(applyUsageUpdate(EMPTY_USAGE, { sessionUpdate: "usage_update", used: "8400", size: 0 }), null);
  assert.equal(applyUsageUpdate(EMPTY_USAGE, null), null);
});

test("formatTokens shortens large counts", () => {
  assert.equal(formatTokens(812), "812");
  assert.equal(formatTokens(1000), "1k");
  assert.equal(formatTokens(12_345), "12k");
  assert.equal(formatTokens(8_400), "8.4k");
  assert.equal(formatTokens(1_234_567), "1.2M");
});

test("usageText builds the pill label and tooltip from what is known", () => {
  assert.equal(usageText(null), null);
  assert.equal(usageText(EMPTY_USAGE), null);
  const full = usageText({
    contextPercent: 42,
    contextUsed: 84_000,
    contextSize: 200_000,
    tokensSpent: 12_345,
    cost: { amount: 0.5, currency: "USD" },
  });
  assert.equal(full?.label, "42% ctx · 12k tokens");
  assert.equal(
    full?.title,
    "Context window: 42% used (84,000 of 200,000 tokens)\nTokens spent this session: 12,345\nCost: 0.50 USD",
  );
  assert.equal(usageText({ ...EMPTY_USAGE, contextPercent: 7 })?.label, "7% ctx");
  assert.equal(usageText({ ...EMPTY_USAGE, tokensSpent: 950 })?.label, "950 tokens");
  assert.equal(usageText({ ...EMPTY_USAGE, contextUsed: 3000 })?.label, "3k ctx");
  assert.equal(usageText({ ...EMPTY_USAGE, cost: { amount: 2, currency: "credits" } })?.label, "2 credits");
});
