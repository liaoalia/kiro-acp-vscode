/**
 * Pure transcript reducer: turns ACP `SessionUpdate`s into the webview model
 * (`src/ui/protocol.ts`). No `vscode` or Node imports; deterministic.
 *
 * `applyUpdate` never mutates its input state; it returns a new state plus the
 * incremental `ToWebview` messages the extension should forward.
 */
import type * as acp from "@agentclientprotocol/sdk";
import type {
  CommandView,
  ConfigOptionView,
  MessageRole,
  MessageSegment,
  MessageView,
  ModelView,
  PlanEntryView,
  ToWebview,
  ToolCallView,
  ToolContentView,
  ToolKind,
  ToolStatus,
  TranscriptItem,
  UiState,
} from "../../ui/protocol";

export type ModesView = UiState["modes"];

export interface OpenMessage {
  /** View id of the message currently receiving chunks. */
  id: string;
  role: MessageRole;
  /** Protocol `messageId` of that message when known. */
  messageId: string | null;
}

export interface TranscriptState {
  items: TranscriptItem[];
  toolCalls: Record<string, ToolCallView>;
  plan: PlanEntryView[];
  modes: ModesView;
  configOptions: ConfigOptionView[];
  commands: CommandView[];
  /** Message that still accepts chunks, or null when the next chunk starts a new one. */
  openMessage: OpenMessage | null;
  /** Monotonic counter used to mint message view ids. */
  nextMessageSeq: number;
}

export interface ApplyResult {
  state: TranscriptState;
  emits: ToWebview[];
}

const TOOL_KINDS: ReadonlySet<string> = new Set<ToolKind>([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);
const TOOL_STATUSES: ReadonlySet<string> = new Set<ToolStatus>([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
]);
const PLAN_PRIORITIES: ReadonlySet<string> = new Set(["high", "medium", "low"]);
const PLAN_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createTranscript(): TranscriptState {
  return {
    items: [],
    toolCalls: {},
    plan: [],
    modes: null,
    configOptions: [],
    commands: [],
    openMessage: null,
    nextMessageSeq: 1,
  };
}

// ---------------------------------------------------------------------------
// Converters (also used by the extension for session/new snapshots)
// ---------------------------------------------------------------------------

export function toToolKind(kind: unknown): ToolKind {
  return typeof kind === "string" && TOOL_KINDS.has(kind) ? (kind as ToolKind) : "other";
}

export function toToolStatus(status: unknown, fallback: ToolStatus = "pending"): ToolStatus {
  return typeof status === "string" && TOOL_STATUSES.has(status) ? (status as ToolStatus) : fallback;
}

/** Map a content block to a message segment. */
export function toMessageSegment(block: acp.ContentBlock): MessageSegment {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image", mimeType: block.mimeType };
    case "audio":
      return { type: "text", text: "[audio]" };
    case "resource_link":
      return { type: "resource", uri: block.uri, label: block.title ?? block.name ?? block.uri };
    case "resource": {
      const resource = block.resource;
      return { type: "resource", uri: resource.uri, label: resource.uri };
    }
    default:
      return { type: "text", text: "" };
  }
}

/** Map a content block that appears inside tool-call content to text. */
export function contentBlockToText(block: acp.ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    case "resource_link":
      return `[resource ${block.uri}]`;
    case "resource": {
      const resource = block.resource;
      if ("text" in resource && typeof resource.text === "string") return resource.text;
      return `[resource ${resource.uri}]`;
    }
    default:
      return "";
  }
}

export function toToolContent(content: readonly acp.ToolCallContent[] | null | undefined): ToolContentView[] {
  if (!Array.isArray(content)) return [];
  const out: ToolContentView[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    switch (item.type) {
      case "content":
        out.push({ type: "text", text: contentBlockToText(item.content) });
        break;
      case "diff":
        out.push({
          type: "diff",
          path: item.path,
          oldText: typeof item.oldText === "string" ? item.oldText : null,
          newText: typeof item.newText === "string" ? item.newText : "",
        });
        break;
      case "terminal":
        out.push({ type: "terminal", terminalId: item.terminalId, output: "" });
        break;
      default:
        break;
    }
  }
  return out;
}

