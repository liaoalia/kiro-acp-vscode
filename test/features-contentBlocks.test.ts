import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import {
  buildPromptBlocks,
  extractLines,
  fileUrlFor,
  guessMimeType,
  languageForPath,
} from "../src/features/pure/contentBlocks.js";
import {
  globForQuery,
  sanitizeQuery,
  scoreFileMatch,
  sortByScore,
} from "../src/features/pure/fileSearch.js";
import type { ContextChip, ImageAttachment } from "../src/ui/protocol.js";

const abs = path.resolve("/ws/src/app.ts");
const fileChip: ContextChip = {
  id: `file:${abs}`,
  kind: "file",
  path: abs,
  label: "src/app.ts",
  implicit: true,
};
const selChip: ContextChip = {
  id: `sel:${abs}:2-3`,
  kind: "selection",
  path: abs,
  label: "src/app.ts",
  startLine: 2,
  endLine: 3,
  implicit: false,
};
const fakeRead = async (p: string) => {
  if (p !== abs) {
    throw new Error("ENOENT");
  }
  return "line1\nline2\nline3\nline4";
};

test("text block first, then resource_link for file chips", async () => {
  const blocks = await buildPromptBlocks("hello", [fileChip], fakeRead, { embeddedContext: true });
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: "text", text: "hello" });
  assert.deepEqual(blocks[1], {
    type: "resource_link",
    uri: pathToFileURL(abs).href,
    name: "src/app.ts",
    mimeType: "text/typescript",
  });
});

test("empty text produces no text block", async () => {
  const blocks = await buildPromptBlocks("", [fileChip], fakeRead, { embeddedContext: false });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, "resource_link");
});

test("selection becomes an embedded resource when embeddedContext is advertised", async () => {
  const blocks = await buildPromptBlocks("q", [selChip], fakeRead, { embeddedContext: true });
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[1], {
    type: "resource",
    resource: {
      uri: `${pathToFileURL(abs).href}#L2-L3`,
      text: "line2\nline3",
      mimeType: "text/typescript",
    },
  });
});

test("selection becomes a fenced text block otherwise", async () => {
  const blocks = await buildPromptBlocks("q", [selChip], fakeRead, { embeddedContext: false });
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[1], {
    type: "text",
    text: "Selection from src/app.ts:2-3:\n```ts\nline2\nline3\n```",
  });
});

test("unreadable selection degrades to a resource_link; duplicate chips are skipped", async () => {
  const other = path.resolve("/ws/missing.py");
  const chip: ContextChip = { ...selChip, id: `sel:${other}:1-1`, path: other, label: "missing.py", startLine: 1, endLine: 1 };
  const blocks = await buildPromptBlocks("", [chip, chip, fileChip, fileChip], fakeRead, { embeddedContext: true });
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], {
    type: "resource_link",
    uri: pathToFileURL(other).href,
    name: "missing.py",
    mimeType: "text/x-python",
  });
});

test("images go after the text and before the chips, one image block each", async () => {
  const shot = path.resolve("/ws/shot.png");
  const images: ImageAttachment[] = [
    { id: "a", name: "shot.png", mimeType: "image/png", data: "iVBORw0K", size: 6, path: shot, preview: "data:image/png;base64,AAAA" },
    { id: "b", name: "Pasted image 1.png", mimeType: "image/jpeg", data: "/9j/4A==", size: 4 },
  ];
  const blocks = await buildPromptBlocks("look", [fileChip], fakeRead, { embeddedContext: true }, images);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["text", "image", "image", "resource_link"],
  );
  assert.deepEqual(blocks[1], { type: "image", mimeType: "image/png", data: "iVBORw0K", uri: pathToFileURL(shot).href });
  assert.deepEqual(blocks[2], { type: "image", mimeType: "image/jpeg", data: "/9j/4A==" });

  const imageOnly = await buildPromptBlocks("", [], fakeRead, { embeddedContext: false }, images.slice(1));
  assert.deepEqual(imageOnly, [{ type: "image", mimeType: "image/jpeg", data: "/9j/4A==" }]);
});

test("helpers", () => {
  assert.equal(guessMimeType("a.json"), "application/json");
  assert.equal(guessMimeType("a.unknownext"), undefined);
  assert.equal(languageForPath("x.PY"), "python");
  assert.equal(languageForPath("x.weird"), "");
  assert.equal(extractLines("a\r\nb\r\nc", 2, 3), "b\nc");
  assert.equal(extractLines("a\nb", 5, 9), "");
  assert.ok(fileUrlFor(abs).startsWith("file:///"));
});

test("file search glob and ranking", () => {
  assert.equal(sanitizeQuery("src\\app*.ts"), "src/app.ts");
  assert.equal(globForQuery(""), "**/*");
  assert.equal(globForQuery("app"), "**/*app*");
  assert.equal(scoreFileMatch("app", "src/app.ts"), 3);
  assert.equal(scoreFileMatch("app", "src/myapp.ts"), 2);
  assert.equal(scoreFileMatch("src", "src/index.ts"), 1);
  assert.equal(scoreFileMatch("zzz", "src/index.ts"), 0);
  const sorted = sortByScore("app", [
    { label: "lib/other.ts" },
    { label: "src/myapp.ts" },
    { label: "src/app.ts" },
    { label: "app/index.ts" },
  ]);
  assert.deepEqual(
    sorted.map((s) => s.label),
    ["src/app.ts", "src/myapp.ts", "app/index.ts", "lib/other.ts"],
  );
});
