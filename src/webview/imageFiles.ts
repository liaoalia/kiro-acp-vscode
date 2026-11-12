/**
 * Browser-side image work for composer attachments (DECISIONS D29): reading
 * pasted/dropped files as base64 and making the small thumbnail shown on the
 * composer tile and echoed in the transcript. Everything stays local: images
 * are decoded from their bytes (`createImageBitmap`) or from a `data:` URL
 * (the CSP allows only `data:` and extension images), never fetched.
 */
import { imageDataUrl, isSafeImageDataUrl } from "../ui/images";
import { isImageFile, previewSize } from "./attachments";

/** Largest thumbnail kept (characters of its `data:` URL); a bigger one is dropped. */
export const PREVIEW_MAX_CHARS = 200 * 1024;

/** The file's bytes as base64 (no `data:` prefix). */
export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("unexpected FileReader result"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.onerror = () => reject(reader.error ?? new Error("the file could not be read"));
    reader.onabort = () => reject(new Error("reading the file was aborted"));
    reader.readAsDataURL(file);
  });
}

/**
 * Image files of a paste: `clipboardData.files`, else the `items` of kind
 * "file" (some sources only fill the item list). Unsupported image types are
 * kept so the caller can name them in a notice.
 */
export function clipboardImageFiles(data: DataTransfer): File[] {
  let files = Array.from(data.files ?? []);
  if (files.length === 0) {
    files = Array.from(data.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
  }
  return files.filter((f) => isImageFile(f.type, f.name));
}

function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

async function decode(mimeType: string, data: string): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(new Blob([base64ToBytes(data)], { type: mimeType }));
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Fall back to an <img> below.
    }
  }
  const url = imageDataUrl(mimeType, data);
  if (!isSafeImageDataUrl(url)) throw new Error("not an accepted image");
  const img = new Image();
  img.src = url;
  await img.decode();
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined };
}

/**
 * A small `data:` URL thumbnail (longest side ≤ 320 px, never upscaled; WebP,
 * else PNG) of a base64 image; GIFs give their first frame. `undefined` when
 * the image cannot be decoded or the result is not a safe image `data:` URL
 * of at most `PREVIEW_MAX_CHARS`.
 */
export async function makePreview(mimeType: string, data: string): Promise<string | undefined> {
  let decoded: Decoded | undefined;
  try {
    decoded = await decode(mimeType, data);
    if (!(decoded.width > 0 && decoded.height > 0)) return undefined;
    const size = previewSize(decoded.width, decoded.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.source, 0, 0, size.width, size.height);
    let url = canvas.toDataURL("image/webp", 0.85);
    // `toDataURL` silently answers PNG when it cannot encode WebP.
    if (!url.startsWith("data:image/webp;")) url = canvas.toDataURL("image/png");
    return url.length <= PREVIEW_MAX_CHARS && isSafeImageDataUrl(url) ? url : undefined;
  } catch {
    return undefined;
  } finally {
    decoded?.close();
  }
}