export function toLocations(
  locations: readonly acp.ToolCallLocation[] | null | undefined,
): ToolCallView["locations"] {
  if (!Array.isArray(locations)) return [];
  return locations
    .filter((l): l is acp.ToolCallLocation => isRecord(l) && typeof l.path === "string")
    .map((l) => ({ path: l.path, line: l.line ?? null }));
}

export function readFailureReason(meta: unknown): string | undefined {
  if (!isRecord(meta)) return undefined;
  const kiro = meta.kiro;
  if (!isRecord(kiro)) return undefined;
  return typeof kiro.failureReason === "string" ? kiro.failureReason : undefined;
}

export function toToolCallView(call: acp.ToolCall): ToolCallView {
  const view: ToolCallView = {
    toolCallId: call.toolCallId,
    title: typeof call.title === "string" ? call.title : call.toolCallId,
    kind: toToolKind(call.kind),
    status: toToolStatus(call.status),
    content: toToolContent(call.content),
    locations: toLocations(call.locations),
  };
  if (call.rawInput !== undefined && call.rawInput !== null) view.rawInput = call.rawInput;
  if (call.rawOutput !== undefined && call.rawOutput !== null) view.rawOutput = call.rawOutput;
  const failureReason = readFailureReason(call._meta);
  if (failureReason) view.failureReason = failureReason;
  return view;
}

export function mergeToolCallUpdate(existing: ToolCallView, update: acp.ToolCallUpdate): ToolCallView {
  const next: ToolCallView = { ...existing, content: existing.content, locations: existing.locations };
  if (update.kind !== undefined && update.kind !== null) next.kind = toToolKind(update.kind);
  if (update.status !== undefined && update.status !== null) next.status = toToolStatus(update.status, existing.status);
  if (update.title !== undefined && update.title !== null) next.title = update.title;
  if (update.content !== undefined && update.content !== null) next.content = toToolContent(update.content);
  if (update.locations !== undefined && update.locations !== null) next.locations = toLocations(update.locations);
  if (update.rawInput !== undefined && update.rawInput !== null) next.rawInput = update.rawInput;
  if (update.rawOutput !== undefined && update.rawOutput !== null) next.rawOutput = update.rawOutput;
  const failureReason = readFailureReason(update._meta);
  if (failureReason) next.failureReason = failureReason;
  return next;
}

export function toPlanEntries(entries: readonly acp.PlanEntry[] | null | undefined): PlanEntryView[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e): e is acp.PlanEntry => isRecord(e) && typeof e.content === "string")
    .map((e) => ({
      content: e.content,
      priority: PLAN_PRIORITIES.has(e.priority) ? e.priority : "medium",
      status: PLAN_STATUSES.has(e.status) ? e.status : "pending",
    }));
}

export function toModesView(modes: acp.SessionModeState | null | undefined): ModesView {
  if (!isRecord(modes) || typeof modes.currentModeId !== "string") return null;
  const available = Array.isArray(modes.availableModes) ? modes.availableModes : [];
  return {
    currentModeId: modes.currentModeId,
    availableModes: available
      .filter((m): m is acp.SessionMode => isRecord(m) && typeof m.id === "string")
      .map((m) => ({ id: m.id, name: typeof m.name === "string" ? m.name : m.id, description: m.description ?? null })),
  };
}

/** Flatten select options (grouped or not) into a single list with an optional `group` label. */
export function flattenSelectOptions(
  options: acp.SessionConfigSelectOptions | null | undefined,
): NonNullable<ConfigOptionView["options"]> {
  if (!Array.isArray(options)) return [];
  const out: NonNullable<ConfigOptionView["options"]> = [];
  for (const entry of options as unknown[]) {
    if (!isRecord(entry)) continue;
    if (Array.isArray(entry.options)) {
      const group = typeof entry.name === "string" ? entry.name : typeof entry.group === "string" ? entry.group : undefined;
      for (const option of entry.options as unknown[]) {
        if (!isRecord(option) || typeof option.value !== "string") continue;
        out.push({
          value: option.value,
          name: typeof option.name === "string" ? option.name : option.value,
          description: typeof option.description === "string" ? option.description : null,
          ...(group !== undefined ? { group } : {}),
        });
      }
    } else if (typeof entry.value === "string") {
      out.push({
        value: entry.value,
        name: typeof entry.name === "string" ? entry.name : entry.value,
        description: typeof entry.description === "string" ? entry.description : null,
      });
    }
  }
  return out;
}

