/** F7 — permissions: per-tool-kind session policy and policy reset on new session. */
import {
  assert,
  assertEqual,
  closeAllEditors,
  deleteWorkspaceFile,
  freshSession,
  lastStopReason,
  proposalTabsOpen,
  proposedDiffTabs,
  runPrompt,
  test,
  toolCall,
  waitFor,
  withTimeout,
  workspaceFileExists,
} from "./harness.js";

test("F7.1 setPolicy(reject) answers the request and later requests of that kind automatically", async ({ api, recorder }) => {
  await freshSession(api);
  await closeAllEditors();
  await deleteWorkspaceFile("config.json");

  // Turn 1: a pending request appears; remember "reject" for edit tools.
  const mark1 = recorder.mark();
  const turn1 = api.controller.prompt("/scenario permission-reject", []);
  const permission = await waitFor(() => api.permissions.pending()[0], 15_000, "a pending permission request");
  assertEqual(permission.kind, "edit", "permission tool kind");
  await waitFor(() => proposedDiffTabs().length > 0, 15_000, "the proposal diff editor");

  api.permissions.setPolicy(permission.requestId, "reject");
  assertEqual(api.permissions.pending().length, 0, "the request is answered immediately");
  await withTimeout(turn1, 30_000, "turn 1");
  await waitFor(() => !api.controller.snapshot().turnActive, 15_000, "turn 1 to end");

  let call = toolCall(api.controller.snapshot(), "call-edit");
  assertEqual(call.status, "failed", "turn 1 tool call status");
  assertEqual(call.failureReason, "denied", "turn 1 failure reason");
  assertEqual(lastStopReason(recorder, mark1), "end_turn", "turn 1 stop reason");
  assertEqual(recorder.ofType("permission", mark1).length, 1, "one permission request was shown in turn 1");
  await waitFor(() => !proposalTabsOpen(), 15_000, "proposal editors to close");

  // Turn 2: same tool kind, same session → auto-rejected, nothing pending.
  const mark2 = recorder.mark();
  await runPrompt(api, "/scenario permission-reject");
  assertEqual(recorder.ofType("permission", mark2).length, 0, "no permission request was shown in turn 2");
  assertEqual(api.permissions.pending().length, 0, "nothing is pending after turn 2");
  call = toolCall(api.controller.snapshot(), "call-edit");
  assertEqual(call.status, "failed", "turn 2 tool call status");
  assertEqual(call.failureReason, "denied", "turn 2 failure reason");
  assertEqual(await workspaceFileExists("config.json"), false, "config.json was never written");
});

test("F7.2 newSession() clears remembered policies", async ({ api, recorder }) => {
  // Establish a reject policy in the current session first.
  await freshSession(api);
  const setup = api.controller.prompt("/scenario permission-reject", []);
  const first = await waitFor(() => api.permissions.pending()[0], 15_000, "a pending permission request");
  await waitFor(() => proposedDiffTabs().length > 0, 15_000, "the proposal diff editor");
  api.permissions.setPolicy(first.requestId, "reject");
  await withTimeout(setup, 30_000, "setup turn");
  await waitFor(() => !api.controller.snapshot().turnActive, 15_000, "setup turn to end");

  const mark = recorder.mark();
  await runPrompt(api, "/scenario permission-reject");
  assertEqual(recorder.ofType("permission", mark).length, 0, "policy still applies within the session");

  await freshSession(api);
  const mark3 = recorder.mark();
  const turn3 = api.controller.prompt("/scenario permission-reject", []);
  const again = await waitFor(() => api.permissions.pending()[0], 15_000, "a pending permission after newSession");
  assertEqual(again.kind, "edit", "pending request kind after newSession");
  assertEqual(recorder.ofType("permission", mark3).length, 1, "the request was shown again");
  await waitFor(() => proposedDiffTabs().length > 0, 15_000, "the proposal diff editor");

  const rejectOption = again.options.find((o) => o.kind === "reject_once");
  assert(rejectOption, "the agent offers a reject_once option");
  api.permissions.resolve(again.requestId, rejectOption.optionId);
  await withTimeout(turn3, 30_000, "turn 3");
  await waitFor(() => !api.controller.snapshot().turnActive, 15_000, "turn 3 to end");
  const call = toolCall(api.controller.snapshot(), "call-edit");
  assertEqual(call.status, "failed", "turn 3 tool call status");
  assertEqual(call.failureReason, "denied", "turn 3 failure reason");
  await waitFor(() => !proposalTabsOpen(), 15_000, "proposal editors to close");
});

