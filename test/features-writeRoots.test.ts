import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WRITE_ROOTS, expandWriteRoot, matchWriteRoot, type WriteRootContext } from "../src/features/pure/writeRoots.js";

const win: WriteRootContext = {
  tmpdir: "C:\\Users\\me\\AppData\\Local\\Temp",
  home: "C:\\Users\\me",
  env: { SCRATCH: "D:\\scratch", EMPTY: "" },
  platform: "win32",
};
const posix: WriteRootContext = { tmpdir: "/tmp", home: "/home/me", env: { SCRATCH: "/srv/scratch" }, platform: "posix" };

test("expandWriteRoot resolves ${tmpdir}, ~, ${home} and ${env:NAME}", () => {
  assert.equal(expandWriteRoot("${tmpdir}", win), "c:\\Users\\me\\AppData\\Local\\Temp");
  assert.equal(expandWriteRoot("~/notes", posix), "/home/me/notes");
  assert.equal(expandWriteRoot("~", posix), "/home/me");
  assert.equal(expandWriteRoot("~\\notes", win), "c:\\Users\\me\\notes");
  assert.equal(expandWriteRoot("${home}/x", posix), "/home/me/x");
  assert.equal(expandWriteRoot("${env:SCRATCH}\\kiro", win), "d:\\scratch\\kiro");
  assert.equal(expandWriteRoot("  /opt/out/  ", posix), "/opt/out");
});

test("expandWriteRoot ignores what it cannot resolve to an absolute path", () => {
  assert.equal(expandWriteRoot("${env:MISSING}/x", posix), null, "unknown variable");
  assert.equal(expandWriteRoot("${env:EMPTY}\\x", win), null, "empty variable");
  assert.equal(expandWriteRoot("${nope}", posix), null, "unknown placeholder");
  assert.equal(expandWriteRoot("relative/dir", posix), null);
  assert.equal(expandWriteRoot("", posix), null);
  assert.equal(expandWriteRoot(42, posix), null);
  assert.equal(expandWriteRoot(null, posix), null);
});

test("matchWriteRoot: the default allows the temp folder and nothing else", () => {
  assert.deepEqual([...DEFAULT_WRITE_ROOTS], ["${tmpdir}"]);
  assert.equal(
    matchWriteRoot("C:\\Users\\me\\AppData\\Local\\Temp\\kiro-1\\plan.md", DEFAULT_WRITE_ROOTS, win),
    "c:\\Users\\me\\AppData\\Local\\Temp",
  );
  assert.equal(matchWriteRoot("c:\\users\\ME\\appdata\\local\\temp\\a.txt", DEFAULT_WRITE_ROOTS, win) !== null, true, "case-insensitive on Windows");
  assert.equal(matchWriteRoot("C:\\Users\\me\\AppData\\Local\\TempOther\\a.txt", DEFAULT_WRITE_ROOTS, win), null, "a sibling with the same prefix");
  assert.equal(matchWriteRoot("C:\\Users\\me\\Documents\\a.txt", DEFAULT_WRITE_ROOTS, win), null);
  assert.equal(matchWriteRoot("/tmp/x/y.txt", DEFAULT_WRITE_ROOTS, posix), "/tmp");
  assert.equal(matchWriteRoot("/tmpfoo/y.txt", DEFAULT_WRITE_ROOTS, posix), null);
});

test("matchWriteRoot: several roots, unusable entries skipped, empty list allows nothing", () => {
  const roots = ["${env:MISSING}", 7, "relative", "/srv/out", "${env:SCRATCH}"];
  assert.equal(matchWriteRoot("/srv/scratch/a/b.txt", roots, posix), "/srv/scratch");
  assert.equal(matchWriteRoot("/srv/out/b.txt", roots, posix), "/srv/out");
  assert.equal(matchWriteRoot("/srv/other/b.txt", roots, posix), null);
  assert.equal(matchWriteRoot("/tmp/a.txt", [], posix), null);
});
