/**
 * Pure reducer: `ToWebview` messages → `UiState`.
 *
 * No DOM access here so the logic can be unit-tested later. The reducer never
 * mutates its input; every changed container is copied so the renderer can use
 * reference equality to decide what to re-render.
 */
import type {
  MessageSegment,
  MessageView,
  PermissionView,
  ToWebview,
  ToolCallView,
  TranscriptItem,
  UiState,
} from "../ui/protocol";

export function initialState(): UiState {
  return {
    connection: { status: "stopped" },
    sessionId: null,
    sessions: [],
    turnActive: false,
    items: [],
    toolCalls: {},
    plan: [],
    permissions: [],
    modes: null,
    configOptions: [],
    models: null,
    commands: [],
    chips: [],
    notices: [],
  };
}

/** Defensive copy of a snapshot: every collection is present, arrays are fresh. */
function normalizeSnapshot(s: Partial<UiState> | null | undefined): UiState {
  const base = initialState();
  if (!s) return base;
  return {
    connection: s.connection ?? base.connection,
    // Host capability, not session state: kept as sent (absent on older hosts).
    acceptsPromptsDuringTurn: typeof s.acceptsPromptsDuringTurn === "boolean" ? s.acceptsPromptsDuringTurn : undefined,
    sessionId: s.sessionId ?? null,
    sessions: Array.isArray(s.sessions) ? s.sessions.slice() : [],
    turnActive: Boolean(s.turnActive),
    items: Array.isArray(s.items) ? s.items.slice() : [],
    toolCalls: s.toolCalls ? { ...s.toolCalls } : {},
    plan: Array.isArray(s.plan) ? s.plan.slice() : [],
    permissions: Array.isArray(s.permissions) ? s.permissions.slice() : [],
    modes: s.modes ?? null,
    configOptions: Array.isArray(s.configOptions) ? s.configOptions.slice() : [],
    models: s.models ?? null,
    commands: Array.isArray(s.commands) ? s.commands.slice() : [],
    chips: Array.isArray(s.chips) ? s.chips.slice() : [],
    notices: Array.isArray(s.notices) ? s.notices.slice() : [],
    // Host display defaults; applied once by main.ts until the user toggles.
    prefs: s.prefs && typeof s.prefs === "object" ? { ...s.prefs } : undefined,
  };
}

/** Appends a segment, merging consecutive text segments into one. */
export function appendSegment(segments: MessageSegment[], segment: MessageSegment): MessageSegment[] {
  const last = segments[segments.length - 1];
  if (last && last.type === "text" && segment.type === "text") {
    return [...segments.slice(0, -1), { type: "text", text: last.text + segment.text }];
  }
  return [...segments, segment];
}

function findMessageIndex(items: TranscriptItem[], messageId: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === "message" && it.message.id === messageId) return i;
  }
  return -1;
}

function hasToolItem(items: TranscriptItem[], toolCallId: string): boolean {
  return items.some((it) => it.type === "tool" && it.toolCallId === toolCallId);
}

/** Everything that belongs to a session; kept when only the connection changes. */
function clearedSession(state: UiState, sessionId: string | null): UiState {
  return {
    ...state,
    sessionId,
    // `sessions` is agent-wide and survives a session switch.
    turnActive: false,
    items: [],
    toolCalls: {},
    plan: [],
    permissions: [],
    notices: [],
  };
}

/** True when the message resets the session-scoped parts of the state. */
export function clearsSession(state: UiState, msg: ToWebview): boolean {
  return msg.type === "session" && (msg.sessionId === null || msg.sessionId !== state.sessionId);
}

