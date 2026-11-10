/**
 * DOM rendering of `UiState`. Small sections (banners, notices, plan bar,
 * pickers, chips) are rebuilt wholesale; the header and the session panel are
 * updated in place from memoised inputs; the transcript is reconciled by key
 * and a message/tool card is only re-rendered when its view object changed
 * (the reducer guarantees a new object on every change).
 *
 * Interactive elements carry `data-action` and are handled by delegation in
 * `main.ts`, except pickers whose `<select>` elements get direct listeners.
 */
import type {
  ConnectionView,
  ContextChip,
  MessageView,
  PermissionView,
  SessionSummary,
  ToolCallView,
  TranscriptItem,
  UiState,
} from "../ui/protocol";
import {
  SESSION_STATUS_GLYPH,
  SESSION_STATUS_LABEL,
  TOOL_KIND_LABEL,
  TOOL_STATUS_LABEL,
  actionButton,
  clear,
  h,
  icon,
  mascot,
  reconcileChildren,
  safeJson,
  sessionStatusIcon,
  setChildren,
  shortPath,
  statusBadge,
  toolKindIcon,
} from "./dom";
import { renderMarkdownInto } from "./markdown";
import { diffLineCounts, permissionForTool } from "./state";
import { post } from "./vscodeApi";

/** UI-only state that is not part of the protocol snapshot. */
export interface LocalUi {
  /** Notice ids the user dismissed locally. */
  dismissedNotices: Set<string>;
  /** Explicit open/closed overrides for tool cards. */
  toolOpen: Map<string, boolean>;
  /** `@` chips added locally and not yet echoed by the extension. */
  localChips: ContextChip[];
  /** Whether the mode/model/option pickers are shown (settings toggle). */
  showSettings: boolean;
  /** Whether the wide-layout session panel is collapsed to icons. */
  sessionPanelCollapsed: boolean;
}

/** Separators for memo keys built from several strings. */
const SEP = "\u0001";
const ROW_SEP = "\u0002";

// ---------------------------------------------------------------------------
// Sessions (shared by header and panel)
// ---------------------------------------------------------------------------

/** Title of the displayed session; "New session" until the host names it. */
export function displayedSessionTitle(state: UiState): string {
  const s = state.sessions.find((x) => x.id === state.sessionId);
  const title = s?.title?.trim();
  return title && title.length > 0 ? title : "New session";
}

/** Number of sessions waiting for the user. */
export function needsInputCount(state: UiState): number {
  let n = 0;
  for (const s of state.sessions) if (s.status === "needs_input") n++;
  return n;
}

/** True when the user could switch to another live session. */
export function hasOtherSessions(state: UiState): boolean {
  return state.sessions.some((s) => s.id !== state.sessionId);
}

