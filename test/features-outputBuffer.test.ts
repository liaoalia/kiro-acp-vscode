import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OutputBuffer,
  buildShellCommand,
  dropLeadingBytes,
  mergeEnv,
  quoteArg,
  stripAnsi,
  toPtyText,
} from "../src/features/pure/outputBuffer.js";

test("OutputBuffer keeps everything under the limit", () => {
  const buf = new OutputBuffer(100);
  buf.append("hello ");
  buf.append("world");
  assert.equal(buf.text, "hello world");
  assert.equal(buf.truncated, false);
  assert.equal(buf.byteLength, 11);
});

test("OutputBuffer drops the oldest bytes when over the limit", () => {
  const buf = new OutputBuffer(8);
  buf.append("abcd");
  buf.append("efgh");
  buf.append("ij");
  assert.equal(buf.text, "cdefghij");
  assert.equal(buf.truncated, true);
  assert.equal(buf.byteLength, 8);
});

test("OutputBuffer drops whole old chunks first", () => {
  const buf = new OutputBuffer(5);
  buf.append("12345");
  buf.append("67890");
  assert.equal(buf.text, "67890");
  buf.append("ab");
  assert.equal(buf.text, "890ab");
});

test("OutputBuffer cuts on a character boundary (multi-byte UTF-8)", () => {
  const buf = new OutputBuffer(6);
  buf.append("é"); // 2 bytes
  buf.append("日本"); // 6 bytes → total 8, need to drop 2 → exactly the "é"
  assert.equal(buf.text, "日本");
  buf.append("x"); // 7 bytes → drop 1 byte: must drop whole "日" (3 bytes)
  assert.equal(buf.text, "本x");
  assert.ok(buf.byteLength <= 6);
  assert.equal(buf.truncated, true);
});

test("OutputBuffer with a single oversized chunk keeps its tail", () => {
  const buf = new OutputBuffer(3);
  buf.append("abcdef");
  assert.equal(buf.text, "def");
});

test("OutputBuffer with non-positive limit is unbounded", () => {
  const buf = new OutputBuffer(0);
  buf.append("x".repeat(1000));
  assert.equal(buf.text.length, 1000);
  assert.equal(buf.truncated, false);
});

test("dropLeadingBytes", () => {
  assert.equal(dropLeadingBytes("abc", 0), "abc");
  assert.equal(dropLeadingBytes("abc", 1), "bc");
  assert.equal(dropLeadingBytes("abc", 5), "");
  assert.equal(dropLeadingBytes("日本", 1), "本");
  assert.equal(dropLeadingBytes("😀a", 2), "a", "4-byte emoji dropped whole");
});

test("stripAnsi removes CSI and OSC sequences", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m plain"), "red plain");
  assert.equal(stripAnsi("\x1b]0;title\x07text"), "text");
  assert.equal(stripAnsi("\x1b]0;title\x1b\\text"), "text");
  assert.equal(stripAnsi("\x1b[2K\x1b[1Gline"), "line");
  assert.equal(stripAnsi("no escapes"), "no escapes");
});

test("quoteArg", () => {
  assert.equal(quoteArg("plain", "posix"), "plain");
  assert.equal(quoteArg("has space", "posix"), "'has space'");
  assert.equal(quoteArg("it's", "posix"), `'it'\\''s'`);
  assert.equal(quoteArg("plain", "win32"), "plain");
  assert.equal(quoteArg("has space", "win32"), '"has space"');
  assert.equal(quoteArg('say "hi"', "win32"), '"say \\"hi\\""');
  assert.equal(quoteArg("", "win32"), '""');
  assert.equal(quoteArg("", "posix"), "''");
});

test("buildShellCommand passes bare commands through and quotes args", () => {
  assert.equal(buildShellCommand("npm test && echo ok", undefined, "posix"), "npm test && echo ok");
  assert.equal(buildShellCommand("git", ["commit", "-m", "two words"], "posix"), "git commit -m 'two words'");
  assert.equal(buildShellCommand("git", ["commit", "-m", "two words"], "win32"), 'git commit -m "two words"');
  assert.equal(buildShellCommand("C:\\Program Files\\x.exe", ["a"], "win32"), '"C:\\Program Files\\x.exe" a');
});

test("mergeEnv overrides and is case-insensitive on win32", () => {
  const base = { Path: "/a", HOME: "/h" };
  const posix = mergeEnv(base, [{ name: "PATH", value: "/b" }], "posix");
  assert.equal(posix.Path, "/a");
  assert.equal(posix.PATH, "/b");
  const win = mergeEnv(base, [{ name: "PATH", value: "/b" }], "win32");
  assert.equal(win.Path, undefined);
  assert.equal(win.PATH, "/b");
  assert.equal(win.HOME, "/h");
  assert.deepEqual(mergeEnv(base, null, "posix"), base);
});

test("toPtyText converts newlines", () => {
  assert.equal(toPtyText("a\nb\r\nc\n"), "a\r\nb\r\nc\r\n");
});
