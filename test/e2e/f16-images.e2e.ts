/**
 * F16 — image attachments: ACP `image` blocks, checks before sending, steering,
 * the queue, `/plan`, an agent without image support, the file dialog and
 * drops (D29).
 */
import * as vscode from "vscode";

import type { ImageAttachment, MessageView } from "../../src/ui/protocol.js";
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

/** A 1×1 PNG: the image sent to the agent. */
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_1PX, "base64").length;
/**
 * A 1×1 WebP standing in for the webview's thumbnail. Different bytes and
 * type from the image, so a test can tell which of the two the echo shows.
 */
const PREVIEW = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

function pasted(id: string, overrides: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    id,
    name: `Pasted image ${id}.png`,
    mimeType: "image/png",
    data: PNG_1PX,
    size: PNG_BYTES,
    preview: PREVIEW,
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

function userMessage(api: KiroAcpApi, text: string): MessageView | undefined {
  return messagesOf(api.controller.snapshot()).find((m) => m.role === "user" && textOf(m) === text);
}

/** The echo shows the webview's thumbnail, never the image that was sent. */
function assertEchoesPreview(message: MessageView, count: number, label: string): void {
  const images = message.segments.filter((s) => s.type === "image");
  assertEqual(images.length, count, `${label}: image segments`);
  for (const image of images) {
    assert(image.type === "image" && image.src === PREVIEW, `${label}: the echo shows the thumbnail, got ${image.type === "image" ? image.src?.slice(0, 40) : ""}`);
  }
}

function noticesSince(recorder: Recorder, mark: number): string[] {
  return recorder.ofType("notice", mark).map((n) => n.notice.text);
}

/**
 * Start the fake agent's `slow` scenario and return once it streams. The turn
 * comes back wrapped: an async function returning the bare promise would
 * adopt it, and awaiting this would wait for the whole turn.
 */
async function startSlowTurn(api: KiroAcpApi, recorder: Recorder, mark: number): Promise<{ turn: Promise<void> }> {
  const turn = api.controller.prompt("/scenario slow", []);
  await waitFor(
    () => recorder.ofType("chunk", mark).filter((c) => c.role === "agent").length >= 2,
    15_000,
    "two streamed chunks of the slow turn",
  );
  return { turn };
}

/** Replace `vscode.window.showOpenDialog`; `calls()` counts the dialogs opened. */
function stubOpenDialog(result: vscode.Uri[] | undefined): { restore(): void; calls(): number } {
  const win = vscode.window as unknown as Record<string, unknown>;
  const original = win.showOpenDialog;
  let calls = 0;
  const stub = (): Promise<vscode.Uri[] | undefined> => {
    calls++;
    return Promise.resolve(result);
  };
  try {
    win.showOpenDialog = stub;
  } catch {
    Object.defineProperty(win, "showOpenDialog", { value: stub, configurable: true, writable: true });
  }
  return {
    restore: () => {
      try {
        win.showOpenDialog = original;
      } catch {
        Object.defineProperty(win, "showOpenDialog", { value: original, configurable: true, writable: true });
      }
    },
    calls: () => calls,
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

test("F16.2 text + image go out as text, image blocks; the echo shows the thumbnail, not the image", async ({ api, recorder }) => {
  await freshSession(api);
  const mark = recorder.mark();
  await promptWithImages(api, "/scenario images what is on it?", [pasted("a")]);

  assertEqual(
    lastAgentText(api),
    `Received 1 image(s): image/png ${PNG_BYTES} B; blocks: text,image.`,
    "what the agent received (the full PNG, not the thumbnail)",
  );
  const user = userMessage(api, "/scenario images what is on it?");
  assert(user, "the user message is in the transcript");
  assertEchoesPreview(user, 1, "F16.2");
  assert(
    recorder.ofType("chunk", mark).some((c) => c.role === "user" && c.segment.type === "image" && c.segment.src === PREVIEW),
    "an image chunk carrying the thumbnail was posted to the view",
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
  assertEchoesPreview(user, 2, "F16.3");
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
  const dialog = stubOpenDialog([png, fake]);
  const mark = recorder.mark();
  try {
    await withTimeout(api.controller.handle({ type: "pickImages" }), 15_000, "pickImages");
  } finally {
    dialog.restore();
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

test("F16.8 images typed mid-turn are steered into the running turn with their text", async ({ api, recorder }) => {
  await freshSession(api);
  const mark = recorder.mark();
  const { turn } = await startSlowTurn(api, recorder, mark);

  await withTimeout(api.controller.prompt("look at this", [], undefined, undefined, [pasted("s")]), 15_000, "steered prompt()");
  const steered = userMessage(api, "look at this");
  assert(steered, "the steered prompt is echoed");
  assertEqual(steered.delivery, "steering", "delivery badge");
  assertEchoesPreview(steered, 1, "F16.8");

  await waitFor(
    () =>
      messagesOf(api.controller.snapshot()).some(
        (m) => m.role === "agent" && textOf(m).includes(`Steered: look at this [1 image(s): image/png ${PNG_BYTES} B]`),
      ),
    15_000,
    "the agent's steered answer naming the image",
  );
  await withTimeout(turn, 15_000, "the slow turn");
});

test("F16.9 without steering, a queued prompt keeps its images and sends them with its own turn", async ({ api, recorder }) => {
  const sessionId = await freshSession(api);
  api.controller.setSteerUnsupportedForTests(sessionId, true);
  try {
    const mark = recorder.mark();
    const { turn } = await startSlowTurn(api, recorder, mark);

    await withTimeout(
      api.controller.prompt("/scenario images queued", [], undefined, undefined, [pasted("q")]),
      15_000,
      "queued prompt()",
    );
    const queued = userMessage(api, "/scenario images queued");
    assert(queued, "the queued prompt is echoed");
    assertEqual(queued.delivery, "queued", "delivery badge");
    assertEchoesPreview(queued, 1, "F16.9");

    await withTimeout(turn, 15_000, "the slow turn");
    await waitFor(
      () =>
        !api.controller.snapshot().turnActive &&
        lastAgentText(api) === `Received 1 image(s): image/png ${PNG_BYTES} B; blocks: text,image.`
          ? true
          : undefined,
      15_000,
      "the queued prompt's own turn, with its image",
    );
  } finally {
    api.controller.setSteerUnsupportedForTests(sessionId, false);
  }
});

test("F16.10 /plan <text> switches to the planner mode and sends the images with the text", async ({ api, recorder }) => {
  await freshSession(api);
  const mark = recorder.mark();
  await promptWithImages(api, "/plan /scenario images plan this", [pasted("p")]);
  assertEqual(api.controller.snapshot().modes?.currentModeId, "plan", "planner mode");
  assertEqual(
    lastAgentText(api),
    `Received 1 image(s): image/png ${PNG_BYTES} B; blocks: text,image.`,
    "the plan text went out with the image",
  );
  assert(!noticesSince(recorder, mark).some((t) => /not sent/i.test(t)), "no 'not sent' notice for /plan");
});

test("F16.11 an agent without image support: images are refused before anything is sent, and nothing is read", async ({ api, recorder }) => {
  const config = vscode.workspace.getConfiguration("kiroAcp");
  const prior = config.get<string[]>("cliArgs", []);
  await config.update("cliArgs", [...prior, "--no-image"], vscode.ConfigurationTarget.Workspace);
  try {
    await withTimeout(api.controller.restart(), 30_000, "restart() with --no-image");
    const state = await ensureReady(api);
    assertEqual(state.connection.acceptsImages, false, "acceptsImages without promptCapabilities.image");

    const before = messagesOf(api.controller.snapshot()).length;
    let mark = recorder.mark();
    await withTimeout(
      api.controller.prompt("/scenario images look", [], undefined, undefined, [pasted("n")]),
      15_000,
      "prompt() with an image",
    );
    assert(
      noticesSince(recorder, mark).some((t) => t.includes("does not accept images")),
      `a notice says why: ${noticesSince(recorder, mark).join(" | ")}`,
    );
    assertEqual(messagesOf(api.controller.snapshot()).length, before, "nothing was echoed");
    assert(!recorder.ofType("turn", mark).some((t) => t.active), "no turn was started");

    mark = recorder.mark();
    const png = await writeWorkspaceBytes("refused.png", Buffer.from(PNG_1PX, "base64"));
    const dialog = stubOpenDialog([png]);
    try {
      await withTimeout(api.controller.handle({ type: "pickImages" }), 15_000, "pickImages");
      await withTimeout(api.controller.handle({ type: "dropFiles", uris: [png.toString()] }), 15_000, "dropFiles");
    } finally {
      dialog.restore();
    }
    assertEqual(dialog.calls(), 0, "no file dialog was opened");
    assertEqual(recorder.ofType("imagesAttached", mark).length, 0, "no image was handed to the composer");
    assertEqual(
      noticesSince(recorder, mark).filter((t) => t.includes("does not accept images")).length,
      2,
      "the attach button and the drop each say why",
    );
  } finally {
    await config.update("cliArgs", prior, vscode.ConfigurationTarget.Workspace);
    await withTimeout(api.controller.restart(), 30_000, "restart() without --no-image");
    const restored = await ensureReady(api);
    assertEqual(restored.connection.acceptsImages, true, "image support is back after the restart");
  }
});
