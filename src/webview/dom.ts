/**
 * Tiny DOM helpers and inline SVG icons. No framework: the renderer builds
 * elements directly and relies on event delegation via `data-action`.
 */
import type { ToolKind, ToolStatus } from "../ui/protocol";

export type Child = Node | string | number | null | undefined | false;

type Attrs = Record<string, string | number | boolean | null | undefined>;

/** Creates an element. Boolean attributes toggle presence; `null`/`undefined`/`false` omit. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (value === true) {
        el.setAttribute(key, "");
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === "string" || typeof c === "number") {
      parent.appendChild(document.createTextNode(String(c)));
    } else {
      parent.appendChild(c);
    }
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Replaces the children of `el` with `children`. */
export function setChildren(el: Element, children: Child[]): void {
  clear(el);
  append(el, children);
}

/** Convenience for `data-action` buttons (click delegated in main.ts). */
export function actionButton(
  action: string,
  label: Child | Child[],
  opts: {
    data?: Record<string, string | number | undefined>;
    cls?: string;
    title?: string;
    ariaLabel?: string;
    disabled?: boolean;
    /** Renders `aria-pressed` for toggle buttons. */
    pressed?: boolean;
  } = {},
): HTMLButtonElement {
  const attrs: Attrs = {
    type: "button",
    class: opts.cls ?? "btn",
    "data-action": action,
    title: opts.title,
    "aria-label": opts.ariaLabel,
    disabled: opts.disabled ?? false,
  };
  if (opts.pressed !== undefined) attrs["aria-pressed"] = String(opts.pressed);
  if (opts.data) {
    for (const [k, v] of Object.entries(opts.data)) {
      if (v !== undefined) attrs[`data-${k}`] = String(v);
    }
  }
  return h("button", attrs, ...(Array.isArray(label) ? label : [label]));
}

// ---------------------------------------------------------------------------
// Icons (inline SVG, 16px grid, stroke = currentColor)
// ---------------------------------------------------------------------------

const SVG_OPEN =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">';
const SVG_CLOSE = "</svg>";

const ICON_PATHS: Record<string, string> = {
  // Tool kinds
  read: '<path d="M4 2h5.5L13 5.5V14H4z"/><path d="M9.5 2v3.5H13"/><path d="M6 9h4M6 11.5h4"/>',
  edit: '<path d="M11.5 2.5l2 2L6 12H4v-2z"/><path d="M9.5 4.5l2 2"/>',
  delete: '<path d="M3 4.5h10"/><path d="M6.5 4.5V3h3v1.5"/><path d="M4.5 4.5l.7 8.5h5.6l.7-8.5"/><path d="M6.8 7v4M9.2 7v4"/>',
  move: '<path d="M2.5 8h11"/><path d="M9.5 4l4 4-4 4"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>',
  execute: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M4.5 6.5l2 1.5-2 1.5"/><path d="M8 10h3"/>',
  think: '<path d="M8 2.5a3.8 3.8 0 0 0-2.2 6.9c.4.3.7.8.7 1.3V11h3v-.3c0-.5.3-1 .7-1.3A3.8 3.8 0 0 0 8 2.5z"/><path d="M6.5 13h3"/>',
  fetch: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11"/><path d="M8 2.5c1.8 1.6 2.6 3.4 2.6 5.5S9.8 11.9 8 13.5C6.2 11.9 5.4 10.1 5.4 8S6.2 4.1 8 2.5z"/>',
  switch_mode: '<path d="M3 5.5h8"/><path d="M8.5 3l2.5 2.5L8.5 8"/><path d="M13 10.5H5"/><path d="M7.5 8L5 10.5 7.5 13"/>',
  other: '<circle cx="8" cy="8" r="2"/><path d="M8 2.5v1.5M8 12v1.5M2.5 8H4M12 8h1.5M4.1 4.1l1.1 1.1M10.8 10.8l1.1 1.1M4.1 11.9l1.1-1.1M10.8 5.2l1.1-1.1"/>',
  // UI
  file: '<path d="M4 2h5.5L13 5.5V14H4z"/><path d="M9.5 2v3.5H13"/>',
  selection: '<path d="M3 3h10v10H3z" stroke-dasharray="2 1.5"/><path d="M5.5 7h5M5.5 9.5h3"/>',
  chevron: '<path d="M6 4l4 4-4 4"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1"/>',
  send: '<path d="M2.5 8L13.5 3l-3 10-2.5-4.5z"/><path d="M8 8.5l5.5-5.5"/>',
  down: '<path d="M8 3v10"/><path d="M4 9l4 4 4-4"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  check: '<path d="M3 8.5l3.2 3L13 4.5"/>',
  cross: '<path d="M4 4l8 8M12 4l-8 8"/>',
  plan: '<path d="M4 4.5h8M4 8h8M4 11.5h5"/><circle cx="2.2" cy="4.5" r=".6"/><circle cx="2.2" cy="8" r=".6"/><circle cx="2.2" cy="11.5" r=".6"/>',
  diff: '<path d="M5 2.5v6"/><path d="M2 5.5h6"/><path d="M9 11h5"/><path d="M11.5 3l-7 10"/>',
  terminal: '<path d="M3 4.5l3 3-3 3"/><path d="M8 11h5"/>',
  warning: '<path d="M8 2.5l6 11H2z"/><path d="M8 6.5v3M8 11.5v.2"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2"/><path d="M8 4.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z"/>',
};

export function icon(name: string, cls = "icon"): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = cls;
  span.setAttribute("aria-hidden", "true");
  const path = ICON_PATHS[name] ?? ICON_PATHS.other;
  span.innerHTML = SVG_OPEN + path + SVG_CLOSE;
  return span;
}

export function toolKindIcon(kind: ToolKind): HTMLSpanElement {
  return icon(kind in ICON_PATHS ? kind : "other", "icon tool-icon");
}

export const TOOL_KIND_LABEL: Record<ToolKind, string> = {
  read: "read",
  edit: "edit",
  delete: "delete",
  move: "move",
  search: "search",
  execute: "execute",
  think: "think",
  fetch: "fetch",
  switch_mode: "mode switch",
  other: "other",
};

export const TOOL_STATUS_LABEL: Record<ToolStatus, string> = {
  pending: "Pending",
  in_progress: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Status badge: spinner for in-progress, glyphs otherwise. */
export function statusBadge(status: ToolStatus): HTMLSpanElement {
  const badge = h("span", { class: `status status-${status}`, title: TOOL_STATUS_LABEL[status], role: "img", "aria-label": TOOL_STATUS_LABEL[status] });
  switch (status) {
    case "pending":
      badge.textContent = "⏳"; // hourglass
      break;
    case "in_progress":
      badge.appendChild(h("span", { class: "spinner" }));
      break;
    case "completed":
      badge.appendChild(icon("check", "icon"));
      break;
    case "failed":
      badge.appendChild(icon("cross", "icon"));
      break;
    case "cancelled":
      badge.textContent = "⊘"; // circled division slash
      break;
  }
  return badge;
}

/** Shortens an absolute path to its last two segments for display. */
export function shortPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return p;
  return "…/" + parts.slice(-2).join("/");
}

/** Pretty-prints an unknown value as JSON with a length cap. */
export function safeJson(value: unknown, cap = 4000): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > cap ? text.slice(0, cap) + "\n…" : text;
}