/** Compact relative time: "now", "5m", "2h", "3d". */
export function relativeTime(updatedAt: number, now: number): string {
  const diff = Math.max(0, now - updatedAt);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function fullTime(updatedAt: number): string {
  const d = new Date(updatedAt);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : "";
}

/** Identity of a session list as the header/select sees it: id, title and status of every row. */
function sessionOptionsKey(sessions: SessionSummary[]): string {
  return sessions.map((s) => `${s.id}${SEP}${s.title ?? ""}${SEP}${s.status}`).join(ROW_SEP);
}

// ---------------------------------------------------------------------------
// Header / banners
// ---------------------------------------------------------------------------

export function statusText(c: ConnectionView): string {
  switch (c.status) {
    case "ready": {
      const name = c.agentName ?? "Ready";
      return c.agentVersion ? `${name} ${c.agentVersion}` : name;
    }
    case "starting":
      return "Starting…";
    case "stopped":
      return "Stopped";
    case "auth_required":
      return "Sign in required";
    case "error":
      return "Error";
    default:
      return String(c.status);
  }
}

/** What the displayed session is doing, when that matters more than the connection status. */
export type Activity = "needs_input" | "working" | null;

export function activityOf(state: UiState): Activity {
  if (state.permissions.length > 0) return "needs_input";
  if (state.turnActive) return "working";
  return null;
}

/** Text of the header status pill: activity of the displayed session, else the connection. */
export function pillText(state: UiState): string {
  switch (activityOf(state)) {
    case "needs_input":
      return "Needs input";
    case "working":
      return "Working…";
    default:
      return statusText(state.connection);
  }
}

/** Text for the `aria-live` region. */
export function statusAnnouncement(state: UiState): string {
  const base = `Kiro: ${statusText(state.connection)}.`;
  if (state.connection.status !== "ready") return base;
  switch (activityOf(state)) {
    case "needs_input":
      return `${base} Waiting for your input.`;
    case "working":
      return `${base} Working on your request.`;
    default:
      return `${base} Ready for input.`;
  }
}

/** True when the agent advertises anything the settings panel can show. */
export function hasSettings(state: UiState): boolean {
  return (state.modes?.availableModes.length ?? 0) > 0 || state.configOptions.length > 0 || state.models !== null;
}

/** Display name of the current model (config option with category `model`, else `models`). */
export function currentModelName(state: UiState): string | undefined {
  const opt = state.configOptions.find((o) => o.category === "model" && o.type === "select");
  if (opt) {
    const value = String(opt.currentValue);
    return opt.options?.find((o) => o.value === value)?.name ?? value;
  }
  const models = state.models;
  if (models) {
    return models.availableModels.find((m) => m.modelId === models.currentModelId)?.name ?? models.currentModelId;
  }
  return undefined;
}

/** Display name of the current mode (config option with category/id `mode`, else `modes`). */
export function currentModeName(state: UiState): string | undefined {
  const opt = state.configOptions.find((o) => (o.category === "mode" || o.id === "mode") && o.type === "select");
  if (opt) {
    const value = String(opt.currentValue);
    return opt.options?.find((o) => o.value === value)?.name ?? value;
  }
  const modes = state.modes;
  if (modes && modes.availableModes.length > 0) {
    return modes.availableModes.find((m) => m.id === modes.currentModeId)?.name ?? modes.currentModeId;
  }
  return undefined;
}

/**
 * Persistent header skeleton: `[brand] [session select] [spacer] [actions]`.
 * Each slot is refilled only when the string key of its own inputs changes,
 * so e.g. a `sessions` update with new `updatedAt` values touches nothing and
 * a `turn` change never replaces the compact `<select>` (which may be open).
 */
interface HeaderDom {
  el: HTMLElement;
  brand: HTMLElement;
  brandKey: string;
  sessionSlot: HTMLElement;
  /** The `.hdr-session` wrapper, its `<select>` and the badge host; `null` when there are no sessions. */
  session: { wrap: HTMLElement; select: HTMLSelectElement; badge: HTMLElement } | null;
  selectKey: string;
  pendingKey: string;
  actions: HTMLElement;
  actionsKey: string;
}
let headerDom: HeaderDom | null = null;

function ensureHeaderDom(el: HTMLElement): HeaderDom {
  if (headerDom && headerDom.el === el) return headerDom;
  const brand = h("div", { class: "brand" });
  const sessionSlot = h("span", { class: "hdr-session-slot" });
  const actions = h("span", { class: "hdr-actions" });
  setChildren(el, [brand, sessionSlot, h("span", { class: "spacer" }), actions]);
  headerDom = { el, brand, brandKey: "", sessionSlot, session: null, selectKey: "", pendingKey: "", actions, actionsKey: "" };
  return headerDom;
}

function renderBrand(dom: HeaderDom, state: UiState): void {
  const c = state.connection;
  const text = pillText(state);
  const title = displayedSessionTitle(state);
  const activity = activityOf(state);
  const key = [text, c.status, c.message ?? "", activity ?? "", title].join(SEP);
  if (key === dom.brandKey) return;
  dom.brandKey = key;
  setChildren(dom.brand, [
    h("span", { class: "brand-name", title }, icon("kiro", "icon brand-icon"), h("span", { class: "brand-text" }, title)),
    h(
      "div",
      {
        class: `status-pill status-${c.status}${activity ? ` status-${activity}` : ""}`,
        title: c.message && !activity ? `${text}: ${c.message}` : text,
      },
      h("span", { class: "dot", "aria-hidden": "true" }),
      h("span", { class: "status-text" }, text),
    ),
  ]);
}

/**
 * Compact-layout session switcher: a `<select>` with a status glyph per
 * option. The element is kept while its options (id, title, status) are
 * unchanged; only the selection and the "needs input" badge are updated.
 */
function renderSessionSelect(dom: HeaderDom, state: UiState): void {
  const hasCurrent = state.sessionId !== null && state.sessions.some((s) => s.id === state.sessionId);
  const key = state.sessions.length === 0 ? "" : `${hasCurrent ? "1" : "0"}${ROW_SEP}${sessionOptionsKey(state.sessions)}`;
  if (key !== dom.selectKey) {
    dom.selectKey = key;
    if (state.sessions.length === 0) {
      dom.session = null;
      clear(dom.sessionSlot);
    } else {
      const select = h("select", { class: "hdr-session-select", "aria-label": "Session" });
      if (!hasCurrent) {
        // Displayed session is not in the list (e.g. none yet): show a placeholder.
        select.appendChild(h("option", { value: "", disabled: true }, "Sessions"));
      }
      for (const s of state.sessions) {
        const title = s.title?.trim() || "New session";
        select.appendChild(
          h(
            "option",
            { value: s.id, title: `${SESSION_STATUS_LABEL[s.status] ?? s.status}: ${title}` },
            `${SESSION_STATUS_GLYPH[s.status] ?? ""} ${title}`,
          ),
        );
      }
      select.addEventListener("change", () => {
        if (select.value && select.value !== currentSessionId) post({ type: "selectSession", sessionId: select.value });
      });
      const badge = h("span", { class: "hdr-badge-host" });
      const wrap = h("span", { class: "hdr-session" }, select, badge);
      dom.session = { wrap, select, badge };
      dom.pendingKey = "";
      setChildren(dom.sessionSlot, [wrap]);
    }
  }
  currentSessionId = state.sessionId;
  const session = dom.session;
  if (!session) return;
  const value = hasCurrent ? (state.sessionId as string) : "";
  if (session.select.value !== value) session.select.value = value;
  const pending = needsInputCount(state);
  const pendingKey = String(pending);
  if (pendingKey !== dom.pendingKey) {
    dom.pendingKey = pendingKey;
    session.wrap.title = pending > 0 ? `${pending} session${pending === 1 ? "" : "s"} need${pending === 1 ? "s" : ""} your input` : "";
    setChildren(session.badge, [
      pending > 0 ? h("span", { class: "count-badge hdr-badge", "aria-label": `${pending} sessions need input` }, String(pending)) : null,
    ]);
  }
}
/** Displayed session id as last rendered; read by the select's change handler. */
let currentSessionId: string | null = null;

function renderHeaderActions(dom: HeaderDom, state: UiState, local: LocalUi): void {
  const hasPlan = state.plan.length > 0;
  const settings = hasSettings(state);
  const key = [state.turnActive, settings, local.showSettings, hasPlan].join(SEP);
  if (key === dom.actionsKey) return;
  dom.actionsKey = key;
  setChildren(dom.actions, [
    state.turnActive
      ? actionButton("cancel", [icon("stop"), h("span", { class: "btn-text" }, "Cancel")], {
          cls: "btn btn-secondary btn-sm hdr-cancel",
          title: "Cancel the current turn",
          ariaLabel: "Cancel the current turn",
        })
      : null,
    actionButton("new-session", [icon("plus"), h("span", { class: "btn-text" }, "New")], {
      cls: "btn btn-ghost btn-sm hdr-btn",
      title: "Start a new session",
      ariaLabel: "Start a new session",
    }),
    settings
      ? actionButton("toggle-settings", [icon("gear")], {
          cls: `btn btn-ghost btn-sm btn-icon hdr-btn${local.showSettings ? " is-active" : ""}`,
          title: local.showSettings ? "Hide session settings" : "Show session settings (mode, model, options)",
          ariaLabel: "Toggle session settings",
          pressed: local.showSettings,
        })
      : null,
    hasPlan
      ? actionButton("open-plan", [icon("plan")], {
          cls: "btn btn-ghost btn-sm btn-icon hdr-btn hdr-plan",
          title: "Open the plan",
          ariaLabel: "Open the plan",
        })
      : null,
  ]);
}

/**
 * Header: the `.brand` block doubles as the compact status pill (narrow) and
 * the title + muted status text (wide); the stylesheet switches the look.
 * The pill shows the displayed session's activity ("Working…", "Needs input")
 * over the connection status. Text labels (`.btn-text`) and the Cancel button
 * are hidden in the wide layout, where Cancel lives in the composer's stop
 * button instead.
 */
export function renderHeader(el: HTMLElement, state: UiState, local: LocalUi): void {
  const dom = ensureHeaderDom(el);
  renderBrand(dom, state);
  renderSessionSelect(dom, state);
  renderHeaderActions(dom, state, local);
}

let emptyMemo: { others: boolean } | null = null;

/**
 * Empty state: brand line at the top, mascot + tagline in the middle. Shown
 * only while the transcript has no items and no permission is pending.
 */
export function renderEmpty(el: HTMLElement, state: UiState): void {
  const show = state.items.length === 0 && state.permissions.length === 0;
  if (!show) {
    if (el.childElementCount > 0) clear(el);
    emptyMemo = null;
    el.hidden = true;
    return;
  }
  const others = hasOtherSessions(state);
  if (el.childElementCount === 0 || !emptyMemo || emptyMemo.others !== others) {
    emptyMemo = { others };
    setChildren(el, [
      h("div", { class: "empty-brand" }, icon("kiro", "icon brand-icon"), h("span", { class: "brand-text" }, "Kiro")),
      h(
        "div",
        { class: "empty-center" },
        mascot(56),
        h("p", { class: "empty-tagline" }, "// TODO: build the next thing. Ask Kiro."),
        others
          ? h(
              "p",
              { class: "empty-hint" },
              h("span", { class: "hint-wide" }, "Pick a session on the right or start a new one."),
              h("span", { class: "hint-compact" }, "Pick a session above or start a new one."),
            )
          : null,
      ),
    ]);
  }
  el.hidden = false;
}

// ---------------------------------------------------------------------------
// Session panel (wide layout)
// ---------------------------------------------------------------------------

/**
 * Persistent panel skeleton: `[new] [list] [toggle]`. Rows are cached per
 * session id and rebuilt only when their own key changes; the list is
 * reconciled in place so a focused row keeps focus.
 */
interface PanelDom {
  el: HTMLElement;
  list: HTMLElement;
  toggle: HTMLButtonElement;
  toggleKey: string;
  rows: Map<string, { key: string; el: HTMLElement }>;
  /** Key of the last render; equal keys skip everything. */
  key: string;
}
let panelDom: PanelDom | null = null;

function ensurePanelDom(el: HTMLElement): PanelDom {
  if (panelDom && panelDom.el === el) return panelDom;
  const list = h("div", { class: "sp-list", role: "listbox", "aria-label": "Sessions" });
  const toggle = actionButton("toggle-session-panel", [], { cls: "sp-toggle" });
  setChildren(el, [
    actionButton("new-session", [icon("plus"), h("span", { class: "sp-label" }, "New session")], {
      cls: "sp-new",
      title: "Start a new session",
      ariaLabel: "Start a new session",
    }),
    list,
    toggle,
  ]);
  panelDom = { el, list, toggle, toggleKey: "", rows: new Map(), key: "" };
  return panelDom;
}

/** Row identity: title, status, selection, layout and the minute bucket of `updatedAt` (plus the label it yields). */
function sessionRowKey(s: SessionSummary, selected: boolean, collapsed: boolean, now: number): string {
  return [s.title ?? "", s.status, selected, collapsed, Math.floor(s.updatedAt / 60_000), relativeTime(s.updatedAt, now)].join(SEP);
}

function renderSessionRow(s: SessionSummary, selected: boolean, collapsed: boolean, now: number): HTMLElement {
  const title = s.title?.trim() || "New session";
  const statusLabel = SESSION_STATUS_LABEL[s.status] ?? s.status;
  const row = h(
    "div",
    {
      class: `sp-row${selected ? " is-selected" : ""}`,
      role: "option",
      tabindex: 0,
      "aria-selected": String(selected),
      "aria-label": `${title}, ${statusLabel}, ${relativeTime(s.updatedAt, now)}`,
      "data-action": "select-session",
      "data-session-id": s.id,
      title: collapsed ? `${title} — ${statusLabel}` : `${title}\n${statusLabel} · ${fullTime(s.updatedAt)}`,
    },
    sessionStatusIcon(s.status),
  );
  if (!collapsed) {
    row.append(
      h("span", { class: "sp-title" }, title),
      h("span", { class: "sp-time", "aria-hidden": "true" }, relativeTime(s.updatedAt, now)),
      actionButton("close-session", icon("close"), {
        cls: "sp-close",
        data: { "session-id": s.id },
        title: "Close session",
        ariaLabel: `Close session ${title}`,
      }),
    );
  }
  return row;
}

/**
 * Right-hand session panel. Rows are memoised on (id, title, status, minute
 * bucket of `updatedAt`), so a new `sessions` array with only sub-minute
 * timestamp changes rebuilds nothing; the minute of `now` refreshes the
 * relative times on the caller's timer.
 */
export function renderSessionPanel(el: HTMLElement, state: UiState, local: LocalUi, now = Date.now()): void {
  const collapsed = local.sessionPanelCollapsed;
  el.classList.toggle("collapsed", collapsed);
  const dom = ensurePanelDom(el);

  const rowKeys = state.sessions.map((s) => `${s.id}${SEP}${sessionRowKey(s, s.id === state.sessionId, collapsed, now)}`);
  const pending = needsInputCount(state);
  const key = `${collapsed}${SEP}${pending}${ROW_SEP}${rowKeys.join(ROW_SEP)}`;
  if (key === dom.key) return;
  dom.key = key;

  // Rows: reuse cached elements whose key is unchanged; drop the rest.
  const seen = new Set<string>();
  const rows: HTMLElement[] = [];
  state.sessions.forEach((s, i) => {
    if (seen.has(s.id)) return; // duplicate ids: render once
    seen.add(s.id);
    const rowKey = rowKeys[i];
    let cached = dom.rows.get(s.id);
    if (!cached || cached.key !== rowKey) {
      cached = { key: rowKey, el: renderSessionRow(s, s.id === state.sessionId, collapsed, now) };
      dom.rows.set(s.id, cached);
    }
    rows.push(cached.el);
  });
  for (const id of Array.from(dom.rows.keys())) if (!seen.has(id)) dom.rows.delete(id);
  reconcileChildren(dom.list, rows);

  // Toggle: same button element (keeps focus after a click); contents refreshed.
  const toggleKey = `${collapsed}${SEP}${pending}`;
  if (toggleKey !== dom.toggleKey) {
    dom.toggleKey = toggleKey;
    const toggle = dom.toggle;
    setChildren(toggle, [
      icon("chevron", "icon sp-chevron"),
      h("span", { class: "sp-label" }, "Collapse"),
      collapsed && pending > 0
        ? h("span", { class: "count-badge sp-badge", "aria-label": `${pending} sessions need input` }, String(pending))
        : null,
    ]);
    toggle.title = collapsed ? (pending > 0 ? `Expand sessions (${pending} need input)` : "Expand sessions") : "Collapse sessions";
    toggle.setAttribute("aria-label", collapsed ? "Expand the session panel" : "Collapse the session panel");
    toggle.setAttribute("aria-expanded", String(!collapsed));
  }
}

export function renderBanners(el: HTMLElement, state: UiState): void {
  const c = state.connection;
  const kids: HTMLElement[] = [];
  if (c.status === "auth_required") {
    const methods = c.authMethods ?? [];
    kids.push(
      h(
        "div",
        { class: "banner banner-auth", role: "status" },
        h("div", { class: "banner-text" }, c.message ?? "Sign in to Kiro to start chatting."),
        methods.length
          ? h(
              "div",
              { class: "banner-actions" },
              ...methods.map((m) =>
                actionButton("login", m.terminal ? `${m.name} (terminal)` : m.name, {
                  cls: "btn btn-primary btn-sm",
                  data: { method: m.id },
                  title: m.description ?? (m.terminal ? "Opens a terminal you must complete" : undefined),
                  ariaLabel: `Sign in with ${m.name}`,
                }),
              ),
            )
          : null,
      ),
    );
  } else if (c.status === "error") {
    kids.push(
      h(
        "div",
        { class: "banner banner-error", role: "alert" },
        icon("warning", "icon banner-icon"),
        h("div", { class: "banner-text" }, c.message ?? "The agent process stopped unexpectedly."),
        h(
          "div",
          { class: "banner-actions" },
          actionButton("restart", "Restart", { cls: "btn btn-primary btn-sm", ariaLabel: "Restart the agent" }),
          actionButton("show-log", "Show log", { cls: "btn btn-secondary btn-sm", ariaLabel: "Show the protocol log" }),
        ),
      ),
    );
  }
  setChildren(el, kids);
  el.hidden = kids.length === 0;
}

// ---------------------------------------------------------------------------
// Notices / plan bar / pickers / chips
// ---------------------------------------------------------------------------

export function renderNotices(el: HTMLElement, state: UiState, local: LocalUi): void {
  const visible = state.notices.filter((n) => !local.dismissedNotices.has(n.id));
  setChildren(
    el,
    visible.map((n) =>
      h(
        "div",
        { class: `notice notice-${n.severity}`, role: n.severity === "error" ? "alert" : "status" },
        h("span", { class: "notice-text" }, n.text),
        actionButton("dismiss-notice", icon("close"), {
          cls: "btn btn-ghost btn-xs notice-close",
          data: { id: n.id },
          ariaLabel: "Dismiss notice",
          title: "Dismiss",
        }),
      ),
    ),
  );
  el.hidden = visible.length === 0;
}

export function renderPlanBar(el: HTMLElement, state: UiState): void {
  if (state.plan.length === 0) {
    clear(el);
    el.hidden = true;
    return;
  }
  const done = state.plan.filter((e) => e.status === "completed").length;
  const current = state.plan.find((e) => e.status === "in_progress");
  setChildren(el, [
    icon("plan"),
    h("span", { class: "plan-text" }, `Plan: ${done} of ${state.plan.length} done`),
    current ? h("span", { class: "plan-current", title: current.content }, current.content) : null,
    h("span", { class: "spacer" }),
    actionButton("open-plan", "Open", { cls: "btn btn-ghost btn-xs", ariaLabel: "Open the plan", title: "Open the plan" }),
  ]);
  el.hidden = false;
}

interface PickerMemo {
  modes: UiState["modes"];
  configOptions: UiState["configOptions"];
  models: UiState["models"];
}
let pickerMemo: PickerMemo | null = null;

export function renderPickers(el: HTMLElement, state: UiState): void {
  if (
    pickerMemo &&
    pickerMemo.modes === state.modes &&
    pickerMemo.configOptions === state.configOptions &&
    pickerMemo.models === state.models
  ) {
    return;
  }
  pickerMemo = { modes: state.modes, configOptions: state.configOptions, models: state.models };

  const kids: HTMLElement[] = [];

  // Kiro V3 advertises the mode both as `modes` and as a config option with
  // category "mode"; render only the config option to avoid two "Mode" pickers.
  const hasModeOption = state.configOptions.some((o) => o.category === "mode" || o.id === "mode");
  if (state.modes && state.modes.availableModes.length > 0 && !hasModeOption) {
    const currentModeId = state.modes.currentModeId;
    const sel = h("select", { class: "picker-select", "aria-label": "Mode" });
    for (const m of state.modes.availableModes) {
      sel.appendChild(h("option", { value: m.id, title: m.description ?? undefined, selected: m.id === currentModeId }, m.name));
    }
    sel.addEventListener("change", () => post({ type: "setMode", modeId: sel.value }));
    kids.push(h("label", { class: "picker", title: "Session mode" }, h("span", { class: "picker-name" }, "Mode"), sel));
  }

  for (const opt of state.configOptions) {
    if (opt.type === "boolean") {
      const cb = h("input", { type: "checkbox", checked: opt.currentValue === true, "aria-label": opt.name });
      cb.addEventListener("change", () => post({ type: "setConfigOption", configId: opt.id, value: cb.checked }));
      kids.push(h("label", { class: "picker picker-check", title: opt.description ?? opt.name }, cb, h("span", { class: "picker-name" }, opt.name)));
      continue;
    }
    const sel = h("select", { class: "picker-select", "aria-label": opt.name });
    const groups = new Map<string, HTMLOptGroupElement>();
    const current = String(opt.currentValue);
    for (const o of opt.options ?? []) {
      const option = h("option", { value: o.value, title: o.description ?? undefined, selected: o.value === current }, o.name);
      if (o.group) {
        let g = groups.get(o.group);
        if (!g) {
          g = h("optgroup", { label: o.group });
          groups.set(o.group, g);
          sel.appendChild(g);
        }
        g.appendChild(option);
      } else {
        sel.appendChild(option);
      }
    }
    sel.addEventListener("change", () => post({ type: "setConfigOption", configId: opt.id, value: sel.value }));
    kids.push(h("label", { class: "picker", title: opt.description ?? opt.name }, h("span", { class: "picker-name" }, opt.name), sel));
  }

  const hasModelOption = state.configOptions.some((o) => o.category === "model");
  if (state.models && !hasModelOption && state.models.availableModels.length > 0) {
    const currentModelId = state.models.currentModelId;
    const sel = h("select", { class: "picker-select", "aria-label": "Model" });
    for (const m of state.models.availableModels) {
      sel.appendChild(h("option", { value: m.modelId, title: m.description ?? undefined, selected: m.modelId === currentModelId }, m.name));
    }
    sel.addEventListener("change", () => post({ type: "setModel", modelId: sel.value }));
    kids.push(h("label", { class: "picker", title: "Model" }, h("span", { class: "picker-name" }, "Model"), sel));
  }

  setChildren(el, kids);
  el.hidden = kids.length === 0;
}

/** Extension chips plus locally added `@` chips not yet echoed back. */
export function effectiveChips(state: UiState, local: LocalUi): ContextChip[] {
  const ids = new Set(state.chips.map((c) => c.id));
  return [...state.chips, ...local.localChips.filter((c) => !ids.has(c.id))];
}

function chipLabel(c: ContextChip): string {
  if (c.kind === "selection" && c.startLine != null) {
    return `${c.label}:${c.startLine}-${c.endLine ?? c.startLine}`;
  }
  return c.label;
}

export function renderChips(el: HTMLElement, chips: ContextChip[]): void {
  setChildren(
    el,
    chips.map((c) => {
      const label = chipLabel(c);
      return h(
        "span",
        {
          class: `chip chip-${c.kind}${c.implicit ? " chip-implicit" : ""}`,
          role: "listitem",
          title: c.implicit ? `${c.path} (active file)` : c.path,
        },
        icon(c.kind === "selection" ? "selection" : "file"),
        h("span", { class: "chip-label" }, label),
        actionButton("remove-chip", icon("close"), {
          cls: "btn btn-ghost btn-xs chip-remove",
          data: { id: c.id },
          ariaLabel: `Remove ${label}`,
          title: "Remove",
        }),
      );
    }),
  );
  el.hidden = chips.length === 0;
}

// ---------------------------------------------------------------------------
// Working strip
// ---------------------------------------------------------------------------

/**
 * Current step for the working strip: the most recent tool call that is still
 * pending/running (by transcript order), else "writing" while an agent message
 * is the last item, else "thinking".
 */
export function workingStep(state: UiState): string {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const it = state.items[i];
    if (it.type !== "tool") continue;
    const call = state.toolCalls[it.toolCallId];
    if (!call || (call.status !== "pending" && call.status !== "in_progress")) continue;
    return permissionForTool(state, call.toolCallId) ? `Waiting for your approval: ${call.title}` : `Running: ${call.title}`;
  }
  const last = state.items[state.items.length - 1];
  if (last && last.type === "message" && last.message.role === "agent") return "writing";
  return "thinking";
}

