import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PasteNamer,
  fileImageType,
  imageExtension,
  isAttachableDrag,
  isGenericClipboardName,
  isImageFile,
  isWebUri,
  parseUriList,
  pasteAction,
  pastedImageName,
  planAttach,
  previewSize,
} from "../src/webview/attachments.js";
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_PROMPT } from "../src/ui/images.js";

test("a paste attaches images only when the clipboard has no plain text", () => {
  assert.equal(pasteAction({ hasText: false, imageCount: 1 }), "images", "a screenshot");
  assert.equal(pasteAction({ hasText: false, imageCount: 3 }), "images");
  assert.equal(pasteAction({ hasText: true, imageCount: 1 }), "text", "Excel / Word put a bitmap next to the text");
  assert.equal(pasteAction({ hasText: true, imageCount: 0 }), "text");
  assert.equal(pasteAction({ hasText: false, imageCount: 0 }), "text", "nothing to attach: the textarea's default");
});

test("clipboard bitmaps get a numbered name; real file names are kept", () => {
  const namer = new PasteNamer();
  assert.equal(namer.name("image.png", "image/png"), "Pasted image 1.png");
  assert.equal(namer.name("", "image/jpeg"), "Pasted image 2.jpg");
  assert.equal(namer.name("screenshot 2026-11-12.png", "image/png"), "screenshot 2026-11-12.png", "a copied file keeps its name");
  assert.equal(namer.name("IMAGE.PNG", "image/png"), "Pasted image 3.png", "the counter only moves for generated names");
  assert.equal(new PasteNamer().name("image.png", "image/webp"), "Pasted image 1.webp", "each webview counts from 1");

  assert.equal(isGenericClipboardName("image.png"), true);
  assert.equal(isGenericClipboardName("  "), true);
  assert.equal(isGenericClipboardName("image.png.bak.png"), false);
  assert.equal(isGenericClipboardName("my image.png"), false);
  assert.equal(pastedImageName(7, "image/gif"), "Pasted image 7.gif");
});

test("image extensions and file types", () => {
  assert.equal(imageExtension("image/png"), "png");
  assert.equal(imageExtension("image/jpeg"), "jpg");
  assert.equal(imageExtension("IMAGE/WEBP"), "webp");
  assert.equal(imageExtension("image/bmp"), "bmp", "unsupported types still get a sensible name for the notice");
  assert.equal(imageExtension("image/svg+xml"), "svg");
  assert.equal(imageExtension("application/octet-stream"), "img");

  assert.equal(fileImageType("image/PNG", "x"), "image/png");
  assert.equal(fileImageType("image/jpg", "x.jpg"), "image/jpeg", "the non-standard alias is normalised");
  assert.equal(fileImageType("", "photo.JPEG"), "image/jpeg", "no declared type: the extension decides");
  assert.equal(fileImageType("", "notes.txt"), "");

  assert.equal(isImageFile("image/bmp", "a.bmp"), true, "unsupported images are images (they get a notice)");
  assert.equal(isImageFile("", "a.webp"), true);
  assert.equal(isImageFile("text/plain", "a.txt"), false);
  assert.equal(isImageFile("", "folder"), false);
});

test("uri-lists: CRLF or LF, comments and blanks skipped, JSON arrays accepted", () => {
  assert.deepEqual(parseUriList("file:///c%3A/a.png\r\nfile:///c%3A/b.ts\r\n"), ["file:///c%3A/a.png", "file:///c%3A/b.ts"]);
  assert.deepEqual(parseUriList("# comment\n\n  file:///a.png  \n#another\nfile:///b.png"), ["file:///a.png", "file:///b.png"]);
  assert.deepEqual(parseUriList('["file:///a.png", " file:///b.ts ", 3, null, ""]'), ["file:///a.png", "file:///b.ts"]);
  assert.deepEqual(parseUriList("[not json\nfile:///a.png"), ["[not json", "file:///a.png"], "broken JSON is read as lines");
  assert.deepEqual(parseUriList("file:///a.png\nfile:///a.png"), ["file:///a.png"], "duplicates once");
  assert.deepEqual(parseUriList(""), []);
  assert.deepEqual(parseUriList("\r\n# only a comment\r\n"), []);
});

