/**
 * Recognise Kiro's own `session/request_permission` for a tool of the agent
 * link's MCP server (D30), so the extension can answer it itself
 * (`kiroAcp.agentLink.autoApprove`): the extension's own confirmation
 * (`kiroAcp.agentLink.confirm`) already guards sending and starting, and the
 * other tools only read. Pure; vscode-free.
 *
 * The real request's shape is not recorded yet, so every field that could
 * name the tool is looked at — the request's tool call title and raw input,
 * the title of the tool call it refers to, and `_meta.kiro.consent` — and a
 * match needs the server's name (`kiro-acp-tabs`, or `kiro_acp_tabs` when an
 * agent sanitises it), never a bare tool name another server could share.
 */
import type * as acp from "@agentclientprotocol/sdk";
import { AGENT_LINK_SERVER_NAME } from "./types.js";

/** The agent link's tool names (for the log line about a near miss). */
export const AGENT_LINK_TOOL_NAMES = ["list_sessions", "read_session", "send_message", "wait_for_session", "start_session"] as const;

const SERVER_PATTERN = new RegExp(AGENT_LINK_SERVER_NAME.replace(/-/g, "[-_]"), "i");
const TOOL_PATTERN = new RegExp(`\\b(${AGENT_LINK_TOOL_NAMES.join("|")})\\b`, "i");

export type AgentLinkPermissionMatch =
  /** The request is for a tool of the agent link's server. */
  | { kind: "match"; text: string }
  /** It names one of the tools but not the server: not answered, worth a log line. */
  | { kind: "near"; text: string }
  | { kind: "none" };

/** The strings of a permission request that may name the tool. */
function describedBy(req: acp.RequestPermissionRequest, referencedTitle?: string): string[] {
  const texts: string[] = [];
  const call = req.toolCall as (acp.ToolCallUpdate & { rawInput?: unknown }) | undefined;
  if (typeof call?.title === "string") texts.push(call.title);
  if (typeof referencedTitle === "string") texts.push(referencedTitle);
  const meta = req._meta as Record<string, unknown> | null | undefined;
  const kiro = meta && typeof meta === "object" ? (meta["kiro"] as Record<string, unknown> | undefined) : undefined;
  const consent = kiro && typeof kiro === "object" ? (kiro["consent"] as Record<string, unknown> | undefined) : undefined;
  if (consent && typeof consent === "object") {
    for (const key of ["resource", "capability"]) {
      const value = consent[key];
      if (typeof value === "string") texts.push(value);
    }
  }
  if (call?.rawInput !== undefined) {
    try {
      const raw = JSON.stringify(call.rawInput);
      if (typeof raw === "string") texts.push(raw.slice(0, 2000));
    } catch {
      /* not serialisable: ignored */
    }
  }
  return texts;
}

/**
 * Whether `req` asks to run a tool of the agent link's server.
 * `referencedTitle` is the title of the transcript tool call the request
 * refers to (Kiro V3 may send a bare request, D23).
 */
export function matchAgentLinkPermission(
  req: acp.RequestPermissionRequest,
  referencedTitle?: string,
): AgentLinkPermissionMatch {
  const texts = describedBy(req, referencedTitle);
  const server = texts.find((t) => SERVER_PATTERN.test(t));
  if (server !== undefined) return { kind: "match", text: server };
  const tool = texts.find((t) => TOOL_PATTERN.test(t));
  if (tool !== undefined) return { kind: "near", text: tool };
  return { kind: "none" };
}
