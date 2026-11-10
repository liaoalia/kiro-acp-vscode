import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LinePrefixer,
  commandTerminalName,
  concurrentPrefix,
  exitLabel,
  formatCommandHeader,
  formatExitFooter,
  makeRunId,
  makeTerminalId,
  parseTerminalMode,
  pickInputTarget,
  sharedTerminalName,
  shortSessionId,
  shouldMirrorOutput,
} from "../src/features/pure/terminalPresentation.js";
import { stripAnsi } from "../src/features/pure/outputBuffer.js";

test("makeTerminalId is term-<runId>-<n>", () => {
  assert.equal(makeTerminalId("ab12cd", 1), "term-ab12cd-1");
  assert.equal(makeTerminalId("ab12cd", 42), "term-ab12cd-42");
  assert.match(makeTerminalId(makeRunId(), 7), /^term-[A-Za-z0-9]+-\d+$/);
});

test("makeRunId yields distinct ids per run so two service instances never share terminal ids", () => {
  const runA = makeRunId();
  const runB = makeRunId();
  assert.match(runA, /^[a-z0-9]{6}$/);
  assert.notEqual(runA, runB);
  // The same counter value in two runs (an extension-host restart) is a different terminal id.
  assert.notEqual(makeTerminalId(runA, 1), makeTerminalId(runB, 1));
  assert.notEqual(makeTerminalId(runA, 1), "term-1");
  assert.equal(makeRunId(10).length, 10);
});

test("parseTerminalMode accepts the enum values", () => {
  assert.equal(parseTerminalMode("shared"), "shared");
  assert.equal(parseTerminalMode("perCommand"), "perCommand");
  assert.equal(parseTerminalMode("hidden"), "hidden");
});

test("parseTerminalMode is lenient about case and separators", () => {
  assert.equal(parseTerminalMode("per-command"), "perCommand");
  assert.equal(parseTerminalMode("PER_COMMAND"), "perCommand");
  assert.equal(parseTerminalMode("Shared "), "shared");
  assert.equal(parseTerminalMode("Hidden"), "hidden");
});

test("parseTerminalMode maps legacy booleans and synonyms", () => {
  assert.equal(parseTerminalMode(true), "perCommand");
  assert.equal(parseTerminalMode(false), "hidden");
  assert.equal(parseTerminalMode("none"), "hidden");
  assert.equal(parseTerminalMode("off"), "hidden");
  assert.equal(parseTerminalMode("session"), "shared");
  assert.equal(parseTerminalMode("visible"), "perCommand");
});

test("parseTerminalMode falls back to shared for unknown values", () => {
  assert.equal(parseTerminalMode(undefined), "shared");
  assert.equal(parseTerminalMode(null), "shared");
  assert.equal(parseTerminalMode(42), "shared");
  assert.equal(parseTerminalMode("banana"), "shared");
  assert.equal(parseTerminalMode(""), "shared");
});

test("shortSessionId keeps the first UUID group or 12 characters", () => {
  assert.equal(shortSessionId("0b8e2f4a-1234-5678-9abc-def012345678"), "0b8e2f4a");
  assert.equal(shortSessionId("0B8E2F4A-1234-5678-9ABC-DEF012345678"), "0B8E2F4A");
  assert.equal(shortSessionId("sess_abcdefghijkl"), "sess_abcdefg");
  assert.equal(shortSessionId("sess-3"), "sess-3");
  assert.equal(shortSessionId("sess-12"), "sess-12");
  assert.equal(shortSessionId("   "), "session");
});

test("sharedTerminalName uses the title when given, else the short id", () => {
  assert.equal(sharedTerminalName("0b8e2f4a-1234-5678-9abc-def012345678"), "Kiro · 0b8e2f4a");
  assert.equal(sharedTerminalName("sess-7"), "Kiro · sess-7");
  assert.equal(sharedTerminalName("0b8e2f4a-1234-", "Fix the  build\n"), "Kiro · Fix the build");
  assert.equal(sharedTerminalName("0b8e2f4a-1234-", "   "), "Kiro · 0b8e2f4a");
  assert.equal(sharedTerminalName("0b8e2f4a-1234-", null), "Kiro · 0b8e2f4a");
  const long = sharedTerminalName("x", "a".repeat(60));
  assert.equal(long, `Kiro · ${"a".repeat(39)}…`);
});

