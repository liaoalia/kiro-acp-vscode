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
}

const api = acquireVsCodeApi();

export function post(message: FromWebview): void {
  api.postMessage(message);
}

export function loadDraft(): string {
  try {
    const s = api.getState() as PersistedState | undefined;
    return typeof s?.draft === "string" ? s.draft : "";
  } catch {
    return "";
  }
}

export function saveDraft(draft: string): void {
  try {
    api.setState({ draft } satisfies PersistedState);
  } catch {
    // Persisting the draft is a convenience only.
  }
}