export function toConfigOptionViews(options: readonly acp.SessionConfigOption[] | null | undefined): ConfigOptionView[] {
  if (!Array.isArray(options)) return [];
  const out: ConfigOptionView[] = [];
  for (const option of options) {
    if (typeof option !== "object" || option === null || typeof option.id !== "string") continue;
    const base = {
      id: option.id,
      name: typeof option.name === "string" ? option.name : option.id,
      description: typeof option.description === "string" ? option.description : null,
      category: typeof option.category === "string" ? option.category : null,
    };
    if (option.type === "boolean") {
      out.push({ ...base, type: "boolean", currentValue: option.currentValue === true });
    } else if (option.type === "select") {
      out.push({
        ...base,
        type: "select",
        currentValue: typeof option.currentValue === "string" ? option.currentValue : "",
        options: flattenSelectOptions(option.options),
      });
    }
  }
  return out;
}

export function toCommandViews(commands: readonly acp.AvailableCommand[] | null | undefined): CommandView[] {
  if (!Array.isArray(commands)) return [];
  return commands
    .filter((c): c is acp.AvailableCommand => isRecord(c) && typeof c.name === "string")
    .map((c) => {
      const view: CommandView = { name: c.name, description: typeof c.description === "string" ? c.description : "" };
      const hint = isRecord(c.input) && typeof c.input.hint === "string" ? c.input.hint : undefined;
      if (hint !== undefined) view.hint = hint;
      return view;
    });
}