test("drags with files or uri-lists are the composer's; web links stay text", () => {
  assert.equal(isAttachableDrag(["Files"]), true);
  assert.equal(isAttachableDrag(["text/plain", "text/uri-list"]), true);
  assert.equal(isAttachableDrag(["application/vnd.code.uri-list", "text/plain"]), true);
  assert.equal(isAttachableDrag(["text/plain", "text/html"]), false);
  assert.equal(isAttachableDrag([]), false);

  assert.equal(isWebUri("https://example.com/a.png"), true);
  assert.equal(isWebUri("HTTP://example.com"), true);
  assert.equal(isWebUri("file:///c%3A/a.png"), false);
  assert.equal(isWebUri("vscode-remote://ssh-remote+box/home/a.png"), false);
});

const img = (name: string, mimeType = "image/png", size = 1000, path?: string) => ({ name, mimeType, size, path });

test("the attach plan checks type and size, then the count limit", () => {
  const plan = planAttach([img("a.png"), img("b.bmp", "image/bmp"), img("c.png", "image/png", MAX_IMAGE_BYTES + 1), img("d.gif", "image/gif")], 0);
  assert.deepEqual(plan.accepted.map((i) => i.name), ["a.png", "d.gif"]);
  assert.equal(plan.notices.length, 2);
  assert.match(plan.notices[0]!, /^b\.bmp was not attached: only PNG, JPEG, GIF and WebP/);
  assert.match(plan.notices[1]!, /^c\.png was not attached: it is [\d.]+ MB, images up to 5 MB can be sent\.$/);

  const empty = planAttach([img("e.png", "image/png", 0)], 0);
  assert.deepEqual(empty.accepted, []);
  assert.match(empty.notices[0]!, /the file is empty/);
});

test("the count limit counts the images already attached and names a single overflow", () => {
  const full = planAttach([img("a.png"), img("b.png")], MAX_IMAGES_PER_PROMPT - 1);
  assert.deepEqual(full.accepted.map((i) => i.name), ["a.png"]);
  assert.deepEqual(full.notices, [`b.png was not attached: up to ${MAX_IMAGES_PER_PROMPT} images can be sent with one prompt.`]);

  const many = planAttach([img("a.png"), img("b.png"), img("c.png")], 0, [], 1);
  assert.deepEqual(many.accepted.map((i) => i.name), ["a.png"]);
  assert.deepEqual(many.notices, ["2 images were not attached: up to 1 images can be sent with one prompt."]);

  const rejectedFirst = planAttach([img("x.tiff", "image/tiff"), img("a.png")], MAX_IMAGES_PER_PROMPT - 1);
  assert.deepEqual(rejectedFirst.accepted.map((i) => i.name), ["a.png"], "a rejected image takes no slot");
});

test("an image already attached from the same path is skipped silently", () => {
  const plan = planAttach([img("a.png", "image/png", 10, "/w/a.png"), img("b.png", "image/png", 10, "/w/b.png"), img("b.png", "image/png", 10, "/w/b.png")], 1, ["/w/a.png"]);
  assert.deepEqual(plan.accepted.map((i) => i.path), ["/w/b.png"]);
  assert.deepEqual(plan.notices, []);
  const pasted = planAttach([img("Pasted image 1.png"), img("Pasted image 1.png")], 0);
  assert.equal(pasted.accepted.length, 2, "images without a path are never deduplicated");
});

test("thumbnail size: longest side at most 320 px, never upscaled", () => {
  assert.deepEqual(previewSize(1920, 1080), { width: 320, height: 180 });
  assert.deepEqual(previewSize(1080, 1920), { width: 180, height: 320 });
  assert.deepEqual(previewSize(200, 100), { width: 200, height: 100 });
  assert.deepEqual(previewSize(5000, 3), { width: 320, height: 1 }, "never 0 px");
  assert.deepEqual(previewSize(640, 640, 64), { width: 64, height: 64 });
});
