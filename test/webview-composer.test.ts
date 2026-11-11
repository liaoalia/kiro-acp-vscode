import { test } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_LIMIT, PromptHistory } from "../src/webview/promptHistory.js";
import { QUIET_AFTER_MS, quietLabel, quietTitle } from "../src/webview/quiet.js";

test("Up walks back through the sent prompts and Down returns to the draft", () => {
  const h = new PromptHistory();
  h.push("first");
  h.push("second");
  assert.equal(h.recall(-1, "typing"), "second");
  assert.equal(h.browsing, true);
  assert.equal(h.recall(-1, "second"), "first");
  assert.equal(h.recall(-1, "first"), null, "nothing before the oldest prompt");
  assert.equal(h.recall(1, "first"), "second");
  assert.equal(h.recall(1, "second"), "typing", "the draft comes back past the newest prompt");
  assert.equal(h.browsing, false);
  assert.equal(h.recall(1, "typing"), null, "nothing after the draft");
});

test("a sent prompt is stored once in a row, empty text is not stored, and the limit holds", () => {
  const h = new PromptHistory(["a"]);
  h.push("a");
  h.push("");
  assert.deepEqual(h.list(), ["a"]);
  h.push("b");
  h.push("a");
  assert.deepEqual(h.list(), ["a", "b", "a"], "a repeat that is not the newest entry is stored again");
  for (let i = 0; i < HISTORY_LIMIT + 10; i++) h.push(`p${i}`);
  assert.equal(h.list().length, HISTORY_LIMIT);
  assert.equal(h.list()[0], "p10", "the oldest entries fall off");
});

test("sending or typing leaves browsing; the stored list survives a reload", () => {
  const h = new PromptHistory(["one", "two"]);
  assert.equal(h.recall(-1, ""), "two");
  h.reset();
  assert.equal(h.browsing, false);
  assert.equal(h.recall(-1, ""), "two", "Up starts again from the newest prompt");
  h.push("three");
  assert.equal(h.browsing, false);
  const reloaded = new PromptHistory([...h.list()]);
  assert.deepEqual(reloaded.list(), ["one", "two", "three"]);
  const garbage = new PromptHistory(["x", "", 3 as unknown as string]);
  assert.deepEqual(garbage.list(), ["x"], "non-strings and empty entries are dropped");
});

test("the quiet label appears after a minute of silence and counts minutes then hours", () => {
  const at = 1_000_000;
  assert.equal(quietLabel(at, at + QUIET_AFTER_MS - 1), null);
  assert.equal(quietLabel(at, at + QUIET_AFTER_MS), "no reply for 1 min");
  assert.equal(quietLabel(at, at + 53 * 60_000 + 999), "no reply for 53 min");
  assert.equal(quietLabel(at, at + 60 * 60_000), "no reply for 1 h");
  assert.equal(quietLabel(at, at + 125 * 60_000), "no reply for 2 h 5 min");
  assert.equal(quietLabel(null, at), null);
  assert.equal(quietLabel(undefined, at), null);
  assert.equal(quietLabel(Number.NaN, at), null);
});

test("the strip tooltip names the last event time only once quiet", () => {
  const at = new Date(2026, 10, 11, 13, 25).getTime();
  assert.equal(quietTitle(at, at + 1000), "Esc stops the turn");
  assert.match(quietTitle(at, at + 10 * 60_000), /^Last event from Kiro at 13:25\. Esc stops the turn/);
});
