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
 * Largest base64 payload a transcript image segment shows inline (images the
 * agent sends or replays with `session/load`); larger ones render as an
 * "[image]" chip so snapshots stay small. Echoed prompts carry the webview's
 * thumbnail instead, which is always far below this.
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