export function toModelView(
  models: { currentModelId: string; availableModels: ModelView["availableModels"] } | null | undefined,
): ModelView | null {
  if (!models) return null;
  return {
    currentModelId: models.currentModelId,
    availableModels: models.availableModels.map((m) => ({
      modelId: m.modelId,
      name: m.name,
      description: m.description ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function roleFor(kind: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk"): MessageRole {
  switch (kind) {
    case "user_message_chunk":
      return "user";
    case "agent_thought_chunk":
      return "thought";
    default:
      return "agent";
  }
}

function appendSegment(segments: readonly MessageSegment[], segment: MessageSegment): MessageSegment[] {
  const last = segments[segments.length - 1];
  if (segment.type === "text" && last && last.type === "text") {
    return [...segments.slice(0, -1), { type: "text", text: last.text + segment.text }];
  }
  return [...segments, segment];
}

function applyChunk(
  state: TranscriptState,
  role: MessageRole,
  chunk: acp.ContentChunk,
): ApplyResult {
  if (!isRecord(chunk.content) || typeof chunk.content.type !== "string") return { state, emits: [] };
  const segment = toMessageSegment(chunk.content);
  const messageId = typeof chunk.messageId === "string" ? chunk.messageId : null;
  const open = state.openMessage;
  const canAppend =
    open !== null &&
    open.role === role &&
    (messageId === null || open.messageId === null || open.messageId === messageId);

  if (canAppend && open) {
    const items = state.items.map((item) =>
      item.type === "message" && item.message.id === open.id
        ? { ...item, message: { ...item.message, segments: appendSegment(item.message.segments, segment) } }
        : item,
    );
    const openMessage: OpenMessage =
      open.messageId === null && messageId !== null ? { ...open, messageId } : open;
    return {
      state: { ...state, items, openMessage },
      emits: [{ type: "chunk", messageId: open.id, role, segment }],
    };
  }

  const id = `msg-${state.nextMessageSeq}`;
  const message: MessageView = { id, role, segments: [segment] };
  return {
    state: {
      ...state,
      items: [...state.items, { type: "message", message }],
      openMessage: { id, role, messageId },
      nextMessageSeq: state.nextMessageSeq + 1,
    },
    emits: [{ type: "chunk", messageId: id, role, segment }],
  };
}

function upsertToolCall(state: TranscriptState, view: ToolCallView, closeMessage: boolean): ApplyResult {
  const exists = Object.prototype.hasOwnProperty.call(state.toolCalls, view.toolCallId);
  const items = exists ? state.items : [...state.items, { type: "tool", toolCallId: view.toolCallId } as TranscriptItem];
  return {
    state: {
      ...state,
      items,
      toolCalls: { ...state.toolCalls, [view.toolCallId]: view },
      openMessage: closeMessage ? null : state.openMessage,
    },
    emits: [{ type: "toolCall", call: view }],
  };
}

export function applyUpdate(state: TranscriptState, update: acp.SessionUpdate): ApplyResult {
  if (!isRecord(update) || typeof update.sessionUpdate !== "string") return { state, emits: [] };
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return applyChunk(state, roleFor(update.sessionUpdate), update);

    case "tool_call": {
      if (typeof update.toolCallId !== "string") return { state, emits: [] };
      return upsertToolCall(state, toToolCallView(update), true);
    }

    case "tool_call_update": {
      if (typeof update.toolCallId !== "string") return { state, emits: [] };
      const existing = state.toolCalls[update.toolCallId];
      if (existing) {
        return upsertToolCall(state, mergeToolCallUpdate(existing, update), false);
      }
      // Update for a call we never saw: synthesize a card so nothing is lost.
      const placeholder: ToolCallView = {
        toolCallId: update.toolCallId,
        title: update.toolCallId,
        kind: "other",
        status: "pending",
        content: [],
        locations: [],
      };
      return upsertToolCall(state, mergeToolCallUpdate(placeholder, update), true);
    }

    case "plan": {
      const plan = toPlanEntries(update.entries);
      return { state: { ...state, plan }, emits: [{ type: "plan", entries: plan }] };
    }

    case "current_mode_update": {
      if (typeof update.currentModeId !== "string") return { state, emits: [] };
      const modes: ModesView = state.modes
        ? { ...state.modes, currentModeId: update.currentModeId }
        : { currentModeId: update.currentModeId, availableModes: [] };
      return { state: { ...state, modes }, emits: [{ type: "modes", modes }] };
    }

    case "config_option_update": {
      const configOptions = toConfigOptionViews(update.configOptions);
      return { state: { ...state, configOptions }, emits: [{ type: "configOptions", options: configOptions }] };
    }

    case "available_commands_update": {
      const commands = toCommandViews(update.availableCommands);
      return { state: { ...state, commands }, emits: [{ type: "commands", commands }] };
    }

    default:
      return { state, emits: [] };
  }
}

/** Apply several updates in order, concatenating the emits. */
export function applyUpdates(state: TranscriptState, updates: readonly acp.SessionUpdate[]): ApplyResult {
  let current = state;
  const emits: ToWebview[] = [];
  for (const update of updates) {
    const result = applyUpdate(current, update);
    current = result.state;
    emits.push(...result.emits);
  }
  return { state: current, emits };
}

/** Seed the transcript's session-level views from a `session/new`-style snapshot. */
export function withSessionSnapshot(
  state: TranscriptState,
  snapshot: {
    modes?: acp.SessionModeState | null;
    configOptions?: readonly acp.SessionConfigOption[] | null;
    availableCommands?: readonly acp.AvailableCommand[] | null;
  },
): TranscriptState {
  return {
    ...state,
    modes: snapshot.modes === undefined ? state.modes : toModesView(snapshot.modes),
    configOptions:
      snapshot.configOptions === undefined ? state.configOptions : toConfigOptionViews(snapshot.configOptions),
    commands:
      snapshot.availableCommands === undefined ? state.commands : toCommandViews(snapshot.availableCommands),
  };
}

export type UiStateExtras = Pick<
  UiState,
  "connection" | "sessionId" | "sessions" | "turnActive" | "permissions" | "models" | "chips" | "notices"
>;

/** Combine the transcript with host-owned fields into a full `UiState` snapshot. */
export function snapshotToUiState(state: TranscriptState, extras: UiStateExtras): UiState {
  return {
    connection: extras.connection,
    sessionId: extras.sessionId,
    sessions: extras.sessions,
    turnActive: extras.turnActive,
    items: state.items,
    toolCalls: state.toolCalls,
    plan: state.plan,
    permissions: extras.permissions,
    modes: state.modes,
    configOptions: state.configOptions,
    models: extras.models,
    commands: state.commands,
    chips: extras.chips,
    notices: extras.notices,
  };
}
