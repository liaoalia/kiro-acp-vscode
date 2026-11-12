/**
 * Image attachment rules shared by the extension host and the chat webview
 * (DECISIONS D29). Keep this file free of `vscode`, Node and DOM imports: it
 * is compiled into both bundles, like `protocol.ts`.
 */

/** The formats the Claude-family models behind Kiro accept as prompt images. */
export const ACCEPTED_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** File extension (lower case, with the dot) → MIME type, for files picked or dropped. */
export const IMAGE_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Largest image (decoded bytes) that may be attached. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Most images one prompt may carry. */
export const MAX_IMAGES_PER_PROMPT = 10;

/**
 * Largest base64 payload a transcript image segment shows inline: images the
 * agent sends or replays with `session/load`, and an echoed prompt image that
 * has no thumbnail (the webview could not make one, or the prompt came from
 * the API). Larger ones render as an "[image]" chip so snapshots stay small.
 * An echoed image normally carries the webview's thumbnail, far below this.
 */
export const MAX_INLINE_PREVIEW_CHARS = 512 * 1024;

const SAFE_DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/** MIME type for a file name or path by its extension; `undefined` when it is not an accepted image. */
export function imageTypeForName(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot < Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"))) return undefined;
  return IMAGE_TYPE_BY_EXTENSION[name.slice(dot).toLowerCase()];
}

export function isAcceptedImageType(mimeType: string): boolean {
  return ACCEPTED_IMAGE_TYPES.includes(mimeType.toLowerCase());
}

/** Decoded byte count of a base64 string, without decoding it. */
export function base64Size(data: string): number {
  const len = data.length;
  if (len === 0) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * "512 B", "48 KB", "7.2 MB". Megabytes round up, so a file just over the
 * 5 MB limit reads "5.1 MB", never "5 MB".
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.ceil(mb) : Math.ceil(mb * 10) / 10} MB`;
}

/**
 * Why an image cannot be attached, as a sentence for a notice; `undefined`
 * when it can. Checks the type and the size only (the count is the caller's).
 */
export function imageRejection(name: string, mimeType: string, size: number): string | undefined {
  if (!isAcceptedImageType(mimeType)) {
    return `${name} was not attached: only PNG, JPEG, GIF and WebP images can be sent to Kiro.`;
  }
  if (size > MAX_IMAGE_BYTES) {
    return `${name} was not attached: it is ${formatBytes(size)}, images up to ${formatBytes(MAX_IMAGE_BYTES)} can be sent.`;
  }
  if (size === 0) {
    return `${name} was not attached: the file is empty.`;
  }
  return undefined;
}

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

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Base64 characters that decode to the 12 bytes every accepted format is recognised by. */
const SNIFF_CHARS = 16;

/**
 * {@link sniffImageType} of base64 data, decoding only its first 12 bytes
 * (no `Buffer` / `atob`: this runs in both bundles). `undefined` when they
 * are not an accepted image or the prefix is not base64.
 */
export function sniffBase64ImageType(data: string): string | undefined {
  const head = data.slice(0, SNIFF_CHARS).replace(/=+$/, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of head) {
    const index = BASE64_ALPHABET.indexOf(ch);
    if (index < 0) return undefined;
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  return sniffImageType(Uint8Array.from(bytes));
}

export type ImageVerdict = { ok: true; mimeType: string; size: number } | { ok: false; reason: string };

/**
 * The verdict on image bytes of `size` that sniffed as `sniffed` (shared by
 * the webview, on attach, and the host, on send, so both refuse the same
 * images with the same words): `imageRejection`'s type and size rules
 * applied to the sniffed type. `claimedType` (the declared type, or the file
 * extension's) only words the reason when the bytes were not recognised, so
 * an SVG or an empty file gets the sharper one.
 */
export function imageVerdict(name: string, sniffed: string | undefined, claimedType: string, size: number): ImageVerdict {
  const rejection = imageRejection(name, sniffed ?? claimedType, size);
  if (rejection) return { ok: false, reason: rejection };
  if (!sniffed) return { ok: false, reason: `${name} was not attached: it is not a PNG, JPEG, GIF or WebP image.` };
  return { ok: true, mimeType: sniffed, size };
}

/** {@link imageVerdict} for base64 image data: the type from its bytes, the size decoded from its length. */
export function imageDataVerdict(name: string, data: string, claimedType: string): ImageVerdict {
  return imageVerdict(name, sniffBase64ImageType(data), claimedType, base64Size(data));
}

/** `data:<mime>;base64,<data>`. */
export function imageDataUrl(mimeType: string, data: string): string {
  return `data:${mimeType};base64,${data}`;
}

/**
 * Split a `data:` URL of an accepted image type; `undefined` for anything
 * else (other types, non-base64, stray characters). This is also the guard
 * for every `src` the webview puts on an `<img>`.
 */
export function parseImageDataUrl(url: string): { mimeType: string; data: string } | undefined {
  const m = SAFE_DATA_URL.exec(url);
  return m ? { mimeType: m[1]!, data: m[2]! } : undefined;
}

export function isSafeImageDataUrl(url: string): boolean {
  return SAFE_DATA_URL.test(url);
}
