/**
 * DOM rendering of `UiState`. Small sections (header, banners, notices, plan
 * bar, pickers, chips) are rebuilt wholesale; the transcript is reconciled by
 * key and a message/tool card is only re-rendered when its view object
 * changed (the reducer guarantees a new object on every change).
 *
 * Interactive elements carry `data-action` and are handled by delegation in
 * `main.ts`, except pickers whose `<select>` elements get direct listeners.
 */
import type {
  ConnectionView,
  ContextChip,
  MessageView,
  PermissionView,
  ToolCallView,
  TranscriptItem,
  UiState,
} from "../ui/protocol";
import {
  TOOL_KIND_LABEL,
  TOOL_STATUS_LABEL,
  actionButton,
  clear,
  h,
  icon,
  safeJson,
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

/** Text for the `aria-live` region. */
export function statusAnnouncement(state: UiState): string {
  const base = `Kiro: ${statusText(state.connection)}.`;
  if (state.connection.status !== "ready") return base;
  return state.turnActive ? `${base} Working on your request.` : `${base} Ready for input.`;
}

export function renderHeader(el: HTMLElement, state: UiState): void {
  const c = state.connection;
  const text = statusText(c);
  setChildren(el, [
    h(
      "div",
      { class: `status-pill status-${c.status}`, title: c.message ? `${text}: ${c.message}` : text },
      h("span", { class: "dot", "aria-hidden": "true" }),
      h("span", { class: "status-text" }, text),
    ),
    h("span", { class: "spacer" }),
    state.turnActive
      ? actionButton("cancel", [icon("stop"), h("span", { class: "btn-text" }, "Cancel")], {
          cls: "btn btn-secondary btn-sm",
          title: "Cancel the current turn",
          ariaLabel: "Cancel the current turn",
        })
      : null,
    actionButton("new-session", [icon("plus"), h("span", { class: "btn-text" }, "New")], {
      cls: "btn btn-ghost btn-sm",
      title: "Start a new session",
      ariaLabel: "Start a new session",
    }),
  ]);
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

  if (state.modes && state.modes.availableModes.length > 0) {
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

    if (lastAgent && state.turnActive) {
      const last = this.container.lastElementChild;
      if (last === lastAgent) lastAgent.classList.add("streaming");
    }
  }
}