export function reduce(state: UiState, msg: ToWebview): UiState {
  switch (msg.type) {
    case "state":
      return normalizeSnapshot(msg.state);

    case "connection":
      return { ...state, connection: msg.connection };

    case "session":
      if (clearsSession(state, msg)) {
        return clearedSession(state, msg.sessionId);
      }
      return state;

    case "sessions":
      // Always a fresh array so the panel renderer can rebuild on identity change.
      return { ...state, sessions: Array.isArray(msg.sessions) ? msg.sessions.slice() : [] };

    case "turn":
      return state.turnActive === msg.active ? state : { ...state, turnActive: msg.active };

    case "chunk": {
      const idx = findMessageIndex(state.items, msg.messageId);
      if (idx < 0) {
        const message: MessageView = { id: msg.messageId, role: msg.role, segments: [msg.segment] };
        return { ...state, items: [...state.items, { type: "message", message }] };
      }
      const existing = (state.items[idx] as { type: "message"; message: MessageView }).message;
      const message: MessageView = { ...existing, segments: appendSegment(existing.segments, msg.segment) };
      const items = state.items.slice();
      items[idx] = { type: "message", message };
      return { ...state, items };
    }

    case "messageDelivery": {
      const idx = findMessageIndex(state.items, msg.messageId);
      if (idx < 0) return state;
      const existing = (state.items[idx] as { type: "message"; message: MessageView }).message;
      const delivery = msg.delivery ?? undefined;
      if (existing.delivery === delivery) return state;
      // Drop the key entirely when cleared so the message equals a never-badged one.
      const { delivery: _dropped, ...rest } = existing;
      const message: MessageView = delivery ? { ...rest, delivery } : rest;
      const items = state.items.slice();
      items[idx] = { type: "message", message };
      return { ...state, items };
    }

    case "toolCall": {
      const call: ToolCallView = msg.call;
      const toolCalls = { ...state.toolCalls, [call.toolCallId]: call };
      const items = hasToolItem(state.items, call.toolCallId)
        ? state.items
        : [...state.items, { type: "tool", toolCallId: call.toolCallId } as TranscriptItem];
      return { ...state, toolCalls, items };
    }

    case "plan":
      return { ...state, plan: msg.entries.slice() };

    case "permission": {
      const request: PermissionView = msg.request;
      const permissions = state.permissions.some((p) => p.requestId === request.requestId)
        ? state.permissions.map((p) => (p.requestId === request.requestId ? request : p))
        : [...state.permissions, request];
      let toolCalls = state.toolCalls;
      let items = state.items;
      const call = state.toolCalls[request.toolCallId];
      if (!call) {
        // Permission for a tool call we have not seen yet: create a stub card so
        // the request has somewhere to live. A later `toolCall` replaces it.
        const stub: ToolCallView = {
          toolCallId: request.toolCallId,
          title: request.title,
          kind: request.kind,
          status: "pending",
          content: [],
          locations: [],
          pendingPermissionId: request.requestId,
        };
        toolCalls = { ...state.toolCalls, [request.toolCallId]: stub };
        if (!hasToolItem(items, request.toolCallId)) {
          items = [...items, { type: "tool", toolCallId: request.toolCallId }];
        }
      } else if (call.pendingPermissionId !== request.requestId) {
        toolCalls = { ...state.toolCalls, [call.toolCallId]: { ...call, pendingPermissionId: request.requestId } };
      }
      return { ...state, permissions, toolCalls, items };
    }

    case "permissionResolved": {
      const resolved = state.permissions.find((p) => p.requestId === msg.requestId);
      const permissions = state.permissions.filter((p) => p.requestId !== msg.requestId);
      let toolCalls = state.toolCalls;
      if (resolved) {
        const call = state.toolCalls[resolved.toolCallId];
        if (call && call.pendingPermissionId === msg.requestId) {
          const { pendingPermissionId: _dropped, ...rest } = call;
          toolCalls = { ...state.toolCalls, [call.toolCallId]: rest };
        }
      }
      return { ...state, permissions, toolCalls };
    }

    case "modes":
      return { ...state, modes: msg.modes };

    case "configOptions":
      return { ...state, configOptions: msg.options.slice() };

    case "models":
      return { ...state, models: msg.models };

    case "commands":
      return { ...state, commands: msg.commands.slice() };

    case "chips":
      return { ...state, chips: msg.chips.slice() };

    case "notice": {
      const notices = state.notices.some((n) => n.id === msg.notice.id)
        ? state.notices.map((n) => (n.id === msg.notice.id ? msg.notice : n))
        : [...state.notices, msg.notice];
      return { ...state, notices };
    }

    case "clearNotice":
      return { ...state, notices: state.notices.filter((n) => n.id !== msg.id) };

    case "fileSuggestions":
    case "focusInput":
      // Transient; handled by the composer, not part of UiState.
      return state;

    default:
      return state;
  }
}

/** Pending permission for a tool call, if any (derived from the list, not from `pendingPermissionId`). */
export function permissionForTool(state: UiState, toolCallId: string): PermissionView | undefined {
  return state.permissions.find((p) => p.toolCallId === toolCallId);
}

/** Approximate added/removed line counts for a diff (multiset difference of lines). */
export function diffLineCounts(oldText: string | null, newText: string): { added: number; removed: number } {
  const newLines = newText.length ? newText.split(/\r?\n/) : [];
  if (oldText === null || oldText === undefined) {
    return { added: newLines.length, removed: 0 };
  }
  const oldLines = oldText.length ? oldText.split(/\r?\n/) : [];
  const pool = new Map<string, number>();
  for (const l of oldLines) pool.set(l, (pool.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of newLines) {
    const n = pool.get(l) ?? 0;
    if (n > 0) pool.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of pool.values()) removed += n;
  return { added, removed };
}
