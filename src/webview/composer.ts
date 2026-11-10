/**
 * Composer: a single rounded container holding the chips row, the
 * auto-growing textarea and a toolbar row (`+` context, `/` commands, model
 * pill on the left; mode pill and send/stop button on the right). Also owns
 * the `@` file autocomplete and `/` command popup. The chips row and the pill
 * slots are filled by the main renderer from state; buttons carry
 * `data-action` and are handled by delegation in `main.ts`.
 */
import type { CommandView, ContextChip, FileSuggestion } from "../ui/protocol";
import { actionButton, h, icon, setChildren, shortPath } from "./dom";
import { loadDraft, post, saveDraft } from "./vscodeApi";

export interface ComposerHost {
  /** Chips to send with the prompt (extension chips + local `@` chips). */
  getChips(): ContextChip[];
  /** A file was picked from the `@` popup. */
  addLocalChip(chip: ContextChip): void;
  /** The prompt was sent; the host may drop local chips. */
  onSent(): void;
  getCommands(): CommandView[];
}

/** State-derived labels shown in the toolbar row. */
export interface ComposerMeta {
  /** Current model name; omitted when the agent advertises none. */
  model?: string;
  /** Current mode name; omitted when the agent advertises none. */
  mode?: string;
  /** Whether the settings panel is open (pills are `aria-pressed` toggles). */
  settingsOpen: boolean;
}

type PopupMode = "none" | "files" | "commands";

const QUERY_DEBOUNCE_MS = 120;
const DRAFT_DEBOUNCE_MS = 250;
const MAX_HEIGHT_PX = 200;

const AT_TOKEN = /(^|\s)@([^\s@]*)$/;
const CMD_TOKEN = /^\/(\S*)$/;

function commandName(c: CommandView): string {
  return c.name.startsWith("/") ? c.name.slice(1) : c.name;
}

export class Composer {
  readonly el: HTMLElement;
  readonly chipsEl: HTMLElement;

  private readonly textarea: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly modelSlot: HTMLElement;
  private readonly modeSlot: HTMLElement;
  private readonly popup: HTMLElement;

  private mode: PopupMode = "none";
  private fileItems: FileSuggestion[] = [];
  private cmdItems: CommandView[] = [];
  private active = 0;
  /** Query whose results we are showing/awaiting; `null` when not in `@` mode. */
  private lastQuery: string | null = null;
  private awaitingQuery = false;
  private queryTimer: number | undefined;
  private draftTimer: number | undefined;
  private turnActive = false;
  private meta: ComposerMeta = { settingsOpen: false };

