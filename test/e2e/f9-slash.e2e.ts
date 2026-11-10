/** F9 — slash commands are routed on the client (Kiro V3 does not execute them from prompt text). */
import { assert, assertEqual, ensureReady, freshSession, messagesOf, runPrompt, test, textOf, waitFor } from "./harness.js";

test("F9.1 /clear starts a new session", async ({ api }) => {
  const before = await freshSession(api);
  await runPrompt(api, "/scenario chat");
  await runPrompt(api, "/clear");
  await waitFor(() => {
    const s = api.controller.snapshot();
    return s.sessionId && s.sessionId !== before && s.items.length === 0 ? true : undefined;
  }, 15_000, "a fresh, empty session after /clear");
});

test("F9.2 /usage calls the advertised _kiro/account/getUsage and shows the result locally", async ({ api }) => {
  await ensureReady(api);
  await freshSession(api);
  await runPrompt(api, "/usage");
  const reply = await waitFor(() => {
    const msgs = messagesOf(api.controller.snapshot());
    const last = msgs[msgs.length - 1];
    return last && last.role === "agent" ? textOf(last) : undefined;
  }, 15_000, "a local reply to /usage");
  assert(reply.includes("```json"), `reply is formatted JSON: ${reply.slice(0, 80)}`);
  assertEqual(api.controller.snapshot().turnActive, false, "no agent turn was started");
});

test("F9.3 /model sets the config option and /help lists built-ins", async ({ api }) => {
  await freshSession(api);
  const option = api.controller.snapshot().configOptions.find((o) => o.category === "model");
  assert(option && option.options && option.options.length > 1, "fake agent advertises a model option");
  const target = option.options.find((v) => v.value !== option.currentValue)!;
  await runPrompt(api, `/model ${target.value}`);
  await waitFor(
    () => (api.controller.snapshot().configOptions.find((o) => o.id === option.id)?.currentValue === target.value ? true : undefined),
    15_000,
    "model config option updated",
  );
  await runPrompt(api, "/help");
  const help = await waitFor(() => {
    const msgs = messagesOf(api.controller.snapshot());
    const last = msgs[msgs.length - 1];
    return last && last.role === "agent" && textOf(last).includes("/clear") ? textOf(last) : undefined;
  }, 15_000, "help text");
  assert(help.includes("/usage"), "help lists /usage because the fake agent advertises it");
  assert(api.controller.snapshot().commands.some((c) => c.name === "clear"), "built-in commands merged into the / popup list");
});
