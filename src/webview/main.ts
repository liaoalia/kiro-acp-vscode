/**
 * Webview entry point. Wires the reducer, renderer and composer together and
 * handles user intents via `data-action` click delegation.
 */
import type { ContextChip, PermissionScope, ToWebview } from "../ui/protocol";
import { Composer } from "./composer";
import { actionButton, h, icon } from "./dom";
import { copyText } from "./markdown";
import {
  TranscriptRenderer,
  currentModeName,
  currentModelName,
  effectiveChips,
  renderBanners,
  renderChips,
  renderEmpty,
  renderHeader,
  renderNotices,
  renderPickers,
  renderPlanBar,
  renderSessionPanel,
  renderWorkingStrip,
  statusAnnouncement,
  type LocalUi,
} from "./render";
import { clearsSession, initialState, reduce } from "./state";
import {
  loadSessionPanelCollapsed,
  loadShowSettings,
  post,
  saveSessionPanelCollapsed,
  saveShowSettings,
} from "./vscodeApi";

const app = document.getElementById("app");
if (!app) throw new Error("#app missing");

let state = initialState();
const local: LocalUi = {
  dismissedNotices: new Set(),
  toolOpen: new Map(),
  localChips: [],
  showSettings: loadShowSettings() ?? false,
  sessionPanelCollapsed: loadSessionPanelCollapsed() ?? false,
};
let settingsPrefApplied = loadShowSettings() !== undefined;
let panelPrefApplied = loadSessionPanelCollapsed() !== undefined;

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

const header = h("header", { class: "header" });
const banners = h("div", { class: "banners" });
banners.hidden = true;
const notices = h("div", { class: "notices" });
notices.hidden = true;
const empty = h("div", { class: "empty" });
empty.hidden = true;
const items = h("div", { class: "items" });
// "Kiro is working…" strip; sits below the last item so it counts as the bottom for auto-scroll.
const working = h("div", { class: "working" });
working.hidden = true;
// The transcript is the only scroll container; its content sits in a centered column.
const transcript = h(
  "main",
  { class: "transcript", "aria-label": "Conversation" },
  h("div", { class: "column transcript-col" }, notices, empty, items, working),
);
const jump = actionButton("jump-bottom", [icon("down"), "Jump to latest"], {
  cls: "jump",
  ariaLabel: "Scroll to the latest message",
});
jump.hidden = true;
const planBar = h("div", { class: "planbar" });
planBar.hidden = true;
const pickers = h("div", { class: "pickers", role: "toolbar", "aria-label": "Session options" });
pickers.hidden = true;
const live = h("div", { class: "sr-only", "aria-live": "polite", "aria-atomic": "true" });
// Wide-layout session panel on the right; hidden by the stylesheet below 640px.
const sessionPanel = h("aside", { class: "session-panel", "aria-label": "Sessions" });

const composer = new Composer({
  getChips: () => effectiveChips(state, local),
  addLocalChip: (chip: ContextChip) => {
    if (!local.localChips.some((c) => c.id === chip.id) && !state.chips.some((c) => c.id === chip.id)) {
      local.localChips.push(chip);
    }
    scheduleRender();
  },
  onSent: () => {
    local.localChips = [];
    scheduleRender();
  },
  getCommands: () => state.commands,
});

app.append(
  header,
  h(
    "div",
    { class: "body" },
    h(
      "div",
      { class: "main-col" },
      h("div", { class: "column banners-col" }, banners),
      h("div", { class: "transcript-wrap" }, transcript, jump),
      h("div", { class: "column bottom-col" }, planBar, pickers, composer.el),
    ),
    sessionPanel,
  ),
  live,
);

const transcriptRenderer = new TranscriptRenderer(items, local);

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------

let stuckToBottom = true;

function nearBottom(): boolean {
  // Nothing to scroll (or the view is hidden and has no height) counts as "at bottom".
  if (transcript.clientHeight === 0 || transcript.scrollHeight <= transcript.clientHeight + 1) return true;
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 24;
}

transcript.addEventListener("scroll", () => {
  stuckToBottom = nearBottom();
  jump.hidden = stuckToBottom;
});

function scrollToBottom(): void {
  transcript.scrollTop = transcript.scrollHeight;
  stuckToBottom = true;
  jump.hidden = true;
}

