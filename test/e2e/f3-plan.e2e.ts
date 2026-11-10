/** F3 — plan document and plan approval (switch_mode permission). */
import * as vscode from "vscode";

import {
  PLAN_SCHEME,
  assert,
  assertEqual,
  closeAllEditors,
  freshSession,
  lastStopReason,
  messagesOf,
  runTourAccepting,
  test,
  textOf,
  toolCall,
  waitFor,
  withTimeout,
} from "./harness.js";

test("F3.1 the tour's plan updates render in the kiro-plan document", async ({ api, recorder }) => {
  await freshSession(api);
  await closeAllEditors();
  const mark = recorder.mark();

  const state = await runTourAccepting(api);
  const plans = recorder.ofType("plan", mark);
  assert(plans.length >= 2, `expected two plan updates, got ${plans.length}`);
  assertEqual(state.plan.length, 3, "plan entries in the UI state");

  const text = api.plan.text;
  assert(text.startsWith("# Kiro plan"), "plan document starts with the title");
  assert(text.includes("- [x] **(high)** Inspect the workspace"), `completed entry rendered with [x]:\n${text}`);
  assert(text.includes("- [ ] ⏳ Run a command"), `in-progress entry rendered:\n${text}`);
  assert(text.includes("- [ ] (low) Create hello.txt"), `pending low entry rendered:\n${text}`);
  assert(text.includes("**1 of 3 done · 1 in progress**"), `status line rendered:\n${text}`);
  assert(state.sessionId && text.includes(`Session ${state.sessionId}`), "plan document names the session");

  await vscode.commands.executeCommand("kiroAcp.openPlan");
  const editor = await waitFor(
    () => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === PLAN_SCHEME),
    15_000,
    "a visible kiro-plan editor",
  );
  assertEqual(api.plan.isOpen(), true, "PlanDocument.isOpen()");
  assertEqual(editor.document.languageId, "markdown", "plan document language");
  await waitFor(
    () => editor.document.getText().includes("Inspect the workspace"),
    15_000,
    "plan editor content to refresh",
  );
});

test("F3.2 approving a switch_mode request from the plan command resumes the agent", async ({ api, recorder }) => {
  await freshSession(api);
  const mark = recorder.mark();

  const turn = api.controller.prompt("/scenario switch-mode", []);
  const permission = await waitFor(() => api.permissions.findByKind("switch_mode"), 15_000, "a switch_mode permission");
  assertEqual(permission.title, "Approve plan and start implementation", "permission title");
  assertEqual(permission.toolCallId, "call-switch", "tool call id");

  await waitFor(() => api.plan.text.includes("waiting for approval"), 15_000, "the approval note in the plan");
  assert(api.plan.text.includes("Add a greeting function"), "plan shows the proposed entries");
  assertEqual(api.permissions.pendingForToolCall("call-switch")?.requestId, permission.requestId, "the request belongs to the switch_mode call");
  assertEqual(api.controller.snapshot().toolCalls["call-switch"]?.status, "pending", "switch_mode card is pending");

  await vscode.commands.executeCommand("kiroAcp.approvePlan");
  await waitFor(() => api.permissions.findByKind("switch_mode") === undefined, 15_000, "the request to resolve");
  await withTimeout(turn, 30_000, "the switch-mode turn");
  await waitFor(() => !api.controller.snapshot().turnActive, 15_000, "turn to end");

  const state = api.controller.snapshot();
  assertEqual(lastStopReason(recorder, mark), "end_turn", "stop reason");
  assertEqual(toolCall(state, "call-switch").status, "completed", "switch_mode tool call status");
  assertEqual(state.modes?.currentModeId, "vibe", "current mode after approval");
  const agentTexts = messagesOf(state).filter((m) => m.role === "agent").map(textOf);
  assert(agentTexts.includes("Starting implementation."), `agent continued after approval: ${JSON.stringify(agentTexts)}`);
  await waitFor(() => !api.plan.text.includes("waiting for approval"), 15_000, "the approval note to disappear");
});
