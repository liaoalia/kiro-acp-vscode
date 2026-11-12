/** F16 — image attachments: ACP `image` blocks, checks before sending, file dialog and drops (D29). */
import * as vscode from "vscode";

import type { ImageAttachment } from "../../src/ui/protocol.js";
import { MAX_IMAGE_BYTES } from "../../src/ui/images.js";
import {
  assert,
  assertEqual,
  ensureReady,
  freshSession,
  messagesOf,
  test,
  textOf,
  waitFor,
  withTimeout,
  workspacePath,
  type Recorder,
} from "./harness.js";
import type { KiroAcpApi } from "../../src/extension.js";

/** A 1×1 PNG. */
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_1PX, "base64").length;

function pasted(id: string, overrides: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    id,
    name: `Pasted image ${id}.png`,
    mimeType: "image/png",
    data: PNG_1PX,
    size: PNG_BYTES,
    preview: `data:image/png;base64,${PNG_1PX}`,
    ...overrides,
  };
}

/** Send a prompt with images and wait for the turn (if any) to end. */
async function promptWithImages(api: KiroAcpApi, text: string, images: ImageAttachment[]): Promise<void> {
  await withTimeout(api.controller.prompt(text, [], undefined, undefined, images), 30_000, `turn for ${JSON.stringify(text)}`);
  await waitFor(() => !api.controller.snapshot().turnActive, 15_000, "turn to end");
}

function lastAgentText(api: KiroAcpApi): string {
  const msgs = messagesOf(api.controller.snapshot()).filter((m) => m.role === "agent");
  return msgs.length > 0 ? textOf(msgs[msgs.length - 1]!) : "";
}

function noticesSince(recorder: Recorder, mark: number): string[] {
  return recorder.ofType("notice", mark).map((n) => n.notice.text);
}

/** Replace `vscode.window.showOpenDialog` for one call; returns the restore function. */
function stubOpenDialog(result: vscode.Uri[] | undefined): () => void {
  const win = vscode.window as unknown as Record<string, unknown>;
  const original = win.showOpenDialog;
  const stub = (): Promise<vscode.Uri[] | undefined> => Promise.resolve(result);
  try {
    win.showOpenDialog = stub;
  } catch {
    Object.defineProperty(win, "showOpenDialog", { value: stub, configurable: true, writable: true });
  }
  return () => {
    try {
      win.showOpenDialog = original;
    } catch {
      Object.defineProperty(win, "showOpenDialog", { value: original, configurable: true, writable: true });
    }
  };
}

async function writeWorkspaceBytes(rel: string, bytes: Uint8Array): Promise<vscode.Uri> {
  const uri = vscode.Uri.file(workspacePath(rel));
  await vscode.workspace.fs.writeFile(uri, bytes);
  return uri;
}

test("F16.1 the connection advertises image support", async ({ api }) => {
  const state = await ensureReady(api);
  assertEqual(state.connection.acceptsImages, true, "acceptsImages (the fake agent advertises promptCapabilities.image)");
});

test("F16.2 text + image go out as text, image blocks; the echo shows the thumbnail", async ({ api, recorder }) => {
  await freshSession(api);
  const mark = recorder.mark();
  await promptWithImages(api, "/scenario images what is on it?", [pasted("a")]);

  assertEqual(
    lastAgentText(api),
    `Received 1 image(s): image/png ${PNG_BYTES} B; blocks: text,image.`,
    "what the agent received",
  );
  const user = messagesOf(api.controller.snapshot()).find((m) => m.role === "user");
  assert(user, "the user message is in the transcript");
  const image = user.segments.find((s) => s.type === "image");
  assert(image && image.type === "image", "the user message has an image segment");
  assert(image.src?.startsWith("data:image/png;base64,"), `the image segment shows the preview: ${image.src?.slice(0, 40)}`);
  assert(
    recorder.ofType("chunk", mark).some((c) => c.role === "user" && c.segment.type === "image"),
    "an image chunk was posted to the view",
  );
});

