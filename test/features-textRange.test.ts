import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAbsolutePath,
  isWithinRoot,
  normalizeFsPath,
  sliceLines,
} from "../src/features/pure/textRange.js";

const text = "one\ntwo\r\nthree\nfour";

test("sliceLines returns the whole text when no range is given", () => {
  assert.equal(sliceLines(text), text);
  assert.equal(sliceLines(text, null, null), text);
  assert.equal(sliceLines(text, 1), text);
});

test("sliceLines applies 1-based start and limit, preserving line endings", () => {
  assert.equal(sliceLines(text, 2), "two\r\nthree\nfour");
  assert.equal(sliceLines(text, 2, 2), "two\r\nthree\n");
  assert.equal(sliceLines(text, 1, 1), "one\n");
  assert.equal(sliceLines(text, 4, 10), "four");
  assert.equal(sliceLines(text, undefined, 1), "one\n");
});

test("sliceLines beyond the end or with a non-positive limit yields empty", () => {
  assert.equal(sliceLines(text, 5), "");
  assert.equal(sliceLines(text, 99, 3), "");
  assert.equal(sliceLines(text, 1, 0), "");
  assert.equal(sliceLines("", 1, 5), "");
});

test("sliceLines with a trailing newline keeps the terminator", () => {
  assert.equal(sliceLines("a\nb\n", 2), "b\n");
  assert.equal(sliceLines("a\nb\n", 3), "");
});

test("normalizeFsPath lower-cases the drive and uses backslashes on win32", () => {
  assert.equal(normalizeFsPath("C:/Users/Me/file.txt", "win32"), "c:\\Users\\Me\\file.txt");
  assert.equal(normalizeFsPath("c:\\Users\\Me\\..\\file.txt", "win32"), "c:\\Users\\file.txt");
  assert.equal(normalizeFsPath("C:\\dir\\", "win32"), "c:\\dir");
  assert.equal(normalizeFsPath("C:\\", "win32"), "c:\\");
  assert.equal(
    normalizeFsPath("C:/a/b", "win32"),
    normalizeFsPath("c:\\a\\b", "win32"),
    "equal paths normalise identically",
  );
});

test("normalizeFsPath resolves dot segments on posix", () => {
  assert.equal(normalizeFsPath("/home/me/./src/../file.ts", "posix"), "/home/me/file.ts");
  assert.equal(normalizeFsPath("/home/me/", "posix"), "/home/me");
  assert.equal(normalizeFsPath("/", "posix"), "/");
});

test("isAbsolutePath", () => {
  assert.equal(isAbsolutePath("C:\\x", "win32"), true);
  assert.equal(isAbsolutePath("x\\y", "win32"), false);
  assert.equal(isAbsolutePath("/x", "posix"), true);
  assert.equal(isAbsolutePath("x/y", "posix"), false);
  assert.equal(isAbsolutePath("", "posix"), false);
});

test("isWithinRoot", () => {
  assert.equal(isWithinRoot("C:\\ws\\src\\a.ts", "c:/ws", "win32"), true);
  assert.equal(isWithinRoot("C:\\ws", "C:\\ws\\", "win32"), true);
  assert.equal(isWithinRoot("C:\\ws2\\a.ts", "C:\\ws", "win32"), false, "sibling prefix");
  assert.equal(isWithinRoot("D:\\ws\\a.ts", "C:\\ws", "win32"), false);
  assert.equal(isWithinRoot("/ws/src/a.ts", "/ws", "posix"), true);
  assert.equal(isWithinRoot("/wsx/a.ts", "/ws", "posix"), false);
});
