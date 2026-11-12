/**
 * Image attachments on the host side (DECISIONS D29): check an image the
 * webview sent (or a file the host read for `pickImages` / `dropFiles`)
 * against its bytes, and build the ACP `image` blocks for the prompt and for
 * the local echo of the user's message. The shared rules (accepted types,
 * size and count limits, data URL guard) live in `src/ui/images.ts`.
 * vscode-free; tested in `test/features-images.test.ts`.
 */
import { pathToFileURL } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import type { ImageAttachment } from "../../ui/protocol.js";
import {
  MAX_INLINE_PREVIEW_CHARS,
  base64Size,
  imageRejection,
  imageTypeForName,
  parseImageDataUrl,
} from "../../ui/images.js";

export type ImageCheck = { ok: true; mimeType: string; size: number } | { ok: false; reason: string };
export type ImageRead = { ok: true; image: ImageAttachment } | { ok: false; reason: string };

/** Plain base64 with canonical padding (no `data:` prefix, no whitespace); the length is checked apart. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Base64 characters that decode to the 12 bytes every accepted format is recognised by. */
const SNIFF_CHARS = 16;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function hasBytes(bytes: Uint8Array, signature: readonly number[] | string, offset = 0): boolean {
  const expected = typeof signature === "string" ? [...signature].map((c) => c.charCodeAt(0)) : signature;
  if (bytes.length < offset + expected.length) return false;
  return expected.every((byte, i) => bytes[offset + i] === byte);
}

/**
 * The image type of `bytes` by their magic number: PNG, JPEG, GIF (87a/89a)
 * or WebP (`RIFF????WEBP`); `undefined` for anything else.
 */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  if (hasBytes(bytes, PNG_SIGNATURE)) return "image/png";
  if (hasBytes(bytes, JPEG_SIGNATURE)) return "image/jpeg";
  if (hasBytes(bytes, "GIF87a") || hasBytes(bytes, "GIF89a")) return "image/gif";
  if (hasBytes(bytes, "RIFF") && hasBytes(bytes, "WEBP", 8)) return "image/webp";
  return undefined;
}

/** The name an image goes by in notices. */
function displayName(name: unknown): string {
  return typeof name === "string" && name.trim() !== "" ? name : "An image";
}

/**
 * The verdict on an image of `size` bytes whose content sniffed as
 * `sniffed`: `imageRejection`'s type and size rules, applied to the sniffed
 * type. `claimedType` (the declared type, or the file extension's) only
 * words the reason when the bytes were not recognised, so an SVG or an empty
 * file gets the sharper one.
 */
function verdict(name: string, sniffed: string | undefined, claimedType: string, size: number): ImageCheck {
  const rejection = imageRejection(name, sniffed ?? claimedType, size);
  if (rejection) return { ok: false, reason: rejection };
  if (!sniffed) return { ok: false, reason: `${name} was not attached: it is not a PNG, JPEG, GIF or WebP image.` };
  return { ok: true, mimeType: sniffed, size };
}

/**
 * Check an attachment sent by the webview before it goes out (D29): `data`
 * must be plain base64; the type is taken from the bytes, not from the
 * declared `mimeType` (an accepted type sniffed under another declared one
 * corrects it), and the size is the real decoded size, not the declared one.
 * Valid base64 decodes to exactly `base64Size` bytes, so only its first
 * bytes are decoded, to sniff the type.
 */
export function checkImageAttachment(img: ImageAttachment): ImageCheck {
  if (typeof img !== "object" || img === null) {
    return { ok: false, reason: "An image was not attached: it arrived malformed." };
  }
  const name = displayName(img.name);
  const data: unknown = img.data;
  if (typeof data !== "string" || data.length % 4 !== 0 || !BASE64.test(data)) {
    return { ok: false, reason: `${name} was not attached: its data is not valid base64.` };
  }
  const sniffed = sniffImageType(Buffer.from(data.slice(0, SNIFF_CHARS), "base64"));
  const declared = typeof img.mimeType === "string" ? img.mimeType : "";
  return verdict(name, sniffed, declared, base64Size(data));
}

/**
 * An attachment for an image file the host read (`pickImages`, `dropFiles`):
 * the same checks as {@link checkImageAttachment}, the type sniffed from
 * `bytes`. `path` (the file's absolute path) becomes the block's `uri`.
 */
export function imageAttachmentFromBytes(id: string, name: string, bytes: Uint8Array, path?: string): ImageRead {
  const check = verdict(displayName(name), sniffImageType(bytes), imageTypeForName(name) ?? "", bytes.length);
  if (!check.ok) return check;
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  const image: ImageAttachment = { id, name, mimeType: check.mimeType, data, size: check.size };
  if (path) image.path = path;
  return { ok: true, image };
}

/** `file:///…` URL of an attachment that came from a file, else `undefined`. */
function fileUri(img: ImageAttachment): string | undefined {
  return img.path ? pathToFileURL(img.path).href : undefined;
}

/**
 * The ACP `image` block sent for a checked attachment (its `mimeType`
 * already corrected by {@link checkImageAttachment}); `uri` is the file's
 * URL when the image came from a file.
 */
export function imageBlock(img: ImageAttachment): acp.ContentBlock {
  const uri = fileUri(img);
  return { type: "image", mimeType: img.mimeType, data: img.data, ...(uri ? { uri } : {}) };
}

/**
 * The `image` block used only for the local echo of the user's message
 * (D13; never sent): the webview's thumbnail when it is a safe image data
 * URL, else the image itself when it is small enough to show inline
 * (`MAX_INLINE_PREVIEW_CHARS`), else no data (the message shows an "[image]"
 * chip). `uri` gives the segment its file name for images from a file.
 */
export function echoImageContent(img: ImageAttachment): acp.ContentBlock {
  const preview = typeof img.preview === "string" ? parseImageDataUrl(img.preview) : undefined;
  const shown = preview ?? {
    mimeType: img.mimeType,
    data: img.data.length <= MAX_INLINE_PREVIEW_CHARS ? img.data : "",
  };
  const uri = fileUri(img);
  return { type: "image", mimeType: shown.mimeType, data: shown.data, ...(uri ? { uri } : {}) };
}
