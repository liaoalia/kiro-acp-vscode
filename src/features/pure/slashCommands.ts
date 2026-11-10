/**
 * Client-side slash command router.
 *
 * Kiro CLI V3 no longer executes slash commands sent as prompt text; its ACP
 * migration guide maps each command to client behaviour, a standard ACP
 * method, or an advertised `_kiro/...` extension. This module decides what a
 * `/command` typed in the chat should do, given what the running agent
 * advertised. It is pure so it can be unit-tested.
 */
import type { CommandView, ConfigOptionView, ModeView } from "../../ui/protocol";

export interface SlashContext {
  /** `agentCapabilities._meta.kiro.extensionMethods` from initialize. */
  extensionMethods: readonly string[];
  modes: { currentModeId: string; availableModes: readonly ModeView[] } | null;
  configOptions: readonly ConfigOptionView[];
  /** Commands the agent advertised through `available_commands_update`. */
  agentCommands: readonly CommandView[];
}

export interface ParsedSlash {
  name: string;
  /** Everything after the command name, trimmed. */
  args: string;
}

/** A known command the connected agent does not support, with the reason. */
export interface UnavailableCommand {
  name: string;
  reason: string;
}

export type SlashAction =
  | { kind: "new_session" }
  | { kind: "cancel" }
  | { kind: "restart" }
  | { kind: "help"; commands: CommandView[]; unavailable: UnavailableCommand[] }
  /** Call an advertised Kiro extension method and show its result. */
  | { kind: "extension"; method: string; label: string }
  | { kind: "set_mode"; modeId: string }
  | { kind: "set_config"; configId: string; value: string }
  /** List the values of a config option (or all options when configId is undefined). */
  | { kind: "show_options"; configId?: string }
  /** Switch to the planner mode (when one exists) and optionally send the trailing text. */
  | { kind: "plan"; text: string; modeId: string | null }
  /** `/capabilities`: the controller lists what the agent advertised (methods, capabilities, modes, options). */
  | { kind: "capabilities" }
  /** The agent advertised this command: send the text through as a prompt. */
  | { kind: "forward" }
  | { kind: "unavailable"; name: string; reason: string };

/**
 * Documented Kiro extension method names. The real CLI did not advertise
 * these exact names, so {@link findExtension} matches advertised methods by
 * pattern instead; the documented names still match their pattern.
 */
const EXT = {
  usage: "_kiro/account/getUsage",
  compact: "_kiro/session/compact",
  context: "_kiro/session/context",
} as const;

type ExtCommand = keyof typeof EXT;

const EXT_PATTERNS: Record<ExtCommand, RegExp> = {
  usage: /usage|quota|credit/i,
  context: /session\/context|context$/i,
  compact: /compact|summari[sz]e/i,
};

/** The advertised extension method serving `name` (first match wins), if any. */
export function findExtension(ctx: SlashContext, name: ExtCommand): string | undefined {
  const pattern = EXT_PATTERNS[name];
  return ctx.extensionMethods.find((m) => pattern.test(m));
}

function extUnavailableReason(name: ExtCommand): string {
  return `the agent did not advertise a ${name} extension method (such as ${EXT[name]})`;
}

export function parseSlash(text: string): ParsedSlash | null {
  const m = /^\/([A-Za-z][\w-]*)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: m[2].trim() };
}

function findMode(ctx: SlashContext, needle: string): ModeView | undefined {
  const n = needle.toLowerCase();
  return ctx.modes?.availableModes.find((m) => m.id.toLowerCase() === n || m.name.toLowerCase() === n);
}

function plannerMode(ctx: SlashContext): ModeView | undefined {
  return ctx.modes?.availableModes.find((m) => /plan/i.test(m.id) || /plan/i.test(m.name));
}

function findOption(ctx: SlashContext, idOrCategory: string): ConfigOptionView | undefined {
  return (
    ctx.configOptions.find((o) => o.id === idOrCategory) ??
    ctx.configOptions.find((o) => o.category === idOrCategory)
  );
}

function matchValue(opt: ConfigOptionView, needle: string): string | undefined {
  const n = needle.toLowerCase();
  const hit = opt.options?.find((v) => v.value.toLowerCase() === n || v.name.toLowerCase() === n);
  return hit?.value;
}

function hasAgentCommand(ctx: SlashContext, name: string): boolean {
  return ctx.agentCommands.some((c) => c.name.toLowerCase() === name);
}

function configCommand(ctx: SlashContext, name: string, optionId: string, args: string): SlashAction {
  const opt = findOption(ctx, optionId);
  if (!opt) {
    if (hasAgentCommand(ctx, name)) return { kind: "forward" };
    return { kind: "unavailable", name, reason: `the agent did not advertise a "${optionId}" option` };
  }
  if (!args) return { kind: "show_options", configId: opt.id };
  const value = matchValue(opt, args);
  if (value === undefined) return { kind: "show_options", configId: opt.id };
  return { kind: "set_config", configId: opt.id, value };
}