test("F16.3 a message of images only is sent", async ({ api }) => {
  await freshSession(api);
  await promptWithImages(api, "", [pasted("b"), pasted("c")]);
  assertEqual(
    lastAgentText(api),
    `Received 2 image(s): image/png ${PNG_BYTES} B, image/png ${PNG_BYTES} B; blocks: image,image.`,
    "what the agent received",
  );
  const user = messagesOf(api.controller.snapshot()).find((m) => m.role === "user");
  assert(user, "the user message is in the transcript");
  assertEqual(user.segments.filter((s) => s.type === "image").length, 2, "two image segments");
});

test("F16.4 bytes that are not an image, an oversized image and too many images are refused before anything is sent", async ({ api, recorder }) => {
  await freshSession(api);
  const before = messagesOf(api.controller.snapshot()).length;
  const first = recorder.mark();

  let mark = first;
  await promptWithImages(api, "/scenario images look", [pasted("junk", { data: Buffer.from("hello, not a png").toString("base64") })]);
  assert(noticesSince(recorder, mark).some((t) => t.includes("Pasted image junk.png")), `a notice names the file: ${noticesSince(recorder, mark).join(" | ")}`);

  mark = recorder.mark();
  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  Buffer.from(PNG_1PX, "base64").copy(big);
  await promptWithImages(api, "/scenario images look", [pasted("big", { data: big.toString("base64"), size: big.length })]);
  assert(noticesSince(recorder, mark).some((t) => t.includes("Pasted image big.png")), `a notice names the big file: ${noticesSince(recorder, mark).join(" | ")}`);

  mark = recorder.mark();
  const many = Array.from({ length: 11 }, (_, i) => pasted(`m${i}`));
  await promptWithImages(api, "/scenario images look", many);
  assert(noticesSince(recorder, mark).length > 0, "a notice about the count");

  assertEqual(messagesOf(api.controller.snapshot()).length, before, "nothing was echoed");
  assert(!recorder.ofType("turn", first).some((t) => t.active), "no turn was started");
});

test("F16.5 a command the extension runs itself does not send the images and says so", async ({ api, recorder }) => {
  await freshSession(api);
  const mark = recorder.mark();
  await promptWithImages(api, "/help", [pasted("h")]);
  assert(lastAgentText(api).includes("/clear"), "help was shown");
  assert(noticesSince(recorder, mark).some((t) => /not sent/i.test(t)), `a notice says the image was not sent: ${noticesSince(recorder, mark).join(" | ")}`);
});

test("F16.6 the attach button reads the picked files; a fake image is refused", async ({ api, recorder }) => {
  await ensureReady(api);
  const png = await writeWorkspaceBytes("pic.png", Buffer.from(PNG_1PX, "base64"));
  const fake = await writeWorkspaceBytes("fake.gif", Buffer.from("GIF? no"));
  const restore = stubOpenDialog([png, fake]);
  const mark = recorder.mark();
  try {
    await withTimeout(api.controller.handle({ type: "pickImages" }), 15_000, "pickImages");
  } finally {
    restore();
  }
  const attached = recorder.ofType("imagesAttached", mark).flatMap((m) => m.images);
  assertEqual(attached.length, 1, "one image attached");
  assertEqual(attached[0]!.name, "pic.png", "name");
  assertEqual(attached[0]!.mimeType, "image/png", "type");
  assertEqual(attached[0]!.size, PNG_BYTES, "size");
  assertEqual(attached[0]!.data, PNG_1PX, "data");
  assert(noticesSince(recorder, mark).some((t) => t.includes("fake.gif")), "the fake gif is reported");
});

test("F16.7 dropped explorer files: images are attached, other files become @ chips", async ({ api, recorder }) => {
  await ensureReady(api);
  const png = await writeWorkspaceBytes("drop.png", Buffer.from(PNG_1PX, "base64"));
  const readme = vscode.Uri.file(workspacePath("README.md"));
  const mark = recorder.mark();
  try {
    await withTimeout(
      api.controller.handle({ type: "dropFiles", uris: [png.toString(), readme.toString()] }),
      15_000,
      "dropFiles",
    );
    const attached = recorder.ofType("imagesAttached", mark).flatMap((m) => m.images);
    assertEqual(attached.map((i) => i.name).join(","), "drop.png", "the image was attached");
    assert(
      api.contextTracker.chips().some((c) => c.kind === "file" && c.label === "README.md" && !c.implicit),
      "README.md became a file chip",
    );
  } finally {
    api.contextTracker.clearExplicit();
  }
});
