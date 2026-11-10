/** F4 — file context: @file chips, file search, implicit active-file chip. */
import * as vscode from "vscode";

import {
  assert,
  assertEqual,
  closeAllEditors,
  freshSession,
  messagesOf,
  runPrompt,
  samePath,
  test,
  waitFor,
  workspacePath,
} from "./harness.js";

test("F4.1 an explicit @file chip is sent as a resource segment and cleared afterwards", async ({ api, recorder }) => {
  await freshSession(api);
  await closeAllEditors();
  const readme = workspacePath("README.md");

  const chip = api.contextTracker.addFileChip(readme);
  assertEqual(chip.kind, "file", "chip kind");
  assertEqual(chip.implicit, false, "chip is explicit");
  assertEqual(chip.label, "README.md", "chip label");
  assert(
    api.contextTracker.chips().some((c) => c.id === chip.id),
    "the chip is listed before sending",
  );
  assert(
    recorder.ofType("chips").some((m) => m.chips.some((c) => c.id === chip.id)),
    "a chips message carrying the chip was posted",
  );

  const mark = recorder.mark();
  await runPrompt(api, "/scenario chat look at the readme", [chip]);

  const state = api.controller.snapshot();
  const user = messagesOf(state).find((m) => m.role === "user");
  assert(user, "user message in the transcript");
  const resource = user.segments.find((s) => s.type === "resource");
  assert(resource && resource.type === "resource", "user message has a resource segment");
  assertEqual(resource.label, "README.md", "resource label");
  assert(resource.uri.startsWith("file:") && resource.uri.endsWith("README.md"), `resource uri: ${resource.uri}`);
  assert(
    recorder.ofType("chunk", mark).some((c) => c.role === "user" && c.segment.type === "resource"),
    "a user chunk with a resource segment was posted",
  );
  assert(
    !api.contextTracker.chips().some((c) => !c.implicit),
    "explicit chips are cleared after the prompt was sent",
  );
  assert(
    messagesOf(state).some((m) => m.role === "agent"),
    "the agent answered the prompt",
  );
});

test("F4.2 queryFiles finds src/sample.ts", async ({ api, recorder }) => {
  const mark = recorder.mark();
  await api.controller.handle({ type: "queryFiles", query: "samp" });
  const suggestions = await waitFor(
    () => recorder.ofType("fileSuggestions", mark).find((m) => m.query === "samp"),
    15_000,
    "file suggestions for 'samp'",
  );
  const sample = suggestions.items.find((i) => i.label === "src/sample.ts");
  assert(sample, `suggestions include src/sample.ts: ${JSON.stringify(suggestions.items)}`);
  assert(samePath(sample.path, workspacePath("src", "sample.ts")), `suggestion path: ${sample.path}`);
});

test("F4.3 the active file becomes an implicit chip that can be removed", async ({ api }) => {
  await closeAllEditors();
  const sample = workspacePath("src", "sample.ts");
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(sample));
  await vscode.window.showTextDocument(doc, { preview: false });

  const chip = await waitFor(
    () => api.contextTracker.chips().find((c) => c.implicit && samePath(c.path, sample)),
    15_000,
    "an implicit chip for src/sample.ts",
  );
  assertEqual(chip.kind, "file", "implicit chip kind");
  assertEqual(chip.label, "src/sample.ts", "implicit chip label");

  api.contextTracker.removeChip(chip.id);
  assert(
    !api.contextTracker.chips().some((c) => c.id === chip.id),
    "the implicit chip is gone after removeChip",
  );
});
