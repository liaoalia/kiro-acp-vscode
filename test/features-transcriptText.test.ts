import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_TRANSCRIPT_TEXT, lastAgentAnswer, transcriptText } from "../src/features/pure/transcriptText.js";
import type { TranscriptState } from "../src/features/pure/transcript.js";
import type { MessageOrigin, MessageRole, MessageSegment, ToolCallView, ToolStatus, TranscriptItem } from "../src/ui/protocol.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type State = Pick<TranscriptState, "items" | "toolCalls">;

let seq = 0;

function message(role: MessageRole, content: string | MessageSegment[], origin?: MessageOrigin): TranscriptItem {
  seq += 1;
  const segments: MessageSegment[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
  return { type: "message", message: { id: `m${seq}`, role, segments, ...(origin ? { origin } : {}) } };
}

const user = (content: string | MessageSegment[], origin?: MessageOrigin): TranscriptItem => message("user", content, origin);
const agent = (content: string | MessageSegment[]): TranscriptItem => message("agent", content);
const thought = (content: string): TranscriptItem => message("thought", content);
const tool = (toolCallId: string): TranscriptItem => ({ type: "tool", toolCallId });

function toolCall(toolCallId: string, title: string, status: ToolStatus): ToolCallView {
  return { toolCallId, title, kind: "other", status, content: [], locations: [] };
}

function state(items: TranscriptItem[], calls: ToolCallView[] = []): State {
  return { items, toolCalls: Object.fromEntries(calls.map((c) => [c.toolCallId, c])) };
}

const wide = { last: 100, maxChars: 100_000 };

// ---------------------------------------------------------------------------
// transcriptText
// ---------------------------------------------------------------------------

test("an empty transcript (or one with only thoughts) is '(no messages yet)'", () => {
  assert.deepEqual(transcriptText(state([]), wide), { text: EMPTY_TRANSCRIPT_TEXT, items: 0, truncated: false });
  assert.equal(EMPTY_TRANSCRIPT_TEXT, "(no messages yet)");
  assert.deepEqual(transcriptText(state([thought("hmm")]), wide), { text: "(no messages yet)", items: 0, truncated: false });
});

test("one block per item, oldest first, separated by a blank line; thoughts are left out", () => {
  const s = state(
    [
      user("Fix the login bug"),
      thought("Let me think about it"),
      agent("Looking at auth.ts"),
      tool("t1"),
      tool("t2"),
      agent("Fixed it.\nThe token was not refreshed."),
    ],
    [toolCall("t1", "Read src/auth.ts", "completed"), toolCall("t2", "Run tests", "failed")],
  );
  const result = transcriptText(s, wide);
  assert.equal(
    result.text,
    [
      "user: Fix the login bug",
      "agent: Looking at auth.ts",
      "[tool] Read src/auth.ts — completed",
      "[tool] Run tests — failed",
      "agent: Fixed it.\nThe token was not refreshed.",
    ].join("\n\n"),
  );
  assert.equal(result.items, 5);
  assert.equal(result.truncated, false);
});

test("a tool item whose call is unknown is skipped and does not count", () => {
  const s = state([user("go"), tool("missing"), tool("t1")], [toolCall("t1", "Edit a.ts", "in_progress")]);
  const result = transcriptText(s, wide);
  assert.equal(result.text, "user: go\n\n[tool] Edit a.ts — in_progress");
  assert.equal(result.items, 2);
  assert.equal(result.truncated, false);
});

test("a user message sent by another session shows its origin", () => {
  const origin: MessageOrigin = { sessionId: "sess-2", handle: "s2", title: 'Fix "login"' };
  const result = transcriptText(state([user("Please review auth.ts", origin), agent("On it")]), wide);
  assert.equal(result.text, 'message from s2 "Fix \\"login\\"": Please review auth.ts\n\nagent: On it');
});

test("resources and images are shown inline as chips", () => {
  const s = state([
    user([
      { type: "text", text: "Look at" },
      { type: "resource", uri: "file:///w/src/app.ts", label: "src/app.ts" },
      { type: "text", text: "and this:" },
      { type: "image", mimeType: "image/png", name: "shot.png" },
      { type: "image", mimeType: "image/png" },
    ]),
    user([{ type: "resource", uri: "file:///w/README.md", label: "" }, { type: "text", text: " first line" }]),
    agent([{ type: "text", text: "Here: " }, { type: "image", mimeType: "image/png", name: "plot.png" }]),
  ]);
  assert.equal(
    transcriptText(s, wide).text,
    [
      "user: Look at [file src/app.ts] and this: [image shot.png] [image]",
      "user: [file file:///w/README.md] first line",
      "agent: Here: [image plot.png]",
    ].join("\n\n"),
  );
});

test("messages without any text are skipped", () => {
  const s = state([user("hi"), agent([]), agent("   \n"), agent("ok")]);
  const result = transcriptText(s, wide);
  assert.equal(result.text, "user: hi\n\nagent: ok");
  assert.equal(result.items, 2);
});

test("`last` keeps the newest items and sets truncated; thoughts do not count", () => {
  const s = state([user("one"), agent("two"), thought("…"), user("three"), thought("…"), agent("four")]);
  const two = transcriptText(s, { last: 2, maxChars: 1000 });
  assert.deepEqual(two, { text: "user: three\n\nagent: four", items: 2, truncated: true });

  const all = transcriptText(s, { last: 4, maxChars: 1000 });
  assert.equal(all.items, 4);
  assert.equal(all.truncated, false);

  const more = transcriptText(s, { last: 50, maxChars: 1000 });
  assert.equal(more.items, 4);
  assert.equal(more.truncated, false);

  // `last` is at least 1.
  assert.deepEqual(transcriptText(s, { last: 0, maxChars: 1000 }), { text: "agent: four", items: 1, truncated: true });
});

test("`maxChars` drops the oldest blocks until the text fits", () => {
  const s = state([user("aaaa"), agent("bbbb"), user("cccc")]);
  // Each block is 10 or 11 characters; two with the separator are 10 + 2 + 11 = 23.
  const full = transcriptText(s, { last: 10, maxChars: 1000 });
  assert.equal(full.text, "user: aaaa\n\nagent: bbbb\n\nuser: cccc");
  assert.equal(full.text.length, 35);

  assert.deepEqual(transcriptText(s, { last: 10, maxChars: 35 }), { ...full, truncated: false });
  assert.deepEqual(transcriptText(s, { last: 10, maxChars: 34 }), {
    text: "agent: bbbb\n\nuser: cccc",
    items: 2,
    truncated: true,
  });
  assert.deepEqual(transcriptText(s, { last: 10, maxChars: 23 }), {
    text: "agent: bbbb\n\nuser: cccc",
    items: 2,
    truncated: true,
  });
  assert.deepEqual(transcriptText(s, { last: 10, maxChars: 22 }), { text: "user: cccc", items: 1, truncated: true });
  assert.deepEqual(transcriptText(s, { last: 10, maxChars: 10 }), { text: "user: cccc", items: 1, truncated: true });
});

test("a newest block longer than maxChars keeps its end after '…'", () => {
  const s = state([user("first"), agent("0123456789abcdefghij")]);
  const result = transcriptText(s, { last: 10, maxChars: 8 });
  assert.deepEqual(result, { text: "…defghij", items: 1, truncated: true });
  assert.equal(result.text.length, 8);

  // Only one item, too long on its own: still truncated.
  assert.deepEqual(transcriptText(state([agent("abcdef")]), { last: 1, maxChars: 4 }), {
    text: "…def",
    items: 1,
    truncated: true,
  });
  assert.deepEqual(transcriptText(state([agent("abcdef")]), { last: 1, maxChars: 1 }), { text: "…", items: 1, truncated: true });
});

test("cutting the end of a block never splits a surrogate pair", () => {
  // "agent: x" + 😀 (2 UTF-16 units) + "yz": keeping 3 units would start inside the emoji.
  const result = transcriptText(state([agent("x😀yz")]), { last: 1, maxChars: 4 });
  assert.equal(result.text, "…yz");
  assert.equal(transcriptText(state([agent("x😀yz")]), { last: 1, maxChars: 5 }).text, "…😀yz");
});

// ---------------------------------------------------------------------------
// lastAgentAnswer
// ---------------------------------------------------------------------------

test("lastAgentAnswer is the text of the last agent message, thoughts and later user messages aside", () => {
  const s = state([
    agent("first answer"),
    user("more?"),
    agent([
      { type: "text", text: "Done: " },
      { type: "image", mimeType: "image/png", name: "x.png" },
      { type: "text", text: "see above." },
    ]),
    thought("I am done"),
    tool("t1"),
  ]);
  assert.equal(lastAgentAnswer(s, 1000), "Done: see above.");
  assert.equal(lastAgentAnswer(state([...s.items, user("next question")]), 1000), "Done: see above.");
});

test("lastAgentAnswer is null when there is no agent message, or the last one has no text", () => {
  assert.equal(lastAgentAnswer(state([]), 100), null);
  assert.equal(lastAgentAnswer(state([user("hi"), thought("hmm")]), 100), null);
  assert.equal(lastAgentAnswer(state([agent("earlier"), agent("  ")]), 100), null);
  assert.equal(lastAgentAnswer(state([agent([{ type: "image", mimeType: "image/png" }])]), 100), null);
});

test("lastAgentAnswer keeps the end of a long answer after '…'", () => {
  const s = state([agent("  0123456789  ")]);
  assert.equal(lastAgentAnswer(s, 10), "0123456789");
  assert.equal(lastAgentAnswer(s, 5), "…6789");
  assert.equal(lastAgentAnswer(s, 5)!.length, 5);
});
