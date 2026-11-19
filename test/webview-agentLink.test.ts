import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ORIGIN_TITLE_MAX,
  normalizeOrigin,
  originKey,
  originLabel,
  sessionHandle,
  truncateTitle,
  withHandle,
} from "../src/webview/agentLinkText.js";

test("normalizeOrigin needs a session id and fills a missing handle or title with \"\"", () => {
  const origin = { sessionId: "sess-2", handle: " s2 ", title: "Fix it" };
  const copy = normalizeOrigin(origin);
  assert.deepEqual(copy, { sessionId: "sess-2", handle: "s2", title: "Fix it" });
  assert.notEqual(copy, origin);
  assert.deepEqual(normalizeOrigin({ sessionId: "sess-2", handle: 3, title: null }), { sessionId: "sess-2", handle: "", title: "" });
  assert.equal(normalizeOrigin({ handle: "s2", title: "x" }), undefined);
  assert.equal(normalizeOrigin({ sessionId: "", handle: "s2", title: "x" }), undefined);
  assert.equal(normalizeOrigin(null), undefined);
  assert.equal(normalizeOrigin(undefined), undefined);
  assert.equal(normalizeOrigin("sess-2"), undefined);
});

test("originKey tells origins apart and is empty without one", () => {
  const a = { sessionId: "sess-2", handle: "s2", title: "Fix it" };
  assert.equal(originKey(a), originKey({ ...a }));
  assert.notEqual(originKey(a), originKey({ ...a, title: "Fix it again" }));
  assert.notEqual(originKey(a), originKey({ ...a, handle: "s3" }));
  assert.notEqual(originKey(a), originKey({ ...a, sessionId: "sess-3" }));
  assert.equal(originKey(undefined), "");
  assert.equal(originKey({ handle: "s2" }), "");
});

test("truncateTitle flattens whitespace and cuts long titles with an ellipsis", () => {
  assert.equal(truncateTitle("  Fix\n the   login bug "), "Fix the login bug");
  assert.equal(truncateTitle(""), "");
  const exact = "x".repeat(ORIGIN_TITLE_MAX);
  assert.equal(truncateTitle(exact), exact);
  const cut = truncateTitle("y".repeat(ORIGIN_TITLE_MAX + 10));
  assert.equal(Array.from(cut).length, ORIGIN_TITLE_MAX);
  assert.ok(cut.endsWith("…"));
  assert.equal(truncateTitle("abcdef ghij", 8), "abcdef…", "no trailing space before the ellipsis");
  // Cut by code points: an emoji is never split in half.
  assert.equal(truncateTitle("😀😀😀😀", 3), "😀😀…");
});

test("originLabel: handle, truncated title, full title on hover and an accessible name", () => {
  const long = "Refactor the authentication middleware so that sessions expire properly";
  const label = originLabel({ sessionId: "sess-2", handle: "s2", title: long });
  assert.equal(label.handle, "s2");
  assert.equal(label.title, truncateTitle(long));
  assert.ok(label.title.endsWith("…"));
  assert.ok(label.tooltip.includes(`s2 · ${long}`), "the hover shows the full title");
  assert.equal(label.ariaLabel, `Show the session that sent this message (s2 ${long})`);

  const short = originLabel({ sessionId: "sess-2", handle: "s2", title: "Fix the login bug" });
  assert.equal(short.title, "Fix the login bug");
  assert.equal(short.ariaLabel, "Show the session that sent this message (s2 Fix the login bug)");

  const noTitle = originLabel({ sessionId: "sess-2", handle: "s2", title: "  " });
  assert.equal(noTitle.title, "");
  assert.equal(noTitle.ariaLabel, "Show the session that sent this message (s2)");

  const nothing = originLabel({ sessionId: "sess-2", handle: "", title: "" });
  assert.equal(nothing.ariaLabel, "Show the session that sent this message");
  assert.ok(nothing.tooltip.startsWith("Sent by another agent session\n"));
});

test("session handles: trimmed when present, the title unchanged when absent", () => {
  assert.equal(sessionHandle(" s3 "), "s3");
  assert.equal(sessionHandle(undefined), "");
  assert.equal(sessionHandle(3), "");
  assert.equal(withHandle("s3", "Fix the login bug"), "s3 · Fix the login bug");
  assert.equal(withHandle(undefined, "Fix the login bug"), "Fix the login bug");
  assert.equal(withHandle("  ", "New session"), "New session");
});
