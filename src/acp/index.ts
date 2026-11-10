/**
 * Public entry point of the ACP layer (vscode-free).
 */
export * from "./types.js";
export {
  KiroAgentImpl,
  createKiroAgent,
  toAcpError,
  buildSessionState,
  readModelState,
  readKiroExtensionMethods,
  mapV2Commands,
  CLIENT_NAME,
  CLIENT_TITLE,
  KIRO_OPEN_EXTERNAL_URL,
  KIRO_V2_COMMANDS_AVAILABLE,
  SESSION_SET_MODEL,
} from "./client.js";
export { resolveCliPath, spawnAgentProcess, terminateProcess } from "./process.js";
export type { ExistsFn, AgentChildProcess, SpawnAgentOptions, ProcessExit } from "./process.js";
export { createChildStream, interceptNotifications, LineTap, readLines } from "./stream.js";