// Content may grow after a render (e.g. details toggled, working strip shown); keep following.
if (typeof ResizeObserver !== "undefined") {
  const ro = new ResizeObserver(() => {
    if (stuckToBottom) transcript.scrollTop = transcript.scrollHeight;
    jump.hidden = stuckToBottom || nearBottom();
  });
  ro.observe(items);
  ro.observe(working);
}
window.addEventListener("resize", () => {
  if (stuckToBottom) transcript.scrollTop = transcript.scrollHeight;
  jump.hidden = stuckToBottom || nearBottom();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let rafHandle = 0;
let lastAnnouncement = "";
let fullRenderPending = false;

/** `"sessions"` re-renders only the session panel and header (cheap path for `sessions` messages). */
function scheduleRender(scope: "all" | "sessions" = "all"): void {
  if (scope === "all") fullRenderPending = true;
  if (rafHandle) return;
  rafHandle = requestAnimationFrame(() => {
    rafHandle = 0;
    if (fullRenderPending) {
      fullRenderPending = false;
      render();
    } else {
      renderSessions();
    }
  });
}

/** Host defaults apply once, until the user toggles (then the local choice is persisted). */
function applyPrefs(): void {
  if (!settingsPrefApplied && state.prefs) {
    local.showSettings = state.prefs.showSettings;
    settingsPrefApplied = true;
  }
  if (!panelPrefApplied && state.prefs) {
    local.sessionPanelCollapsed = state.prefs.sessionPanelCollapsed ?? false;
    panelPrefApplied = true;
  }
}

function renderSessions(): void {
  applyPrefs();
  renderSessionPanel(sessionPanel, state, local);
  renderHeader(header, state, local);
  // The empty-state hint mentions other sessions.
  renderEmpty(empty, state);
}

function render(): void {
  applyPrefs();
  renderSessionPanel(sessionPanel, state, local);
  renderHeader(header, state, local);
  renderBanners(banners, state);
  renderNotices(notices, state, local);
  renderEmpty(empty, state);
  transcriptRenderer.render(state);
  renderWorkingStrip(working, state);
  renderPlanBar(planBar, state);
  renderPickers(pickers, state);
  if (!local.showSettings) pickers.hidden = true;
  else if (pickers.childElementCount > 0) pickers.hidden = false;
  renderChips(composer.chipsEl, effectiveChips(state, local));
  composer.setMeta({ model: currentModelName(state), mode: currentModeName(state), settingsOpen: local.showSettings });
  composer.setTurnActive(state.turnActive, state.acceptsPromptsDuringTurn === true);
  if (stuckToBottom) scrollToBottom();
  jump.hidden = stuckToBottom;
  const announcement = statusAnnouncement(state);
  if (announcement !== lastAnnouncement) {
    lastAnnouncement = announcement;
    live.textContent = announcement;
  }
}

// ---------------------------------------------------------------------------
// Incoming messages
// ---------------------------------------------------------------------------

function resetLocal(): void {
  local.dismissedNotices.clear();
  local.toolOpen.clear();
  local.localChips = [];
  stuckToBottom = true;
}

function handle(msg: ToWebview): void {
  switch (msg.type) {
    case "fileSuggestions":
      composer.setSuggestions(msg.query, msg.items);
      return;
    case "focusInput":
      composer.focus();
      return;
    case "state":
      if ((msg.state?.sessionId ?? null) !== state.sessionId) resetLocal();
      stuckToBottom = true;
      break;
    case "session":
      if (clearsSession(state, msg)) resetLocal();
      break;
    case "sessions":
      state = reduce(state, msg);
      scheduleRender("sessions");
      return;
    case "chips": {
      const ids = new Set(msg.chips.map((c) => c.id));
      local.localChips = local.localChips.filter((c) => !ids.has(c.id));
      break;
    }
    default:
      break;
  }
  state = reduce(state, msg);
  scheduleRender();
}

window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data as ToWebview | undefined;
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
  handle(msg);
});

// ---------------------------------------------------------------------------
// User intents (delegated)
// ---------------------------------------------------------------------------

function flashButton(btn: HTMLElement, text: string): void {
  const label = btn.querySelector<HTMLElement>(".copy-label");
  if (!label) return;
  const old = label.textContent;
  label.textContent = text;
  window.setTimeout(() => {
    label.textContent = old;
  }, 1200);
}

