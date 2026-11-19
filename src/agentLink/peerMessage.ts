/**
 * How a peer message (agent link, D30) reads to the agent that receives it.
 * Pure; vscode-free. CONTRACT STUB — implemented in plan Task 9.
 */
import { PEER_MESSAGE_MAX_BYTES } from "./types.js";

/** The session a peer message comes from. */
export interface PeerSender {
  handle: string;
  title: string;
  /** Human name of its chat tab ("Kiro Chat 2", "Sidebar"). */
  tab: string;
}

/**
 * The prompt text the target agent gets for `text` from `from`: says it is a
 * message from another agent session (handle, title, tab), not an instruction
 * from the user, then the text, then how to answer (`send_message` to the
 * sender's handle) — or that no answer is needed when the text says so.
 * `chainDepth` (1 = sent by a user-started turn) is included when > 1 so the
 * model knows the conversation is a chain.
 */
export function framePeerMessage(from: PeerSender, text: string, chainDepth: number): string {
  void from;
  void chainDepth;
  return text;
}

/** UTF-8 length of `text`. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** True when `text` fits {@link PEER_MESSAGE_MAX_BYTES}. */
export function fitsPeerMessage(text: string): boolean {
  return utf8Bytes(text) <= PEER_MESSAGE_MAX_BYTES;
}