test("commandTerminalName collapses whitespace and truncates", () => {
  assert.equal(commandTerminalName("npm   test\n"), "Kiro: npm test");
  assert.equal(commandTerminalName("x".repeat(50)), `Kiro: ${"x".repeat(39)}…`);
});

test("formatCommandHeader writes a styled line with the command and cwd", () => {
  const header = formatCommandHeader("npm test", "C:\\repo");
  assert.ok(header.startsWith("\r\n"), "starts with a blank line");
  assert.ok(header.endsWith("\r\n"), "ends with a line break");
  assert.equal(stripAnsi(header), "\r\n$ npm test   [C:\\repo]\r\n");
  assert.ok(header.includes("\x1b[1;2m"), "bold+dim style");
  assert.ok(header.includes("\x1b[0m"), "style reset");
  assert.equal(stripAnsi(formatCommandHeader("ls", "")), "\r\n$ ls\r\n");
});

test("exitLabel and formatExitFooter describe exit codes and signals", () => {
  assert.equal(exitLabel({ exitCode: 0, signal: null }), "[exit code 0]");
  assert.equal(exitLabel({ exitCode: 2, signal: null }), "[exit code 2]");
  assert.equal(exitLabel({ exitCode: null, signal: "SIGTERM" }), "[terminated by SIGTERM]");
  assert.equal(exitLabel({ exitCode: null, signal: null }), "[exit code unknown]");
  assert.equal(stripAnsi(formatExitFooter({ exitCode: 1, signal: null })), "\r\n[exit code 1]\r\n");
  assert.ok(formatExitFooter({ exitCode: 1, signal: null }).includes("\x1b[2m"), "dim style");
});

test("pickInputTarget chooses the most recently started running child", () => {
  const a = { id: "term-1", seq: 1, running: true };
  const b = { id: "term-2", seq: 2, running: true };
  const c = { id: "term-3", seq: 3, running: false };
  assert.equal(pickInputTarget([a, b, c]), b);
  assert.equal(pickInputTarget([c, b, a]), b);
  assert.equal(pickInputTarget([a]), a);
  assert.equal(pickInputTarget([c]), undefined);
  assert.equal(pickInputTarget([]), undefined);
});

test("LinePrefixer prefixes line starts across chunk boundaries", () => {
  const p = new LinePrefixer(concurrentPrefix("term-2"));
  assert.equal(p.apply("one\r\ntwo"), "[term-2] one\r\n[term-2] two");
  assert.equal(p.apply(" continued\n"), " continued\n");
  assert.equal(p.apply("three"), "[term-2] three");
  assert.equal(p.apply(""), "");
  assert.equal(p.apply("\r\n\r\n"), "\r\n\r\n");
  assert.equal(p.apply("four"), "[term-2] four");
});

test("LinePrefixer with an empty prefix is the identity", () => {
  const p = new LinePrefixer("");
  assert.equal(p.apply("a\nb"), "a\nb");
});

test("shouldMirrorOutput cuts a released command off the shared terminal only", () => {
  assert.equal(shouldMirrorOutput({ mode: "shared", released: false }), true);
  assert.equal(shouldMirrorOutput({ mode: "shared", released: true }), false);
  // A per-command tab belongs to the command: a survivor's late output stays attributable there.
  assert.equal(shouldMirrorOutput({ mode: "perCommand", released: false }), true);
  assert.equal(shouldMirrorOutput({ mode: "perCommand", released: true }), true);
  // Hidden mode writes nowhere anyway; the flag does not matter.
  assert.equal(shouldMirrorOutput({ mode: "hidden", released: false }), true);
  assert.equal(shouldMirrorOutput({ mode: "hidden", released: true }), true);
});
