import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkImageAttachment,
  echoImageContent,
  imageAttachmentFromBytes,
  imageBlock,
  sniffImageType,
} from "../src/features/pure/images.js";
import {
  MAX_IMAGE_BYTES,
  MAX_INLINE_PREVIEW_CHARS,
  imageDataVerdict,
  sniffBase64ImageType,
} from "../src/ui/images.js";
import type { ImageAttachment } from "../src/ui/protocol.js";

/** A real 1×1 PNG. */
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_1PX, "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const GIF87 = Buffer.from("GIF87a\x01\x00\x01\x00\x00\x00", "latin1");
const GIF89 = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00", "latin1");
const WEBP = Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "latin1");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', "utf8");

function attachment(bytes: Buffer | string, overrides: Partial<ImageAttachment> = {}): ImageAttachment {
  const data = typeof bytes === "string" ? bytes : bytes.toString("base64");
  return { id: "img-1", name: "shot.png", mimeType: "image/png", data, size: 1, ...overrides };
}

test("sniffImageType recognises PNG, JPEG, GIF87a/89a and WebP by their magic bytes", () => {
  assert.equal(sniffImageType(PNG), "image/png");
  assert.equal(sniffImageType(JPEG), "image/jpeg");
  assert.equal(sniffImageType(GIF87), "image/gif");
  assert.equal(sniffImageType(GIF89), "image/gif");
  assert.equal(sniffImageType(WEBP), "image/webp");
});

test("sniffBase64ImageType (the webview's check) agrees with sniffImageType on every format and on junk", () => {
  const cases: Array<[Buffer, string | undefined]> = [
    [PNG, "image/png"],
    [JPEG, "image/jpeg"],
    [GIF87, "image/gif"],
    [GIF89, "image/gif"],
    [WEBP, "image/webp"],
    [SVG, undefined],
    [Buffer.from("hello world, not an image"), undefined],
    [Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "latin1"), undefined],
  ];
  for (const [bytes, expected] of cases) {
    assert.equal(sniffBase64ImageType(bytes.toString("base64")), expected, bytes.subarray(0, 12).toString("latin1"));
    assert.equal(sniffBase64ImageType(bytes.toString("base64")), sniffImageType(bytes));
  }
  // Every byte offset of the 12-byte prefix decodes right, including a short (padded) buffer.
  assert.equal(sniffBase64ImageType(Buffer.from([0xff, 0xd8, 0xff]).toString("base64")), "image/jpeg");
  assert.equal(sniffBase64ImageType(""), undefined);
  assert.equal(sniffBase64ImageType("data:image/png;base64,iVBORw0KGgo"), undefined, "a data: URL is not plain base64");
  assert.equal(sniffBase64ImageType("iVBOR w0KGgo"), undefined, "whitespace in the prefix");
});

test("imageDataVerdict: the bytes decide the type, the length the size; the reasons match the host's", () => {
  const ok = imageDataVerdict("shot.jpg", PNG_1PX, "image/jpeg");
  assert.deepEqual(ok, { ok: true, mimeType: "image/png", size: PNG.length }, "a PNG named .jpg is a PNG");

  const renamed = imageDataVerdict("photo.png", Buffer.from("not really a png").toString("base64"), "image/png");
  assert.equal(renamed.ok, false);
  assert.match(!renamed.ok ? renamed.reason : "", /^photo\.png was not attached: it is not a PNG, JPEG, GIF or WebP image\.$/);

  const svg = imageDataVerdict("logo.svg", SVG.toString("base64"), "image/svg+xml");
  assert.match(!svg.ok ? svg.reason : "", /only PNG, JPEG, GIF and WebP/);

  const empty = imageDataVerdict("empty.png", "", "image/png");
  assert.match(!empty.ok ? empty.reason : "", /the file is empty/);

  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  PNG.copy(big);
  const tooBig = imageDataVerdict("big.png", big.toString("base64"), "image/png");
  assert.match(!tooBig.ok ? tooBig.reason : "", /^big\.png was not attached: it is 5\.1 MB, images up to 5 MB can be sent\.$/);

  // The host's send check gives the very same verdicts.
  for (const [name, data, type] of [
    ["photo.png", Buffer.from("not really a png").toString("base64"), "image/png"],
    ["big.png", big.toString("base64"), "image/png"],
    ["shot.jpg", PNG_1PX, "image/jpeg"],
  ] as const) {
    assert.deepEqual(checkImageAttachment(attachment(data, { name, mimeType: type })), imageDataVerdict(name, data, type));
  }
});

