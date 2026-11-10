/**
 * Thin wrapper over the VS Code webview API.
 *
 * `acquireVsCodeApi` may only be called once per webview load, so this module
 * owns the single instance. Only the composer draft is persisted via
 * `setState`; everything else is rebuilt from the extension's `state` snapshot.
 */
import type { FromWebview } from "../ui/protocol";

declare function acquireVsCodeApi(): {
  postMessage(m: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
};

interface PersistedState {
  draft?: string;
  showSettings?: boolean;
  sessionPanelCollapsed?: boolean;
}

const api = acquireVsCodeApi();

export function post(message: FromWebview): void {
  api.postMessage(message);
}

function readState(): PersistedState {
  try {
    const s = api.getState();
    return s && typeof s === "object" ? (s as PersistedState) : {};
  } catch {
    return {};
  }
}

function writeState(patch: PersistedState): void {
  try {
    api.setState({ ...readState(), ...patch } satisfies PersistedState);
  } catch {
    // Persisting UI state is a convenience only.
  }
}

export function loadDraft(): string {
  const s = readState();
  return typeof s.draft === "string" ? s.draft : "";
}

export function saveDraft(draft: string): void {
  writeState({ draft });
}

/** `undefined` when the user never toggled the settings pane in this webview. */
export function loadShowSettings(): boolean | undefined {
  const s = readState();
  return typeof s.showSettings === "boolean" ? s.showSettings : undefined;
}

export function saveShowSettings(showSettings: boolean): void {
  writeState({ showSettings });
}

/** `undefined` when the user never toggled the session panel in this webview. */
export function loadSessionPanelCollapsed(): boolean | undefined {
  const s = readState();
  return typeof s.sessionPanelCollapsed === "boolean" ? s.sessionPanelCollapsed : undefined;
}

export function saveSessionPanelCollapsed(sessionPanelCollapsed: boolean): void {
  writeState({ sessionPanelCollapsed });
}