test("F7.3 permissionAlways with scope=resource auto-allows the same path and still asks for another", async ({ api, recorder }) => {
  await freshSession(api);
  await closeAllEditors();
  await deleteWorkspaceFile("config.json");
  await deleteWorkspaceFile("nokind.txt");

  // Turn 1: nokind.txt asks (with Kiro consent meta); remember "allow" for that one resource.
  const mark1 = recorder.mark();
  const turn1 = api.controller.prompt("/scenario permission-nokind", []);
  const permission = await waitFor(() => api.permissions.pending()[0], 15_000, "a pending permission request");
  assertEqual(permission.kind, "edit", "permission tool kind");
  const resource = permission.policies?.find((p) => p.scope === "resource");
  assert(resource, `a resource policy is offered: ${JSON.stringify(permission.policies)}`);
  assertEqual(resource.label, "Allow all changes to nokind.txt this session", "resource label");
  await waitFor(() => proposedDiffTabs().length > 0, 15_000, "the proposal diff editor");

  await api.controller.handle({ type: "permissionAlways", requestId: permission.requestId, decision: "allow", scope: "resource" });
  assertEqual(api.permissions.pending().length, 0, "the request is answered immediately");
  await withTimeout(turn1, 30_000, "turn 1");
  await waitFor(() => !api.controller.snapshot().turnActive, 15_000, "turn 1 to end");
  assertEqual(toolCall(api.controller.snapshot(), "call-nokind").status, "completed", "turn 1 tool call status");
  assertEqual(recorder.ofType("permission", mark1).length, 1, "one permission request was shown in turn 1");
  await waitFor(() => workspaceFileExists("nokind.txt"), 15_000, "nokind.txt to be written");
  await waitFor(() => !proposalTabsOpen(), 15_000, "proposal editors to close");

  // Turn 2: the same path → auto-allowed, nothing shown.
  await deleteWorkspaceFile("nokind.txt");
  const mark2 = recorder.mark();
  await runPrompt(api, "/scenario permission-nokind");
  assertEqual(recorder.ofType("permission", mark2).length, 0, "no permission request was shown in turn 2");
  assertEqual(toolCall(api.controller.snapshot(), "call-nokind").status, "completed", "turn 2 tool call status");
  assertEqual(await workspaceFileExists("nokind.txt"), true, "nokind.txt was written again without asking");

  // Turn 3: another path of the same kind (and no consent meta at all) → still asks.
  const mark3 = recorder.mark();
  const turn3 = api.controller.prompt("/scenario permission-reject", []);
  const other = await waitFor(() => api.permissions.pending()[0], 15_000, "a pending permission for config.json");
  assertEqual(other.toolCallId, "call-edit", "the other path asks");
  assertEqual(recorder.ofType("permission", mark3).length, 1, "the request for the other path was shown");
  assertEqual(
    (other.policies ?? []).map((p) => p.scope).join(","),
    "kind",
    "without consent meta only the kind policy is offered",
  );
  await waitFor(() => proposedDiffTabs().length > 0, 15_000, "the proposal diff editor");
  const reject = other.options.find((o) => o.kind === "reject_once");
  assert(reject, "the agent offers a reject_once option");
  api.permissions.resolve(other.requestId, reject.optionId);
  await withTimeout(turn3, 30_000, "turn 3");
  await waitFor(() => !api.controller.snapshot().turnActive, 15_000, "turn 3 to end");
  assertEqual(await workspaceFileExists("config.json"), false, "config.json was not written");
  await waitFor(() => !proposalTabsOpen(), 15_000, "proposal editors to close");
});

test("F7.4 a request without toolCall.kind takes the kind of the known tool call and offers all three scopes", async ({ api, recorder }) => {
  await freshSession(api);
  await closeAllEditors();
  await deleteWorkspaceFile("nokind.txt");
  await deleteWorkspaceFile("config.json");

  const turn = api.controller.prompt("/scenario permission-nokind", []);
  const permission = await waitFor(() => api.permissions.pending()[0], 15_000, "a pending permission request");
  assertEqual(permission.toolCallId, "call-nokind", "permission tool call id");
  assertEqual(permission.kind, "edit", "kind resolved from the tool_call update, not 'other'");
  assertEqual(permission.consent?.capability, "fs_write", "consent capability");
  const policies = permission.policies ?? [];
  assertEqual(policies.map((p) => p.scope).join(","), "kind,capability,resource", "offered policy scopes");
  assertEqual(policies[0]?.label, "Allow all edits this session", "kind label");
  assertEqual(policies[1]?.label, "Allow all fs_write this session", "capability label");
  assertEqual(policies[1]?.rejectLabel, "Reject all fs_write this session", "capability reject label");
  assertEqual(policies[2]?.label, "Allow all changes to nokind.txt this session", "resource label");
  assertEqual(policies[2]?.rejectLabel, "Reject all changes to nokind.txt this session", "resource reject label");
  await waitFor(() => proposedDiffTabs().length > 0, 15_000, "the proposal diff editor");

  // A kind-scoped reject taken on the kind-less request applies to later edits of other files.
  await api.controller.handle({ type: "permissionAlways", requestId: permission.requestId, decision: "reject", scope: "kind" });
  assertEqual(api.permissions.pending().length, 0, "the request is answered immediately");
  await withTimeout(turn, 30_000, "turn 1");
  await waitFor(() => !api.controller.snapshot().turnActive, 15_000, "turn 1 to end");
  let call = toolCall(api.controller.snapshot(), "call-nokind");
  assertEqual(call.status, "failed", "turn 1 tool call status");
  assertEqual(call.failureReason, "denied", "turn 1 failure reason");
  await waitFor(() => !proposalTabsOpen(), 15_000, "proposal editors to close");

  const mark2 = recorder.mark();
  await runPrompt(api, "/scenario permission-reject");
  assertEqual(recorder.ofType("permission", mark2).length, 0, "the edit rule applies to config.json too");
  call = toolCall(api.controller.snapshot(), "call-edit");
  assertEqual(call.status, "failed", "turn 2 tool call status");
  assertEqual(await workspaceFileExists("config.json"), false, "config.json was never written");
  assertEqual(await workspaceFileExists("nokind.txt"), false, "nokind.txt was never written");
});