/** Decide what a parsed slash command does for the current agent. */
export function routeSlash(parsed: ParsedSlash, ctx: SlashContext): SlashAction {
  const { name, args } = parsed;
  switch (name) {
    case "clear":
    case "new":
      return { kind: "new_session" };
    case "cancel":
    case "stop":
      return { kind: "cancel" };
    case "restart":
      return { kind: "restart" };
    case "help":
    case "?":
      return { kind: "help", commands: builtinCommands(ctx), unavailable: unavailableCommands(ctx) };
    case "usage":
    case "compact":
    case "context": {
      const method = findExtension(ctx, name);
      if (method) return { kind: "extension", method, label: name };
      if (hasAgentCommand(ctx, name)) return { kind: "forward" };
      return { kind: "unavailable", name, reason: extUnavailableReason(name) };
    }
    case "capabilities":
    case "caps":
      return { kind: "capabilities" };
    case "model":
      return configCommand(ctx, name, "model", args);
    case "effort":
      return configCommand(ctx, name, "effortLevel", args);
    case "mode":
    case "agent": {
      if (ctx.modes) {
        if (!args) return { kind: "show_options" };
        const mode = findMode(ctx, args);
        if (mode) return { kind: "set_mode", modeId: mode.id };
        return { kind: "show_options" };
      }
      return configCommand(ctx, name, "mode", args);
    }
    case "plan": {
      const mode = plannerMode(ctx);
      if (!mode && hasAgentCommand(ctx, name)) return { kind: "forward" };
      return { kind: "plan", text: args, modeId: mode?.id ?? null };
    }
    default:
      // Advertised or not, let the agent decide what an unknown command means
      // (custom prompts and skills are not always advertised).
      return { kind: "forward" };
  }
}

/** Built-in commands to merge into the `/` popup, in display order. */
export function builtinCommands(ctx: SlashContext): CommandView[] {
  const list: CommandView[] = [
    { name: "clear", description: "Start a new session" },
    { name: "help", description: "List available commands" },
    { name: "capabilities", description: "Show what the connected agent advertises" },
  ];
  if (ctx.modes || findOption(ctx, "mode")) list.push({ name: "mode", description: "Switch the agent mode", hint: "mode id" });
  if (plannerMode(ctx)) list.push({ name: "plan", description: "Switch to planner mode", hint: "what to plan" });
  if (findOption(ctx, "model")) list.push({ name: "model", description: "Change the model", hint: "model id" });
  if (findOption(ctx, "effortLevel")) list.push({ name: "effort", description: "Change the effort level", hint: "level" });
  if (findExtension(ctx, "usage")) list.push({ name: "usage", description: "Show account usage" });
  if (findExtension(ctx, "context")) list.push({ name: "context", description: "Show the session context" });
  if (findExtension(ctx, "compact")) list.push({ name: "compact", description: "Compact the conversation" });
  list.push({ name: "cancel", description: "Cancel the current turn" }, { name: "restart", description: "Restart the agent process" });
  return list;
}

/** Known commands this agent cannot serve (shown in /help so users know why). */
export function unavailableCommands(ctx: SlashContext): UnavailableCommand[] {
  const out: UnavailableCommand[] = [];
  const ext = (name: ExtCommand) => {
    if (!findExtension(ctx, name) && !hasAgentCommand(ctx, name)) {
      out.push({ name, reason: extUnavailableReason(name) });
    }
  };
  ext("usage");
  ext("context");
  ext("compact");
  if (!findOption(ctx, "effortLevel") && !hasAgentCommand(ctx, "effort")) {
    out.push({ name: "effort", reason: "the agent did not advertise an effortLevel option" });
  }
  if (!findOption(ctx, "model") && !hasAgentCommand(ctx, "model")) {
    out.push({ name: "model", reason: "the agent did not advertise a model option" });
  }
  return out;
}

/** Agent-advertised commands first, then built-ins the agent did not already name. */
export function mergeCommands(agentCommands: readonly CommandView[], ctx: SlashContext): CommandView[] {
  const seen = new Set(agentCommands.map((c) => c.name.toLowerCase()));
  const merged = [...agentCommands];
  for (const c of builtinCommands(ctx)) {
    if (!seen.has(c.name)) merged.push(c);
  }
  return merged;
}

/** Human-readable listing used by `show_options`. */
export function describeOptions(ctx: SlashContext, configId?: string): string {
  const lines: string[] = [];
  if (configId === undefined && ctx.modes) {
    lines.push(
      `Modes (current: ${ctx.modes.currentModeId}): ` +
        ctx.modes.availableModes.map((m) => `${m.id}${m.name !== m.id ? ` (${m.name})` : ""}`).join(", "),
    );
  }
  for (const opt of ctx.configOptions) {
    if (configId !== undefined && opt.id !== configId) continue;
    if (opt.type === "boolean") {
      lines.push(`${opt.id}: ${String(opt.currentValue)} (true/false)`);
      continue;
    }
    const values = (opt.options ?? []).map((v) => `${v.value}${v.name !== v.value ? ` (${v.name})` : ""}`).join(", ");
    lines.push(`${opt.id} (current: ${String(opt.currentValue)}): ${values}`);
  }
  return lines.length > 0 ? lines.join("\n") : "The agent did not advertise any options.";
}

/** Render an extension result as readable text (JSON pretty-printed when it is an object). */
export function formatExtensionResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === null || result === undefined) return "(no result)";
  try {
    return "```json\n" + JSON.stringify(result, null, 2) + "\n```";
  } catch {
    return String(result);
  }
}