test("sniffImageType rejects junk, short buffers and other RIFF files", () => {
  assert.equal(sniffImageType(new Uint8Array()), undefined);
  assert.equal(sniffImageType(SVG), undefined);
  assert.equal(sniffImageType(Buffer.from("hello world, not an image")), undefined);
  assert.equal(sniffImageType(PNG.subarray(0, 7)), undefined);
  assert.equal(sniffImageType(Buffer.from("RIFF", "latin1")), undefined);
  assert.equal(sniffImageType(Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "latin1")), undefined);
  assert.equal(sniffImageType(Buffer.from("GIF88a\x01\x00", "latin1")), undefined);
});

test("checkImageAttachment accepts a valid image with its real decoded size", () => {
  assert.deepEqual(checkImageAttachment(attachment(PNG, { size: 999 })), {
    ok: true,
    mimeType: "image/png",
    size: PNG.length,
  });
  assert.deepEqual(checkImageAttachment(attachment(WEBP, { mimeType: "image/webp" })), {
    ok: true,
    mimeType: "image/webp",
    size: WEBP.length,
  });
});

test("checkImageAttachment: the sniffed type wins over the declared one", () => {
  const check = checkImageAttachment(attachment(JPEG, { mimeType: "image/png" }));
  assert.deepEqual(check, { ok: true, mimeType: "image/jpeg", size: JPEG.length });
  // A declared type that is not accepted is corrected too when the bytes are an accepted image.
  const svgLabel = checkImageAttachment(attachment(GIF89, { mimeType: "image/svg+xml" }));
  assert.deepEqual(svgLabel, { ok: true, mimeType: "image/gif", size: GIF89.length });
});

test("checkImageAttachment rejects other image types and unrecognised bytes", () => {
  const svg = checkImageAttachment(attachment(SVG, { name: "logo.svg", mimeType: "image/svg+xml" }));
  assert.equal(svg.ok, false);
  assert.match(!svg.ok ? svg.reason : "", /^logo\.svg was not attached: only PNG, JPEG, GIF and WebP/);

  const junk = checkImageAttachment(attachment(Buffer.from("not really a png at all")));
  assert.equal(junk.ok, false);
  assert.equal(!junk.ok && junk.reason, "shot.png was not attached: it is not a PNG, JPEG, GIF or WebP image.");
});

test("checkImageAttachment rejects an image over the size limit by its decoded size", () => {
  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1024 * 1024);
  PNG.copy(big);
  const check = checkImageAttachment(attachment(big, { size: 10 }));
  assert.deepEqual(check, {
    ok: false,
    reason: "shot.png was not attached: it is 6 MB, images up to 5 MB can be sent.",
  });
  // One byte over is refused; exactly at the limit is fine.
  assert.equal(checkImageAttachment(attachment(big.subarray(0, MAX_IMAGE_BYTES + 1))).ok, false);
  const max = checkImageAttachment(attachment(big.subarray(0, MAX_IMAGE_BYTES)));
  assert.deepEqual(max, { ok: true, mimeType: "image/png", size: MAX_IMAGE_BYTES });
});

test("checkImageAttachment rejects data that is not plain base64", () => {
  const reason = "shot.png was not attached: its data is not valid base64.";
  for (const data of [`data:image/png;base64,${PNG_1PX}`, PNG_1PX.slice(1), `${PNG_1PX.slice(0, 8)} ${PNG_1PX.slice(8, 15)}`, "ab=c", "a===", "#$%^"]) {
    const check = checkImageAttachment(attachment(data));
    assert.deepEqual(check, { ok: false, reason }, `data ${JSON.stringify(data.slice(0, 30))}`);
  }
  const notString = checkImageAttachment({ ...attachment(PNG), data: undefined as unknown as string });
  assert.equal(notString.ok, false);
});