app.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-action]");
  if (!target || target.hasAttribute("disabled")) return;
  const d = target.dataset;
  switch (d.action) {
    case "new-session":
      post({ type: "newSession" });
      break;
    case "browse-sessions":
      post({ type: "browseSessions" });
      break;
    case "select-session":
      if (d.sessionId && d.sessionId !== state.sessionId) post({ type: "selectSession", sessionId: d.sessionId });
      break;
    case "close-session":
      // Nested in the row: never let the row's select fire for this click.
      event.stopPropagation();
      if (d.sessionId) post({ type: "closeSession", sessionId: d.sessionId });
      break;
    case "toggle-session-panel":
      local.sessionPanelCollapsed = !local.sessionPanelCollapsed;
      panelPrefApplied = true;
      saveSessionPanelCollapsed(local.sessionPanelCollapsed);
      scheduleRender("sessions");
      return;
    case "cancel":
      post({ type: "cancel" });
      break;
    case "send":
      composer.send();
      break;
    case "add-context":
      composer.insertAtMention();
      break;
    case "insert-slash":
      composer.insertSlash();
      break;
    case "restart":
      post({ type: "restart" });
      break;
    case "show-log":
      post({ type: "showLog" });
      break;
    case "login":
      if (d.method) post({ type: "login", methodId: d.method });
      break;
    case "open-plan":
      post({ type: "openPlan" });
      break;
    case "dismiss-notice":
      if (d.id) local.dismissedNotices.add(d.id);
      scheduleRender();
      break;
    case "toggle-tool": {
      if (!d.tool) break;
      const expanded = target.getAttribute("aria-expanded") === "true";
      local.toolOpen.set(d.tool, !expanded);
      scheduleRender();
      break;
    }
    case "open-file": {
      if (!d.path) break;
      const line = d.line ? Number(d.line) : undefined;
      post(line !== undefined && Number.isFinite(line) ? { type: "openFile", path: d.path, line } : { type: "openFile", path: d.path });
      break;
    }
    case "open-diff":
      if (d.tool) post({ type: "openDiff", toolCallId: d.tool, index: Number(d.index ?? 0) || 0 });
      break;
    case "show-terminal":
      if (d.terminal) post({ type: "showTerminal", terminalId: d.terminal });
      break;
    case "perm-option": {
      if (!d.request || !d.option) break;
      post({ type: "permissionResponse", requestId: d.request, optionId: d.option });
      // Prevent double submission until the extension resolves the request.
      const group = target.closest<HTMLElement>(".perm");
      group?.querySelectorAll("button").forEach((b) => (b.disabled = true));
      break;
    }
    case "perm-always": {
      if (!d.request || (d.decision !== "allow" && d.decision !== "reject")) break;
      const scope: PermissionScope | undefined =
        d.scope === "kind" || d.scope === "capability" || d.scope === "resource" ? d.scope : undefined;
      post({ type: "permissionAlways", requestId: d.request, decision: d.decision, scope });
      const group = target.closest<HTMLElement>(".perm");
      group?.querySelectorAll("button").forEach((b) => (b.disabled = true));
      break;
    }
    case "remove-chip": {
      if (!d.id) break;
      local.localChips = local.localChips.filter((c) => c.id !== d.id);
      post({ type: "removeChip", id: d.id });
      scheduleRender();
      break;
    }
    case "toggle-settings":
      local.showSettings = !local.showSettings;
      settingsPrefApplied = true;
      saveShowSettings(local.showSettings);
      scheduleRender();
      return;
    case "jump-bottom":
      scrollToBottom();
      break;
    case "copy-code": {
      const pre = target.closest(".codeblock")?.querySelector("pre");
      if (!pre) break;
      void copyText(pre.textContent ?? "").then((ok) => flashButton(target, ok ? "Copied" : "Failed"));
      break;
    }
    default:
      break;
  }
});

// Keyboard support for the session list: Enter/Space select, arrows move, Delete closes.
sessionPanel.addEventListener("keydown", (event) => {
  const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(".sp-row");
  if (!row || event.target !== row) return;
  switch (event.key) {
    case "Enter":
    case " ":
      event.preventDefault();
      row.click();
      break;
    case "ArrowDown":
    case "ArrowUp": {
      event.preventDefault();
      const rows = Array.from(sessionPanel.querySelectorAll<HTMLElement>(".sp-row"));
      const i = rows.indexOf(row);
      const next = rows[event.key === "ArrowDown" ? i + 1 : i - 1];
      next?.focus();
      break;
    }
    case "Delete":
    case "Backspace": {
      const id = row.dataset.sessionId;
      if (!id) break;
      event.preventDefault();
      post({ type: "closeSession", sessionId: id });
      break;
    }
    default:
      break;
  }
});

// Relative times in the panel ("5m") drift; refresh them once a minute.
window.setInterval(() => {
  if (state.sessions.length > 0) scheduleRender("sessions");
}, 60_000);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

render();
post({ type: "ready" });