  constructor(private readonly host: ComposerHost) {
    this.chipsEl = h("div", { class: "chips", role: "list", "aria-label": "Context" });
    this.chipsEl.hidden = true;

    this.textarea = h("textarea", {
      class: "composer-input",
      rows: 1,
      placeholder: "Ask Kiro…  @ to add a file, / for commands",
      "aria-label": "Message to Kiro",
      "aria-autocomplete": "list",
      "aria-controls": "composer-popup",
      "aria-expanded": "false",
      spellcheck: "true",
    });

    // Send / stop share one slot; `data-action` flips with `turnActive`.
    this.sendBtn = actionButton("send", [icon("arrow-up")], {
      cls: "send-btn",
      ariaLabel: "Send message",
      title: "Send (Enter)",
    });

    this.modelSlot = h("span", { class: "tool-slot tool-slot-model" });
    this.modeSlot = h("span", { class: "tool-slot tool-slot-mode" });

    const tools = h(
      "div",
      { class: "composer-tools", role: "toolbar", "aria-label": "Composer tools" },
      actionButton("add-context", [icon("plus")], {
        cls: "tool-btn",
        title: "Add a file to the context (@)",
        ariaLabel: "Add a file to the context",
      }),
      actionButton("insert-slash", [icon("slash")], {
        cls: "tool-btn",
        title: "Commands (/)",
        ariaLabel: "Show commands",
      }),
      this.modelSlot,
      h("span", { class: "spacer" }),
      this.modeSlot,
      this.sendBtn,
    );
    // Keep the caret in the textarea while clicking toolbar buttons (keyboard
    // focus still works: buttons stay tabbable).
    tools.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("button")) e.preventDefault();
    });

    this.popup = h("div", { class: "popup", id: "composer-popup", role: "listbox" });
    this.popup.hidden = true;

    this.el = h(
      "div",
      { class: "composer" },
      this.popup,
      h("div", { class: "composer-box" }, this.chipsEl, this.textarea, tools),
    );

    this.textarea.value = loadDraft();

    this.textarea.addEventListener("input", () => this.onInput());
    this.textarea.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.textarea.addEventListener("click", () => this.updatePopup());
    this.textarea.addEventListener("blur", () => this.closePopup());
    // Keep focus in the textarea while clicking the popup.
    this.popup.addEventListener("mousedown", (e) => e.preventDefault());
    this.popup.addEventListener("click", (e) => {
      const opt = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
      if (opt) this.select(Number(opt.dataset.index));
    });

    this.autoGrow();
    this.updateSendState();
  }

  focus(): void {
    this.textarea.focus();
  }

  setTurnActive(active: boolean): void {
    if (this.turnActive === active) return;
    this.turnActive = active;
    this.updateSendState();
  }

  /** Updates the model/mode pills in the toolbar row. */
  setMeta(meta: ComposerMeta): void {
    const prev = this.meta;
    if (prev.model === meta.model && prev.mode === meta.mode && prev.settingsOpen === meta.settingsOpen) return;
    this.meta = meta;
    const title = meta.settingsOpen ? "Hide session settings" : "Show session settings (mode, model, options)";
    setChildren(this.modelSlot, [
      meta.model
        ? actionButton("toggle-settings", [h("span", { class: "pill-text" }, meta.model)], {
            cls: `pill pill-model${meta.settingsOpen ? " is-active" : ""}`,
            title,
            ariaLabel: `Model: ${meta.model}. Toggle session settings`,
            pressed: meta.settingsOpen,
          })
        : null,
    ]);
    setChildren(this.modeSlot, [
      meta.mode
        ? actionButton("toggle-settings", [icon("bolt"), h("span", { class: "pill-text" }, meta.mode)], {
            cls: `pill pill-mode${meta.settingsOpen ? " is-active" : ""}`,
            title,
            ariaLabel: `Mode: ${meta.mode}. Toggle session settings`,
            pressed: meta.settingsOpen,
          })
        : null,
    ]);
  }

  /** Results for a `queryFiles` request; ignored unless they answer the latest query. */
  setSuggestions(query: string, items: FileSuggestion[]): void {
    if (this.mode !== "files" || query !== this.lastQuery) return;
    this.awaitingQuery = false;
    this.fileItems = items;
    this.active = 0;
    this.renderPopup();
  }

  /** `+` button: inserts `@` at the caret and opens the file suggestions. */
  insertAtMention(): void {
    const ta = this.textarea;
    ta.focus();
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    const insert = (needsSpace ? " " : "") + "@";
    ta.value = before + insert + after;
    const pos = before.length + insert.length;
    ta.setSelectionRange(pos, pos);
    this.onInput();
  }

  /** `/` button: puts `/` at the start of the text and opens the command popup. */
  insertSlash(): void {
    const ta = this.textarea;
    ta.focus();
    if (ta.value.trim().length === 0) {
      ta.value = "/";
    } else if (!ta.value.startsWith("/")) {
      ta.value = "/" + ta.value;
    }
    const pos = ta.value.startsWith("/") ? Math.min(ta.value.length, ta.value.search(/\s|$/)) : ta.value.length;
    ta.setSelectionRange(pos, pos);
    this.onInput();
  }

  /** Sends the current text (same path as pressing Enter). */
  send(): void {
    if (this.turnActive) return;
    const text = this.textarea.value.replace(/\s+$/, "");
    if (text.trim().length === 0) return;
    post({ type: "prompt", text, chips: this.host.getChips() });
    this.textarea.value = "";
    this.closePopup();
    this.autoGrow();
    this.updateSendState();
    window.clearTimeout(this.draftTimer);
    saveDraft("");
    this.host.onSent();
    this.textarea.focus();
  }

  // -------------------------------------------------------------------------

  private onInput(): void {
    this.autoGrow();
    this.updateSendState();
    window.clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => saveDraft(this.textarea.value), DRAFT_DEBOUNCE_MS);
    this.updatePopup();
  }

  private autoGrow(): void {
    const ta = this.textarea;
    ta.style.height = "auto";
    const next = Math.min(ta.scrollHeight, MAX_HEIGHT_PX);
    ta.style.height = `${next}px`;
    ta.style.overflowY = ta.scrollHeight > MAX_HEIGHT_PX ? "auto" : "hidden";
  }

  private updateSendState(): void {
    const btn = this.sendBtn;
    const empty = this.textarea.value.trim().length === 0;
    if (this.turnActive) {
      btn.dataset.action = "cancel";
      btn.className = "send-btn is-stop";
      btn.disabled = false;
      btn.title = "Stop (cancel the current turn)";
      btn.setAttribute("aria-label", "Cancel the current turn");
      setChildren(btn, [icon("stop")]);
    } else {
      btn.dataset.action = "send";
      btn.className = "send-btn";
      btn.disabled = empty;
      btn.title = "Send (Enter)";
      btn.setAttribute("aria-label", "Send message");
      setChildren(btn, [icon("arrow-up")]);
    }
  }

  private updatePopup(): void {
    const value = this.textarea.value;
    const cmd = CMD_TOKEN.exec(value);
    if (cmd) {
      const prefix = cmd[1].toLowerCase();
      const all = this.host.getCommands();
      let items = all.filter((c) => commandName(c).toLowerCase().startsWith(prefix));
      if (items.length === 0 && prefix) {
        items = all.filter((c) => commandName(c).toLowerCase().includes(prefix));
      }
      if (items.length === 0) {
        this.closePopup();
        return;
      }
      if (this.mode !== "commands") this.active = 0;
      this.mode = "commands";
      this.lastQuery = null;
      this.cmdItems = items;
      this.active = Math.min(this.active, items.length - 1);
      this.renderPopup();
      return;
    }

    const caret = this.textarea.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const m = AT_TOKEN.exec(before);
    if (m) {
      const query = m[2];
      if (this.mode !== "files") {
        this.fileItems = [];
        this.active = 0;
      }
      this.mode = "files";
      if (query !== this.lastQuery) {
        this.lastQuery = query;
        this.awaitingQuery = true;
        window.clearTimeout(this.queryTimer);
        this.queryTimer = window.setTimeout(() => post({ type: "queryFiles", query }), QUERY_DEBOUNCE_MS);
      }
      this.renderPopup();
      return;
    }

    this.closePopup();
  }

  private closePopup(): void {
    window.clearTimeout(this.queryTimer);
    this.mode = "none";
    this.lastQuery = null;
    this.awaitingQuery = false;
    this.popup.hidden = true;
    setChildren(this.popup, []);
    this.textarea.setAttribute("aria-expanded", "false");
    this.textarea.removeAttribute("aria-activedescendant");
  }

  private renderPopup(): void {
    const kids: HTMLElement[] = [];
    if (this.mode === "files") {
      if (this.fileItems.length === 0) {
        kids.push(h("div", { class: "popup-empty" }, this.awaitingQuery ? "Searching…" : "No matching files"));
      } else {
        this.fileItems.forEach((f, i) => {
          kids.push(
            h(
              "div",
              { class: `popup-option${i === this.active ? " active" : ""}`, role: "option", id: `composer-opt-${i}`, "aria-selected": String(i === this.active), "data-index": i, title: f.path },
              icon("file"),
              h("span", { class: "opt-main" }, f.label),
              f.path !== f.label ? h("span", { class: "opt-dim" }, shortPath(f.path)) : null,
            ),
          );
        });
      }
    } else if (this.mode === "commands") {
      this.cmdItems.forEach((c, i) => {
        kids.push(
          h(
            "div",
            { class: `popup-option${i === this.active ? " active" : ""}`, role: "option", id: `composer-opt-${i}`, "aria-selected": String(i === this.active), "data-index": i },
            h("span", { class: "opt-main" }, `/${commandName(c)}`),
            c.hint ? h("span", { class: "opt-hint" }, c.hint) : null,
            c.description ? h("span", { class: "opt-dim" }, c.description) : null,
          ),
        );
      });
    }
    setChildren(this.popup, kids);
    this.popup.hidden = kids.length === 0;
    this.textarea.setAttribute("aria-expanded", String(!this.popup.hidden));
    const hasItems = this.itemCount() > 0;
    if (hasItems) {
      this.textarea.setAttribute("aria-activedescendant", `composer-opt-${this.active}`);
      this.popup.querySelector<HTMLElement>(".popup-option.active")?.scrollIntoView({ block: "nearest" });
    } else {
      this.textarea.removeAttribute("aria-activedescendant");
    }
  }

  private itemCount(): number {
    return this.mode === "files" ? this.fileItems.length : this.mode === "commands" ? this.cmdItems.length : 0;
  }

  private onKeyDown(e: KeyboardEvent): void {
    const open = this.mode !== "none";
    const count = this.itemCount();

    if (open) {
      if (e.key === "Escape") {
        e.preventDefault();
        this.closePopup();
        return;
      }
      if (count > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.active = (this.active + 1) % count;
          this.renderPopup();
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          this.active = (this.active - 1 + count) % count;
          this.renderPopup();
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          this.select(this.active);
          return;
        }
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.send();
    }
  }

  private select(index: number): void {
    if (this.mode === "files") {
      const item = this.fileItems[index];
      if (!item) return;
      const ta = this.textarea;
      const caret = ta.selectionStart ?? ta.value.length;
      const before = ta.value.slice(0, caret);
      const after = ta.value.slice(caret);
      const m = AT_TOKEN.exec(before);
      if (m) {
        const head = before.slice(0, m.index + m[1].length);
        const needsSpace = after.length > 0 && !/^\s/.test(after);
        ta.value = head + (needsSpace ? " " : "") + after;
        const pos = head.length;
        ta.setSelectionRange(pos, pos);
      }
      this.host.addLocalChip({ id: `file:${item.path}`, kind: "file", path: item.path, label: item.label, implicit: false });
      this.closePopup();
      this.autoGrow();
      this.updateSendState();
      saveDraft(ta.value);
      ta.focus();
      return;
    }
    if (this.mode === "commands") {
      const item = this.cmdItems[index];
      if (!item) return;
      const ta = this.textarea;
      ta.value = `/${commandName(item)} `;
      ta.setSelectionRange(ta.value.length, ta.value.length);
      this.closePopup();
      this.autoGrow();
      this.updateSendState();
      saveDraft(ta.value);
      ta.focus();
    }
  }
}
