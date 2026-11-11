/** F15 — context / token usage reported by the agent reaches the state and the views (D26). */
import { assert, assertEqual, freshSession, runPrompt, test, waitFor } from "./harness.js";

test("F15.1 usage_update, context_usage and turn_completion fill the session's usage", async ({ api, recorder }) => {
  await freshSession(api);
  assertEqual(api.controller.snapshot().usage ?? null, null, "no usage before the agent reported any");

  const mark = recorder.mark();
  await runPrompt(api, "/scenario usage");

  const usage = api.controller.snapshot().usage;
  assert(usage, "the snapshot carries the usage");
  assertEqual(usage.contextPercent, 42, "percentage from Kiro's context_usage (overrides the usage_update ratio)");
  assertEqual(usage.contextUsed, 8400, "tokens in context from usage_update");
  assertEqual(usage.contextSize, 200_000, "context window from usage_update");
  assertEqual(usage.tokensSpent, 1500, "turn_completion summaries summed");
  assertEqual(usage.cost, null, "no cost reported");

  const posts = recorder.ofType("usage", mark);
  assert(posts.length >= 3, `one usage post per change, got ${posts.length}`);
  assertEqual(posts[posts.length - 1]?.usage?.tokensSpent, 1500, "the last post carries the final numbers");
  assertEqual(posts[0]?.usage?.contextPercent, 4, "the first post derives 4% from usage_update");

  // A second turn adds its tokens; the context numbers stay.
  await runPrompt(api, "/scenario usage");
  const after = api.controller.snapshot().usage;
  assertEqual(after?.tokensSpent, 3000, "tokens add up across turns");
  assertEqual(after?.contextPercent, 42, "context percentage unchanged");

  // A new session starts from nothing.
  await freshSession(api);
  assertEqual(api.controller.snapshot().usage ?? null, null, "a fresh session has no usage");
});

test("F15.2 after a turn without a usage report, _kiro/session/context is polled once for the percentage", async ({ api, recorder }) => {
  await freshSession(api);
  const mark = recorder.mark();
  await runPrompt(api, "/scenario chat");
  await waitFor(() => api.controller.snapshot().usage?.contextPercent === 7, 15_000, "the polled percentage");
  const usage = api.controller.snapshot().usage;
  assertEqual(usage?.contextSize, 200_000, "the polled context window");
  assertEqual(usage?.tokensSpent, null, "nothing known about tokens spent");

  // Known percentage: no second poll changes anything.
  await runPrompt(api, "/scenario chat");
  await new Promise((r) => setTimeout(r, 300));
  const posts = recorder.ofType("usage", mark);
  assertEqual(posts.length, 1, `one usage post in all: ${JSON.stringify(posts)}`);
});
