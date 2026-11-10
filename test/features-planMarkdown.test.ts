import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_APPROVAL_NOTE,
  PLAN_EMPTY_TEXT,
  planStatusLine,
  renderPlanEntry,
  renderPlanMarkdown,
} from "../src/features/pure/planMarkdown.js";
import type { PlanEntryView } from "../src/ui/protocol.js";

const entries: PlanEntryView[] = [
  { content: "Read the code", priority: "high", status: "completed" },
  { content: "Write tests", priority: "medium", status: "in_progress" },
  { content: "Polish\ndocs", priority: "low", status: "pending" },
];

test("empty plan renders title and placeholder", () => {
  const md = renderPlanMarkdown([], { approvalPending: false });
  assert.ok(md.startsWith("# Kiro plan\n"));
  assert.ok(md.includes(PLAN_EMPTY_TEXT));
  assert.ok(!md.includes("- ["));
  assert.ok(!md.includes(PLAN_APPROVAL_NOTE));
});

test("status line counts done and in progress", () => {
  assert.equal(planStatusLine(entries), "1 of 3 done · 1 in progress");
  assert.equal(planStatusLine([entries[0]!]), "1 of 1 done");
});

test("entries render as a task list with markers and badges", () => {
  assert.equal(renderPlanEntry(entries[0]!), "- [x] **(high)** Read the code");
  assert.equal(renderPlanEntry(entries[1]!), "- [ ] ⏳ Write tests");
  assert.equal(renderPlanEntry(entries[2]!), "- [ ] (low) Polish docs");
});

test("full render keeps order and includes meta + approval note", () => {
  const md = renderPlanMarkdown(entries, {
    sessionId: "sess-1",
    updatedAt: new Date(2026, 0, 2, 3, 4, 5),
    approvalPending: true,
  });
  const lines = md.split("\n");
  assert.equal(lines[0], "# Kiro plan");
  assert.equal(lines[1], "_Session sess-1 · updated 03:04:05_");
  assert.ok(md.includes(PLAN_APPROVAL_NOTE));
  assert.ok(md.includes("**1 of 3 done · 1 in progress**"));
  const taskLines = lines.filter((l) => l.startsWith("- ["));
  assert.deepEqual(taskLines, [
    "- [x] **(high)** Read the code",
    "- [ ] ⏳ Write tests",
    "- [ ] (low) Polish docs",
  ]);
  assert.ok(md.indexOf(PLAN_APPROVAL_NOTE) < md.indexOf("- [x]"), "note precedes the list");
});

test("approval note absent when not pending", () => {
  const md = renderPlanMarkdown(entries, { approvalPending: false });
  assert.ok(!md.includes(PLAN_APPROVAL_NOTE));
  assert.ok(!md.includes("_Session"));
});
