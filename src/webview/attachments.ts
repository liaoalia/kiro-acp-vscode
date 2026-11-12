/**
 * Pure helpers for composer image attachments (DECISIONS D29): paste and drop
 * decisions, generated names, uri-list parsing and the attach plan (type,
 * size, count). No DOM types here: unit-tested under Node. The shared rules
 * (accepted types, limits, notice wording) are `src/ui/images.ts`'s.
 */
import { IMAGE_TYPE_BY_EXTENSION, MAX_IMAGES_PER_PROMPT, imageRejection, imageTypeForName } from "../ui/images.js";

/** Notice when an image is pasted or dropped while the agent takes none. */
export const IMAGES_NOT_ACCEPTED = "Kiro does not accept images.";

/** Notice when files other than images are dropped from outside VS Code (only their bytes arrive, no path). */
export const ONLY_IMAGES_DROPPED = "Only images can be dropped from outside VS Code; use @ to add other files.";

/** Longest side of a composer/echo thumbnail, in CSS pixels. */
export const PREVIEW_MAX_SIDE = 320;

/**
 * What a paste does: attach the clipboard's images, or let the textarea paste
 * text. Excel and Word put a bitmap next to the text; the text is what the
 * user means there, so images win only when there is no plain text at all.
 */
export function pasteAction(clip: { hasText: boolean; imageCount: number }): "text" | "images" {
  return clip.imageCount > 0 && !clip.hasText ? "images" : "text";
}

/**
 * The drag carries files or URIs the composer handles (OS files, a VS Code
 * explorer drag, a uri-list); plain text drags keep the textarea's default.
 */
export function isAttachableDrag(types: readonly string[]): boolean {
  return types.some((t) => {
    const type = t.toLowerCase();
    return type === "files" || type === "text/uri-list" || type === "application/vnd.code.uri-list";
  });
}

/**
 * URIs of a dropped uri-list: one per line (CRLF or LF), blank and `#`
 * comment lines skipped, each trimmed, duplicates dropped. VS Code's own
 * `application/vnd.code.uri-list` may be a JSON array of strings; that is
 * accepted too.
 */
export function parseUriList(text: string): string[] {
  const trimmed = text.trim();
  let uris: string[] | undefined;
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        uris = parsed.filter((u): u is string => typeof u === "string").map((u) => u.trim());
      }
    } catch {
      // Not JSON: read it as lines.
    }
  }
  uris ??= trimmed.split(/\r\n|\r|\n/).map((l) => l.trim());
  const seen = new Set<string>();
  return uris.filter((u) => {
    if (u.length === 0 || u.startsWith("#") || seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

/** `http:` / `https:` link: a dropped web link stays text for the textarea. */
export function isWebUri(uri: string): boolean {
  return /^https?:/i.test(uri);
}

/**
 * MIME type of a pasted or dropped file: its declared type (lower case,
 * `image/jpg` normalised), else the type of its extension, else "".
 */
export function fileImageType(type: string, name: string): string {
  const t = type.trim().toLowerCase();
  if (t === "image/jpg" || t === "image/pjpeg") return "image/jpeg";
  if (t) return t;
  return imageTypeForName(name) ?? "";
}

/** The file is an image by its type or extension (accepted or not: unsupported ones get a notice). */
export function isImageFile(type: string, name: string): boolean {
  return fileImageType(type, name).startsWith("image/");
}

/** File extension (without the dot) for an image type: "png", "jpg", "gif", "webp"; else the subtype. */
export function imageExtension(mimeType: string): string {
  const type = mimeType.toLowerCase();
  for (const [ext, t] of Object.entries(IMAGE_TYPE_BY_EXTENSION)) {
    if (t === type) return ext.slice(1);
  }
  const sub = /^image\/([a-z0-9.+-]+)$/.exec(type)?.[1];
  return sub ? sub.replace(/^x-/, "").replace(/\+.*$/, "") || "img" : "img";
}

/** Chromium names every clipboard bitmap `image.png`: that name says nothing. */
export function isGenericClipboardName(name: string): boolean {
  const n = name.trim();
  return n.length === 0 || /^image\.[a-z0-9]+$/i.test(n);
}

/** "Pasted image 3.png". */
export function pastedImageName(n: number, mimeType: string): string {
  return `Pasted image ${n}.${imageExtension(mimeType)}`;
}

/**
 * Names pasted images: a real file name (a file copied in the OS file
 * manager) is kept; a generic clipboard name becomes "Pasted image <n>.<ext>",
 * `n` counting per webview.
 */
export class PasteNamer {
  private count = 0;

  name(fileName: string, mimeType: string): string {
    if (!isGenericClipboardName(fileName)) return fileName.trim();
    this.count += 1;
    return pastedImageName(this.count, mimeType);
  }
}

/** What an attach plan needs to know about an image (an `ImageAttachment` or a file's metadata). */
export interface AttachCandidate {
  name: string;
  mimeType: string;
  /** Decoded size in bytes. */
  size: number;
  path?: string;
}

export interface AttachPlan<T> {
  /** Images to attach, in order. */
  accepted: T[];
  /** Sentences for one notice (type, size and count rejections); empty when all fit. */
  notices: string[];
}

/**
 * Split incoming images into the ones to attach and the notices for the
 * rest: type and size by `imageRejection`, then the count limit given
 * `currentCount` images already attached (or being attached). An image whose
 * `path` is already attached (or repeats in `incoming`) is skipped silently:
 * its tile is there.
 */
export function planAttach<T extends AttachCandidate>(
  incoming: readonly T[],
  currentCount: number,
  existingPaths: readonly string[] = [],
  max: number = MAX_IMAGES_PER_PROMPT,
): AttachPlan<T> {
  const accepted: T[] = [];
  const notices: string[] = [];
  const overflow: T[] = [];
  const paths = new Set(existingPaths);
  let count = currentCount;
  for (const img of incoming) {
    if (img.path) {
      if (paths.has(img.path)) continue;
      paths.add(img.path);
    }
    const rejection = imageRejection(img.name, img.mimeType, img.size);
    if (rejection) {
      notices.push(rejection);
      continue;
    }
    if (count >= max) {
      overflow.push(img);
      continue;
    }
    accepted.push(img);
    count++;
  }
  if (overflow.length === 1) {
    notices.push(`${overflow[0].name} was not attached: up to ${max} images can be sent with one prompt.`);
  } else if (overflow.length > 1) {
    notices.push(`${overflow.length} images were not attached: up to ${max} images can be sent with one prompt.`);
  }
  return { accepted, notices };
}

/** Thumbnail size for an image of `width` × `height`: longest side ≤ `max`, never upscaled, at least 1 px. */
export function previewSize(width: number, height: number, max: number = PREVIEW_MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
