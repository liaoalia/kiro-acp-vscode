/**
 * The tools the agent link offers to every Kiro session (D30). Stage 1 has
 * one read-only tool, `list_sessions`; messaging, reading and waiting come in
 * later stages (docs/plans/2026-11-13-agent-link.md). vscode-free.
 */
import type { AgentLinkHost, AgentLinkTool, LinkedSessionInfo, LinkedSessionStatus, ToolResult } from "./types.js";

/** `initialize` instructions: what the server is, in one paragraph the model reads. */
export const AGENT_LINK_INSTRUCTIONS =
  "Tools for the Kiro chat sessions open in this VS Code window. Each chat tab (and the sidebar) " +
  "can hold several sessions, each with its own agent. `list_sessions` shows them all with a short " +
  "handle (like `s2`), title, tab and status, and marks the session you are in with `self`.";

const STATUS_TEXT: Record<LinkedSessionStatus, string> = {
  working: "working",
  idle: "idle",
  needs_input: "waiting for the user",
  restoring: "restoring",
};

/** `s3 "Fix the login bug" · tab "Kiro Chat 2" · idle` */
function describeSession(s: LinkedSessionInfo): string {
  return `${s.handle} ${JSON.stringify(s.title)} · tab ${JSON.stringify(s.tab)} · ${STATUS_TEXT[s.status]}`;
}

/**
 * The text of a `list_sessions` result: the caller first, then the others in
 * the order given (most recent first). Pure, for tests.
 */
export function formatSessionList(sessions: readonly LinkedSessionInfo[]): string {
  const self = sessions.find((s) => s.self);
  const others = sessions.filter((s) => !s.self);
  const lines: string[] = [];
  lines.push(self ? `You are ${describeSession(self)}.` : "Your own session is not listed (it may be closing).");
  if (others.length === 0) {
    lines.push("There are no other sessions.");
  } else {
    lines.push(`Other sessions (${others.length}):`);
    for (const s of others) lines.push(`- ${describeSession(s)}`);
  }
  return lines.join("\n");
}

function listSessionsTool(host: AgentLinkHost): AgentLinkTool {
  return {
    definition: {
      name: "list_sessions",
      title: "List chat sessions",
      description:
        "List the Kiro chat sessions open in this VS Code window: handle, title, chat tab, status " +
        "(working, idle, waiting for the user, restoring). The entry with `self: true` is your own session.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "List chat sessions", readOnlyHint: true, openWorldHint: false },
    },
    call(_args, caller): ToolResult {
      const sessions = host.listSessions(caller.sessionId);
      return {
        content: [{ type: "text", text: formatSessionList(sessions) }],
        structuredContent: {
          sessions: sessions.map((s) => ({
            handle: s.handle,
            title: s.title,
            tab: s.tab,
            status: s.status,
            self: s.self,
          })),
        },
      };
    },
  };
}

/** Every agent-link tool, bound to `host`. */
export function createAgentLinkTools(host: AgentLinkHost): AgentLinkTool[] {
  return [listSessionsTool(host)];
}
