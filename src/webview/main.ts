/**
 * Webview entry point. Wires the reducer, renderer and composer together and
 * handles user intents via `data-action` click delegation.
 */
import type { ContextChip, ToWebview } from "../ui/protocol";
import { Composer } from "./composer";
import { actionButton, h, icon } from "./dom";
import { copyText } from "./markdown";
import {
  TranscriptRenderer,
  effectiveChips,
  renderBanners,
  renderChips,
  renderHeader,
  renderNotices,
  renderPickers,
  renderPlanBar,
  statusAnnouncement,
  type LocalUi,
} from "./render";
import { clearsSession, initialState, reduce } from "./state";
import { loadShowSettings, post, saveShowSettings } from "./vscodeApi";

const app = document.getElementById("app");
if (!app) throw new Error("#app missing");

let state = initialState();
const local: LocalUi = {
  dismissedNotices: new Set(),
  toolOpen: new Map(),
  localChips: [],
  showSettings: loadShowSettings() ?? false,
};
let settingsPrefApplied = loadShowSettings() !== undefined;

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

const header = h("header", { class: "header" });
const banners = h("div", { class: "banners" });
banners.hidden = true;
const notices = h("div", { class: "notices" });
notices.hidden = true;
const items = h("div", { class: "items" });
const transcript = h("main", { class: "transcript", "aria-label": "Conversation" }, notices, items);
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

app.append(header, banners, h("div", { class: "transcript-wrap" }, transcript, jump), planBar, pickers, composer.el, live);

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

// Content may grow after a render (e.g. details toggled); keep following.
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => {
    if (stuckToBottom) transcript.scrollTop = transcript.scrollHeight;
    jump.hidden = stuckToBottom || nearBottom();
  }).observe(items);
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

function scheduleRender(): void {
  if (rafHandle) return;
  rafHandle = requestAnimationFrame(() => {
    rafHandle = 0;
    render();
  });
}

function render(): void {
  // The host default applies once, until the user toggles (then the local choice is persisted).
  if (!settingsPrefApplied && state.prefs) {
    local.showSettings = state.prefs.showSettings;
    settingsPrefApplied = true;
  }
  renderHeader(header, state, local);
  renderBanners(banners, state);
  renderNotices(notices, state, local);
  transcriptRenderer.render(state);
  renderPlanBar(planBar, state);
  renderPickers(pickers, state);
  if (!local.showSettings) pickers.hidden = true;
  else if (pickers.childElementCount > 0) pickers.hidden = false;
  renderChips(composer.chipsEl, effectiveChips(state, local));
  composer.setTurnActive(state.turnActive);
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
    case "cancel":
      post({ type: "cancel" });
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
      post({ type: "permissionAlways", requestId: d.request, decision: d.decision });
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

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

render();
post({ type: "ready" });
