/**
 * Composer: auto-growing textarea, send button, `@` file autocomplete and
 * `/` command popup. Owns its own DOM; the chips row element is exposed so the
 * main renderer can fill it from state.
 */
import type { CommandView, ContextChip, FileSuggestion } from "../ui/protocol";
import { h, icon, setChildren, shortPath } from "./dom";
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

    this.sendBtn = h("button", { type: "button", class: "btn btn-primary btn-icon send-btn", "aria-label": "Send message", title: "Send (Enter)" }, icon("send"));

    this.popup = h("div", { class: "popup", id: "composer-popup", role: "listbox" });
    this.popup.hidden = true;

    this.el = h(
      "div",
      { class: "composer" },
      this.popup,
      this.chipsEl,
      h("div", { class: "composer-row" }, this.textarea, this.sendBtn),
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
    this.sendBtn.addEventListener("click", () => this.send());

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

  /** Results for a `queryFiles` request; ignored unless they answer the latest query. */
  setSuggestions(query: string, items: FileSuggestion[]): void {
    if (this.mode !== "files" || query !== this.lastQuery) return;
    this.awaitingQuery = false;
    this.fileItems = items;
    this.active = 0;
    this.renderPopup();
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
    const empty = this.textarea.value.trim().length === 0;
    this.sendBtn.disabled = this.turnActive || empty;
    this.sendBtn.title = this.turnActive ? "Kiro is working… use Cancel to stop" : "Send (Enter)";
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

  private send(): void {
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
}