let workingMemo: { lead: string; step: string } | null = null;

/**
 * "Kiro is working… · <step>" strip at the bottom of the transcript while a
 * turn is active. Built once; only its text nodes change afterwards.
 */
export function renderWorkingStrip(el: HTMLElement, state: UiState): void {
  if (!state.turnActive) {
    el.hidden = true;
    return;
  }
  const lead = activityOf(state) === "needs_input" ? "Kiro needs your input" : "Kiro is working…";
  const step = workingStep(state);
  if (el.childElementCount === 0) {
    setChildren(el, [
      h("span", { class: "working-dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
      h("span", { class: "working-text" }),
      h("span", { class: "working-sep", "aria-hidden": "true" }, "·"),
      h("span", { class: "working-step" }),
    ]);
    workingMemo = null;
  }
  if (!workingMemo || workingMemo.lead !== lead || workingMemo.step !== step) {
    workingMemo = { lead, step };
    const text = el.querySelector<HTMLElement>(".working-text");
    const stepEl = el.querySelector<HTMLElement>(".working-step");
    if (text) text.textContent = lead;
    if (stepEl) {
      stepEl.textContent = step;
      stepEl.title = step;
    }
  }
  el.hidden = false;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

interface Entry {
  el: HTMLElement;
  rendered: MessageView | ToolCallView | undefined;
  perm: PermissionView | undefined;
  open: boolean;
}

function itemKey(item: TranscriptItem): string {
  return item.type === "message" ? `m:${item.message.id}` : `t:${item.toolCallId}`;
}

function messageSkeleton(message: MessageView): HTMLElement {
  if (message.role === "thought") {
    return h(
      "details",
      { class: "msg msg-thought" },
      h("summary", { class: "thought-summary" }, icon("think"), h("span", null, "Thinking…")),
      h("div", { class: "msg-body" }),
    );
  }
  return h("div", { class: `msg msg-${message.role}` }, h("div", { class: "msg-body" }));
}

function renderMessage(el: HTMLElement, message: MessageView): void {
  const body = el.querySelector<HTMLElement>(".msg-body");
  if (!body) return;
  clear(body);
  const plain = message.role === "user";
  let buffer = "";
  const flush = (): void => {
    if (!buffer) return;
    if (plain) {
      body.appendChild(h("div", { class: "user-text" }, buffer));
    } else {
      const md = h("div", { class: "md" });
      renderMarkdownInto(md, buffer);
      body.appendChild(md);
    }
    buffer = "";
  };
  for (const seg of message.segments) {
    if (seg.type === "text") {
      buffer += seg.text;
      continue;
    }
    flush();
    if (seg.type === "resource") {
      body.appendChild(
        h("span", { class: "chip chip-resource", title: seg.uri }, icon("file"), h("span", { class: "chip-label" }, seg.label)),
      );
    } else {
      body.appendChild(h("span", { class: "chip chip-image", title: seg.mimeType }, "[image]"));
    }
  }
  flush();
}

/** Where the streaming caret goes: inside the last inline block of the last markdown chunk. */
const CARET_INLINE_HOST = /^(P|H[1-6]|LI)$/;
function caretHost(messageEl: HTMLElement): Element {
  const body = messageEl.querySelector<HTMLElement>(".msg-body") ?? messageEl;
  const md = body.lastElementChild;
  if (!md || !md.classList.contains("md")) return body;
  let block = md.lastElementChild;
  while (block && block.tagName === "BLOCKQUOTE" && block.lastElementChild) block = block.lastElementChild;
  return block && CARET_INLINE_HOST.test(block.tagName) ? block : md;
}

function defaultOpen(call: ToolCallView, perm: PermissionView | undefined): boolean {
  if (perm) return true;
  if (call.status === "pending" || call.status === "in_progress") return true;
  return call.content.some((c) => c.type === "diff");
}

function renderPermission(perm: PermissionView, call: ToolCallView): HTMLElement {
  const kindLabel = TOOL_KIND_LABEL[perm.kind] ?? perm.kind;
  const diffIndex = Math.max(
    0,
    call.content.findIndex((c) => c.type === "diff"),
  );
  const consent = perm.consent;
  const hasConsent = Boolean(consent && (consent.capability || consent.resource));
  return h(
    "div",
    { class: "perm", role: "group", "aria-label": `Permission request: ${perm.title}` },
    h("div", { class: "perm-title" }, icon("warning", "icon perm-icon"), h("span", null, perm.title)),
    hasConsent && consent
      ? h(
          "div",
          { class: "perm-consent" },
          consent.capability ? h("span", { class: "perm-cap" }, consent.capability) : null,
          consent.resource ? h("code", { class: "perm-res", title: consent.resource }, consent.resource) : null,
        )
      : null,
    h(
      "div",
      { class: "perm-actions" },
      ...perm.options.map((o) =>
        actionButton("perm-option", o.name, {
          cls: `btn btn-sm ${o.kind.startsWith("allow") ? "btn-primary" : "btn-secondary"} perm-${o.kind}`,
          data: { request: perm.requestId, option: o.optionId },
        }),
      ),
    ),
    perm.hasDiff
      ? h(
          "div",
          { class: "perm-diff" },
          actionButton("open-diff", [icon("diff"), "Open diff"], {
            cls: "btn btn-ghost btn-xs",
            data: { tool: perm.toolCallId, index: diffIndex },
            ariaLabel: "Open the proposed change in a diff editor",
          }),
          h("span", { class: "perm-hint" }, "You can edit the proposed side before accepting."),
        )
      : null,
    h(
      "div",
      { class: "perm-always" },
      actionButton("perm-always", `Always allow ${kindLabel} this session`, {
        cls: "link-btn",
        data: { request: perm.requestId, decision: "allow" },
      }),
      actionButton("perm-always", `Always reject ${kindLabel} this session`, {
        cls: "link-btn",
        data: { request: perm.requestId, decision: "reject" },
      }),
    ),
  );
}

function renderToolCard(el: HTMLElement, call: ToolCallView, perm: PermissionView | undefined, open: boolean): void {
  const head = actionButton(
    "toggle-tool",
    [
      toolKindIcon(call.kind),
      h("span", { class: "tool-title", title: call.title }, call.title),
      statusBadge(call.status),
      icon("chevron", "icon chevron"),
    ],
    {
      cls: "tool-head",
      data: { tool: call.toolCallId },
      ariaLabel: `${call.title}, ${TOOL_STATUS_LABEL[call.status] ?? call.status}`,
    },
  );
  head.setAttribute("aria-expanded", String(open));

  const body = h("div", { class: "tool-body" });
  body.hidden = !open;

  if (call.failureReason) {
    body.appendChild(h("div", { class: "tool-fail" }, icon("warning"), h("span", null, call.failureReason)));
  }

  call.content.forEach((c, index) => {
    if (c.type === "text") {
      if (c.text.trim().length === 0) return;
      body.appendChild(h("pre", { class: "tool-text" }, c.text));
    } else if (c.type === "diff") {
      const { added, removed } = diffLineCounts(c.oldText, c.newText);
      body.appendChild(
        h(
          "div",
          { class: "tool-diff" },
          icon("diff"),
          h("span", { class: "diff-path", title: c.path }, shortPath(c.path)),
          h(
            "span",
            { class: "diff-counts", "aria-label": `${added} lines added, ${removed} lines removed` },
            h("span", { class: "diff-add" }, `+${added}`),
            " ",
            h("span", { class: "diff-del" }, `−${removed}`),
          ),
          actionButton("open-diff", "Open diff", {
            cls: "btn btn-secondary btn-xs",
            data: { tool: call.toolCallId, index },
            ariaLabel: `Open diff for ${c.path}`,
          }),
        ),
      );
    } else {
      const exit = c.exitCode;
      body.appendChild(
        h(
          "div",
          { class: "tool-term" },
          h("pre", { class: "term-output", "data-autoscroll": "1" }, c.output),
          h(
            "div",
            { class: "term-footer" },
            exit != null ? h("span", { class: `exit-code ${exit === 0 ? "ok" : "bad"}` }, `exit ${exit}`) : null,
            h("span", { class: "spacer" }),
            actionButton("show-terminal", [icon("terminal"), "Show terminal"], {
              cls: "btn btn-ghost btn-xs",
              data: { terminal: c.terminalId },
              ariaLabel: "Show the terminal",
            }),
          ),
        ),
      );
    }
  });

  if (call.locations.length > 0) {
    body.appendChild(
      h(
        "div",
        { class: "tool-locs" },
        ...call.locations.map((l) =>
          actionButton("open-file", `${shortPath(l.path)}${l.line != null ? `:${l.line}` : ""}`, {
            cls: "link-btn",
            data: { path: l.path, line: l.line ?? undefined },
            title: l.path,
            ariaLabel: `Open ${l.path}${l.line != null ? ` at line ${l.line}` : ""}`,
          }),
        ),
      ),
    );
  }

  if (call.content.length === 0) {
    if (call.rawInput !== undefined) {
      body.appendChild(h("details", { class: "tool-raw" }, h("summary", null, "Input"), h("pre", { class: "tool-text" }, safeJson(call.rawInput))));
    }
    if (call.rawOutput !== undefined && (call.status === "completed" || call.status === "failed")) {
      body.appendChild(h("details", { class: "tool-raw" }, h("summary", null, "Output"), h("pre", { class: "tool-text" }, safeJson(call.rawOutput))));
    }
  }

  if (perm) body.appendChild(renderPermission(perm, call));

  el.className = `tool tool-${call.status}${perm ? " tool-has-perm" : ""}${open ? " open" : ""}`;
  setChildren(el, [head, body]);
}

function scrollTerminals(el: HTMLElement): void {
  for (const pre of Array.from(el.querySelectorAll<HTMLElement>("[data-autoscroll]"))) {
    pre.scrollTop = pre.scrollHeight;
  }
}

export class TranscriptRenderer {
  private readonly entries = new Map<string, Entry>();
  /** Blinking caret appended to the agent message that is currently streaming. */
  private readonly caret = h("span", { class: "caret", "aria-hidden": "true" }, "▍");

  constructor(
    private readonly container: HTMLElement,
    private readonly local: LocalUi,
  ) {}

  reset(): void {
    this.entries.clear();
    clear(this.container);
  }

  isOpen(call: ToolCallView, perm: PermissionView | undefined): boolean {
    const override = this.local.toolOpen.get(call.toolCallId);
    return override ?? defaultOpen(call, perm);
  }

  render(state: UiState): void {
    const seen = new Set<string>();
    let cursor: ChildNode | null = this.container.firstChild;
    let lastAgent: HTMLElement | null = null;

    for (const item of state.items) {
      const key = itemKey(item);
      if (seen.has(key)) continue; // duplicate ids: render once
      seen.add(key);

      let entry = this.entries.get(key);
      let touchedTool = false;

      if (item.type === "message") {
        if (!entry) {
          entry = { el: messageSkeleton(item.message), rendered: undefined, perm: undefined, open: false };
          this.entries.set(key, entry);
        }
        if (entry.rendered !== item.message) {
          renderMessage(entry.el, item.message);
          entry.rendered = item.message;
        }
        if (item.message.role === "agent") lastAgent = entry.el;
        entry.el.classList.remove("streaming");
      } else {
        const call = state.toolCalls[item.toolCallId];
        if (!entry) {
          entry = { el: h("div", { class: "tool" }), rendered: undefined, perm: undefined, open: false };
          this.entries.set(key, entry);
        }
        if (!call) {
          // Transcript references a call we have no data for; keep a quiet placeholder.
          if (entry.rendered !== undefined || entry.el.childElementCount === 0) {
            setChildren(entry.el, [h("div", { class: "tool-head tool-placeholder" }, icon("other"), h("span", { class: "tool-title" }, item.toolCallId))]);
            entry.rendered = undefined;
          }
        } else {
          const perm = permissionForTool(state, call.toolCallId);
          const open = this.isOpen(call, perm);
          if (entry.rendered !== call || entry.perm !== perm || entry.open !== open) {
            renderToolCard(entry.el, call, perm, open);
            entry.rendered = call;
            entry.perm = perm;
            entry.open = open;
            touchedTool = true;
          }
        }
      }

      if (entry.el !== cursor) {
        this.container.insertBefore(entry.el, cursor);
      } else {
        cursor = cursor.nextSibling;
      }
      if (touchedTool) scrollTerminals(entry.el);
    }

    for (const [key, entry] of this.entries) {
      if (!seen.has(key)) {
        entry.el.remove();
        this.entries.delete(key);
      }
    }

    // Streaming caret: only on an agent message that is the last item of an active turn.
    const streaming = lastAgent && state.turnActive && this.container.lastElementChild === lastAgent ? lastAgent : null;
    if (streaming) {
      streaming.classList.add("streaming");
      const host = caretHost(streaming);
      // A re-rendered message cleared its body, so the caret may need re-appending.
      if (this.caret.parentElement !== host || host.lastElementChild !== this.caret) host.appendChild(this.caret);
    } else {
      this.caret.remove();
    }
  }
}