test("checkImageAttachment rejects an empty image and names unnamed ones generically", () => {
  assert.deepEqual(checkImageAttachment(attachment("")), {
    ok: false,
    reason: "shot.png was not attached: the file is empty.",
  });
  const unnamed = checkImageAttachment(attachment(SVG, { name: "" }));
  assert.match(!unnamed.ok ? unnamed.reason : "", /^An image was not attached/);
});

test("imageAttachmentFromBytes builds an attachment from a file's bytes", () => {
  const abs = path.resolve("/ws/pics/shot.png");
  const read = imageAttachmentFromBytes("host-img-1", "shot.png", new Uint8Array(JPEG), abs);
  assert.deepEqual(read, {
    ok: true,
    image: { id: "host-img-1", name: "shot.png", mimeType: "image/jpeg", data: JPEG.toString("base64"), size: JPEG.length, path: abs },
  });
  const noPath = imageAttachmentFromBytes("host-img-2", "a.gif", GIF89);
  assert.ok(noPath.ok && !("path" in noPath.image));
  // A view into a larger buffer encodes only its own bytes.
  const backing = Buffer.concat([Buffer.from("xxxx"), PNG, Buffer.from("yyyy")]);
  const slice = imageAttachmentFromBytes("host-img-3", "p.png", backing.subarray(4, 4 + PNG.length));
  assert.ok(slice.ok && slice.image.data === PNG_1PX);
});

test("imageAttachmentFromBytes applies the same rules", () => {
  const svg = imageAttachmentFromBytes("i", "logo.svg", SVG);
  assert.match(!svg.ok ? svg.reason : "", /^logo\.svg was not attached: only PNG, JPEG, GIF and WebP/);
  const junk = imageAttachmentFromBytes("i", "fake.png", Buffer.from("plain text"));
  assert.equal(!junk.ok && junk.reason, "fake.png was not attached: it is not a PNG, JPEG, GIF or WebP image.");
  const empty = imageAttachmentFromBytes("i", "empty.png", new Uint8Array());
  assert.equal(!empty.ok && empty.reason, "empty.png was not attached: the file is empty.");
  const big = Buffer.alloc(MAX_IMAGE_BYTES * 2);
  PNG.copy(big);
  const tooBig = imageAttachmentFromBytes("i", "big.png", big);
  assert.equal(!tooBig.ok && tooBig.reason, "big.png was not attached: it is 10 MB, images up to 5 MB can be sent.");
});

test("imageBlock carries the file URL only for images from a file", () => {
  const abs = path.resolve("/ws/My Shot.png");
  assert.deepEqual(imageBlock(attachment(PNG, { path: abs, preview: "data:image/png;base64,AAAA" })), {
    type: "image",
    mimeType: "image/png",
    data: PNG_1PX,
    uri: pathToFileURL(abs).href,
  });
  assert.deepEqual(imageBlock(attachment(PNG)), { type: "image", mimeType: "image/png", data: PNG_1PX });
});

test("echoImageContent shows the preview, else the small original, else nothing", () => {
  const preview = `data:image/jpeg;base64,${JPEG.toString("base64")}`;
  assert.deepEqual(echoImageContent(attachment(PNG, { preview })), {
    type: "image",
    mimeType: "image/jpeg",
    data: JPEG.toString("base64"),
  });
  // An unsafe or broken preview is ignored: the (small) image itself is shown.
  for (const bad of ["data:image/svg+xml;base64,PHN2Zy8+", "javascript:alert(1)", "data:image/png;base64,AA AA"]) {
    assert.deepEqual(echoImageContent(attachment(PNG, { preview: bad })), {
      type: "image",
      mimeType: "image/png",
      data: PNG_1PX,
    });
  }
  const large = attachment("A".repeat(MAX_INLINE_PREVIEW_CHARS + 4));
  assert.deepEqual(echoImageContent(large), { type: "image", mimeType: "image/png", data: "" });
  const abs = path.resolve("/ws/shot.png");
  assert.deepEqual(echoImageContent({ ...large, path: abs }), {
    type: "image",
    mimeType: "image/png",
    data: "",
    uri: pathToFileURL(abs).href,
  });
});
