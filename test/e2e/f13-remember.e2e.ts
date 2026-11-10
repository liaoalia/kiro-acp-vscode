/** F13 — remembered session options: mode / config options chosen once are applied to every new session (D24). */
import * as vscode from "vscode";

import {
  assert,
  assertEqual,
  ensureReady,
  freshSession,
  messagesOf,
  runPrompt,
  test,
  textOf,
  waitFor,
} from "./harness.js";
import type { KiroAcpApi } from "../../src/extension.js";
import type { ConfigOptionView } from "../../src/ui/protocol.js";

const SETTING = "rememberSessionOptions";

async function setRememberSetting(value: boolean | undefined): Promise<void> {
  await vscode.workspace.getConfiguration("kiroAcp").update(SETTING, value, vscode.ConfigurationTarget.Workspace);
}

function modelOption(api: KiroAcpApi): ConfigOptionView | undefined {
  return api.controller.snapshot().configOptions.find((o) => o.category === "model");
}

function otherValue(option: ConfigOptionView): string {
  const target = option.options?.find((v) => v.value !== option.currentValue);
  assert(target, `option ${option.id} offers another value`);
  return target.value;
}

async function setConfigOption(api: KiroAcpApi, configId: string, value: string | boolean): Promise<void> {
  await api.controller.handle({ type: "setConfigOption", configId, value });
  await waitFor(
    () => (api.controller.snapshot().configOptions.find((o) => o.id === configId)?.currentValue === value ? true : undefined),
    15_000,
    `config option ${configId} = ${String(value)} in the current session`,
  );
}

/** The fake agent's default model / mode, captured before anything is remembered. */
let defaultModel = "";
let defaultMode = "";
let chosenModel = "";

test("F13.1 a model and a mode chosen in session A are applied to the next session", async ({ api }) => {
  await ensureReady(api);
  await setRememberSetting(undefined);
  await api.controller.forgetSessionOptions();
  assertEqual(api.controller.rememberedSessionOptions(), null, "nothing remembered after forget");

  const a = await freshSession(api);
  const option = modelOption(api);
  assert(option && option.options && option.options.length > 1, "fake agent advertises a model option");
  defaultModel = String(option.currentValue);
  defaultMode = api.controller.snapshot().modes?.currentModeId ?? "";
  assert(defaultMode, "fake agent advertises modes");
  chosenModel = otherValue(option);

  await setConfigOption(api, option.id, chosenModel);
  await api.controller.handle({ type: "setMode", modeId: "plan" });
  await waitFor(() => (api.controller.snapshot().modes?.currentModeId === "plan" ? true : undefined), 15_000, "mode plan in A");

  const remembered = api.controller.rememberedSessionOptions();
  assertEqual(remembered?.configOptions[option.id], chosenModel, "the model is remembered");
  assertEqual(remembered?.modeId, "plan", "the mode is remembered");

  const b = await freshSession(api);
  assert(b !== a, "a second session");
  const state = api.controller.snapshot();
  assertEqual(state.sessionId, b, "session B is displayed");
  assertEqual(modelOption(api)?.currentValue, chosenModel, "session B starts with the remembered model");
  assertEqual(state.modes?.currentModeId, "plan", "session B starts in the remembered mode");

  await runPrompt(api, "/capabilities");
  const reply = await waitFor(() => {
    const msgs = messagesOf(api.controller.snapshot());
    const last = msgs[msgs.length - 1];
    return last && last.role === "agent" ? textOf(last) : undefined;
  }, 15_000, "the /capabilities reply");
  const line = reply.split("\n").find((l) => l.startsWith("Remembered for new sessions:"));
  assert(line, `/capabilities ends with the remembered options: ${reply.slice(-200)}`);
  assert(line.includes(chosenModel) && line.includes("plan"), `remembered line names the model and the mode: ${line}`);
});

test("F13.2 forgetSessionOptions() returns the next session to the agent's defaults", async ({ api }) => {
  assertEqual(modelOption(api)?.currentValue, chosenModel, "the remembered model is still in effect");
  await api.controller.forgetSessionOptions();
  assertEqual(api.controller.rememberedSessionOptions(), null, "nothing remembered");
  await freshSession(api);
  assertEqual(modelOption(api)?.currentValue, defaultModel, "model back to the default");
  assertEqual(api.controller.snapshot().modes?.currentModeId, defaultMode, "mode back to the default");
});

test("F13.3 with kiroAcp.rememberSessionOptions off nothing is applied or recorded", async ({ api }) => {
  await freshSession(api);
  const option = modelOption(api)!;
  await setConfigOption(api, option.id, chosenModel);
  assertEqual(api.controller.rememberedSessionOptions()?.configOptions[option.id], chosenModel, "remembered while on");

  await setRememberSetting(false);
  try {
    await freshSession(api);
    assertEqual(modelOption(api)?.currentValue, defaultModel, "not applied while the setting is off");
    // A change made while the setting is off is not recorded either.
    const effort = api.controller.snapshot().configOptions.find((o) => o.id === "effortLevel");
    assert(effort, "fake agent advertises effortLevel");
    await setConfigOption(api, effort.id, otherValue(effort));
    assertEqual(api.controller.rememberedSessionOptions()?.configOptions[effort.id], undefined, "effortLevel not recorded");
  } finally {
    await setRememberSetting(undefined);
    await api.controller.forgetSessionOptions();
  }
  await freshSession(api);
  assertEqual(modelOption(api)?.currentValue, defaultModel, "defaults again once forgotten");
});
