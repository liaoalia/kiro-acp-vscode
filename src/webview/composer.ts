/**
 * Composer: a single rounded container holding the image attachments row,
 * the chips row, the auto-growing textarea and a toolbar row (`+` context,
 * attach image, `/` commands, model pill on the left; mode pill and
 * send/stop button on the right). Also owns the `@` file autocomplete, the
 * `/` command popup and the attached images (paste, drop, attach button;
 * DECISIONS D29). The chips row and the pill slots are filled by the main
 * renderer from state; buttons carry `data-action` and are handled by
 * delegation in `main.ts`.
 */
import type { CommandView, ContextChip, FileSuggestion, ImageAttachment } from "../ui/protocol";
import { formatBytes, imageDataVerdict, isSafeImageDataUrl } from "../ui/images";
import {
  IMAGES_NOT_ACCEPTED,
  ONLY_IMAGES_DROPPED,
  PasteNamer,
  fileImageType,
  isAttachableDrag,
  isImageFile,
  isWebUri,
  parseUriList,
  pasteAction,
  planAttach,
} from "./attachments";
import { actionButton, h, icon, setChildren, shortPath } from "./dom";
import { clipboardImageFiles, makePreview, readFileAsBase64 } from "./imageFiles";
import { PromptHistory } from "./promptHistory";
import { loadDraft, loadHistory, post, saveDraft, saveHistory } from "./vscodeApi";

export interface ComposerHost {
  /** Chips to send with the prompt (extension chips + local `@` chips). */
  getChips(): ContextChip[];
  /** A file was picked from the `@` popup. */
  addLocalChip(chip: ContextChip): void;
  /** The prompt was sent; the host may drop local chips. */
  onSent(): void;
  getCommands(): CommandView[];
  /** Show a local notice (rejected images and the like); it renders and dismisses like the host's. */
  notify(text: string, severity?: "info" | "warning"): void;
}

/** A pasted or dropped file on its way to becoming an attachment. */
interface FileCandidate {
  file: File;
  name: string;
  mimeType: string;
  size: number;
}

/** Composer tile of an attached image: thumbnail (or icon), name, remove button. */
function attachmentTile(img: ImageAttachment): HTMLElement {
  const thumb =
    img.preview && isSafeImageDataUrl(img.preview)
      ? h("img", { class: "attachment-thumb", src: img.preview, alt: "", draggable: "false" })
      : h("span", { class: "attachment-thumb attachment-placeholder" }, icon("image"));
  return h(
    "div",
    { class: "attachment", role: "listitem", title: `${img.name} · ${formatBytes(img.size)}` },
    thumb,
    h("span", { class: "attachment-name" }, img.name),
    actionButton("remove-image", icon("close"), {
      cls: "attachment-remove",
      data: { id: img.id },
      ariaLabel: `Remove ${img.name}`,
      title: "Remove",
    }),
  );
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

const PLACEHOLDER_IDLE = "Ask Kiro…  @ to add a file, / for commands";
/** Shown while a turn runs and the host accepts prompts mid-turn (steering/queueing). */
const PLACEHOLDER_STEER = "Type to steer Kiro… (Enter sends now, /cancel stops)";

function commandName(c: CommandView): string {
  return c.name.startsWith("/") ? c.name.slice(1) : c.name;
}

export class Composer {
  readonly el: HTMLElement;
  readonly chipsEl: HTMLElement;

  private readonly box: HTMLElement;
  private readonly attachmentsEl: HTMLElement;
  private readonly attachBtn: HTMLButtonElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  /** Separate stop button, shown next to Send only while composing mid-turn is allowed. */
  private readonly stopBtn: HTMLButtonElement;
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
  /** Sent prompts, recalled with Up / Down when the caret is on the first / last line. */
  private readonly history = new PromptHistory(loadHistory());
  private turnActive = false;
  /** The host accepts prompts while a turn runs (`UiState.acceptsPromptsDuringTurn`). */
  private composableDuringTurn = false;
  private meta: ComposerMeta = { settingsOpen: false };

  /** Attached images, in order; part of the draft (kept across session switches, not persisted). */
  private images: ImageAttachment[] = [];
  /** The agent accepts image blocks (`ConnectionView.acceptsImages`). */
  private imagesAllowed = false;
  /** Slots held by images still being read or previewed, so concurrent attaches respect the count limit. */
  private reserved = 0;
  /** Attach work in flight (file reads, thumbnails); Send waits for it. */
  private readonly inflight = new Set<Promise<void>>();
  /** Send was pressed while attach work was in flight: send when it is done. */
  private sendWhenReady = false;
  private readonly pasteNamer = new PasteNamer();
  private imageSeq = 0;

  constructor(private readonly host: ComposerHost) {
    this.attachmentsEl = h("div", { class: "attachments", role: "list", "aria-label": "Attached images" });
    this.attachmentsEl.hidden = true;
    // Keep the caret in the textarea while clicking a tile or its remove button (keyboard focus still works).
    this.attachmentsEl.addEventListener("mousedown", (e) => e.preventDefault());

    this.chipsEl = h("div", { class: "chips", role: "list", "aria-label": "Context" });
    this.chipsEl.hidden = true;

    this.textarea = h("textarea", {
      class: "composer-input",
      rows: 1,
      placeholder: PLACEHOLDER_IDLE,
      "aria-label": "Message to Kiro",
      "aria-autocomplete": "list",
      "aria-controls": "composer-popup",
      "aria-expanded": "false",
      spellcheck: "true",
    });

    // Send / stop share one slot; `data-action` flips with `turnActive`, unless
    // the host accepts prompts mid-turn: then Send stays and `stopBtn` appears.
    this.sendBtn = actionButton("send", [icon("arrow-up")], {
      cls: "send-btn",
      ariaLabel: "Send message",
      title: "Send (Enter)",
    });
    this.stopBtn = actionButton("cancel", [icon("stop")], {
      cls: "send-btn is-stop composer-stop",
      ariaLabel: "Cancel the current turn",
      title: "Stop (Esc)",
    });
    this.stopBtn.hidden = true;

    this.modelSlot = h("span", { class: "tool-slot tool-slot-model" });
    this.modeSlot = h("span", { class: "tool-slot tool-slot-mode" });

    // Shown only while the agent accepts images (`setImagesAllowed`).
    this.attachBtn = actionButton("attach-image", [icon("image")], {
      cls: "tool-btn",
      title: "Attach an image (or paste one)",
      ariaLabel: "Attach an image",
    });
    this.attachBtn.hidden = true;

    const tools = h(
      "div",
      { class: "composer-tools", role: "toolbar", "aria-label": "Composer tools" },
      actionButton("add-context", [icon("plus")], {
        cls: "tool-btn",
        title: "Add a file to the context (@)",
        ariaLabel: "Add a file to the context",
      }),
      this.attachBtn,
      actionButton("insert-slash", [icon("slash")], {
        cls: "tool-btn",
        title: "Commands (/)",
        ariaLabel: "Show commands",
      }),
      this.modelSlot,
      h("span", { class: "spacer" }),
      this.modeSlot,
      this.stopBtn,
      this.sendBtn,
    );
    // Keep the caret in the textarea while clicking toolbar buttons (keyboard
    // focus still works: buttons stay tabbable).
    tools.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("button")) e.preventDefault();
    });

    this.popup = h("div", { class: "popup", id: "composer-popup", role: "listbox" });
    this.popup.hidden = true;

    this.box = h("div", { class: "composer-box" }, this.attachmentsEl, this.chipsEl, this.textarea, tools);
    this.el = h("div", { class: "composer" }, this.popup, this.box);

    this.textarea.value = loadDraft();

    this.textarea.addEventListener("input", () => this.onInput());
    this.textarea.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.textarea.addEventListener("click", () => this.updatePopup());
    this.textarea.addEventListener("blur", () => this.closePopup());
    this.textarea.addEventListener("paste", (e) => this.onPaste(e));
    // Drops: OS files (bytes) or VS Code / file-manager uri-lists. VS Code may
    // not deliver every drag to a webview; without the events nothing happens.
    this.box.addEventListener("dragenter", (e) => this.onDragOver(e));
    this.box.addEventListener("dragover", (e) => this.onDragOver(e));
    this.box.addEventListener("dragleave", (e) => this.onDragLeave(e));
    this.box.addEventListener("drop", (e) => this.onDrop(e));
    window.addEventListener("dragend", () => this.setDragOver(false));
    window.addEventListener("drop", () => this.setDragOver(false));
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

  /**
   * `active`: a turn is running. `composable`: the host accepts prompts during
   * a turn, so the textarea and Send stay usable and Stop gets its own button.
   */
  setTurnActive(active: boolean, composable = false): void {
    if (this.turnActive === active && this.composableDuringTurn === composable) return;
    this.turnActive = active;
    this.composableDuringTurn = composable;
    this.updateSendState();
  }

  /** True when Enter/Send would post a prompt right now. */
  private canSend(): boolean {
    return !this.turnActive || this.composableDuringTurn;
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

  /**
   * Sends the current text and attached images (same path as pressing
   * Enter). Either may be empty, not both. While an image is still being
   * read or previewed, the send happens as soon as it is attached.
   */
  send(): void {
    if (!this.canSend()) return;
    if (this.inflight.size > 0) {
      this.sendWhenReady = true;
      return;
    }
    const text = this.textarea.value.replace(/\s+$/, "");
    const hasText = text.trim().length > 0;
    const images = this.images;
    if (!hasText && images.length === 0) return;
    const chips = this.host.getChips();
    post(images.length > 0 ? { type: "prompt", text, chips, images } : { type: "prompt", text, chips });
    if (hasText) {
      this.history.push(text);
      saveHistory(this.history.list());
    }
    this.images = [];
    this.renderAttachments();
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
  // Image attachments (D29)
  // -------------------------------------------------------------------------

  /**
   * `ConnectionView.acceptsImages`: shows the attach button; while false,
   * pasted, dropped or host-read images get a notice and are not attached.
   * Images already attached stay (the host refuses them on send, with a notice).
   */
  setImagesAllowed(allowed: boolean): void {
    if (this.imagesAllowed === allowed) return;
    this.imagesAllowed = allowed;
    this.attachBtn.hidden = !allowed;
  }

  /**
   * Attach images (read by the host for `pickImages` / `dropFiles`, or built
   * from pasted/dropped files): enforces type, size and count, makes the
   * thumbnails, then shows the tiles. Rejections become one local notice.
   */
  async addImages(incoming: ImageAttachment[]): Promise<void> {
    const candidates = (Array.isArray(incoming) ? incoming : []).filter(
      (i) => i && typeof i.data === "string" && typeof i.mimeType === "string",
    );
    if (candidates.length === 0) return;
    if (!this.imagesAllowed) {
      this.host.notify(IMAGES_NOT_ACCEPTED, "warning");
      return;
    }
    // Type and size from the bytes, as for pasted files and on the host's send check.
    const refused: string[] = [];
    const valid: ImageAttachment[] = [];
    for (const i of candidates) {
      const name = typeof i.name === "string" && i.name.trim() ? i.name.trim() : "Image";
      const verdict = imageDataVerdict(name, i.data, i.mimeType);
      if (!verdict.ok) {
        refused.push(verdict.reason);
        continue;
      }
      const img: ImageAttachment = { id: this.nextImageId(), name, mimeType: verdict.mimeType, data: i.data, size: verdict.size };
      if (typeof i.path === "string" && i.path) img.path = i.path;
      valid.push(img);
    }
    const paths = this.images.map((i) => i.path).filter((p): p is string => typeof p === "string");
    const plan = planAttach(valid, this.images.length + this.reserved, paths);
    this.report([...refused, ...plan.notices]);
    if (plan.accepted.length === 0) return;
    await this.run(plan.accepted.length, () => this.commit(plan.accepted));
  }

  /** Remove button of a tile. Keyboard focus moves to the next tile's button, else the textarea. */
  removeImage(id: string): void {
    const index = this.images.findIndex((i) => i.id === id);
    if (index < 0) return;
    const hadFocus = this.attachmentsEl.contains(document.activeElement);
    this.images = this.images.filter((i) => i.id !== id);
    this.renderAttachments();
    if (hadFocus) {
      const buttons = this.attachmentsEl.querySelectorAll<HTMLElement>(".attachment-remove");
      (buttons.length > 0 ? buttons[Math.min(index, buttons.length - 1)] : this.textarea).focus();
    }
  }

  private nextImageId(): string {
    this.imageSeq += 1;
    return `img-${this.imageSeq}`;
  }

  private report(notices: string[]): void {
    if (notices.length > 0) this.host.notify(notices.join(" "), "warning");
  }

  /**
   * Run attach work holding `slots` of the count limit; Send waits for it.
   * When the last piece of work ends, a Send pressed meanwhile goes out.
   */
  private run(slots: number, work: () => Promise<void>): Promise<void> {
    this.reserved += slots;
    const job = (async () => {
      try {
        await work();
      } catch {
        // Every step reports its own failures; nothing is attached for this job.
      } finally {
        this.reserved -= slots;
      }
    })();
    this.inflight.add(job);
    void job.then(() => {
      this.inflight.delete(job);
      if (this.inflight.size === 0 && this.sendWhenReady) {
        this.sendWhenReady = false;
        this.send();
      }
    });
    return job;
  }

  /** Make the thumbnails (dropping any preview that came in) and show the tiles. */
  private async commit(images: ImageAttachment[]): Promise<void> {
    const ready = await Promise.all(
      images.map(async (img): Promise<ImageAttachment> => {
        const { preview: _ignored, ...rest } = img;
        const preview = await makePreview(img.mimeType, img.data);
        return preview ? { ...rest, preview } : rest;
      }),
    );
    this.images = [...this.images, ...ready];
    this.renderAttachments();
  }

  /** Pasted (`pasted`) or dropped image files: name, check, read and attach them. */
  private attachFiles(files: File[], pasted: boolean): void {
    if (files.length === 0) return;
    if (!this.imagesAllowed) {
      this.host.notify(IMAGES_NOT_ACCEPTED, "warning");
      return;
    }
    const candidates: FileCandidate[] = files.map((file) => {
      const mimeType = fileImageType(file.type, file.name);
      const name = pasted || !file.name.trim() ? this.pasteNamer.name(file.name, mimeType) : file.name.trim();
      return { file, name, mimeType, size: file.size };
    });
    // Type, size and count are checked on the file's metadata, before reading anything.
    const plan = planAttach(candidates, this.images.length + this.reserved);
    this.report(plan.notices);
    if (plan.accepted.length === 0) return;
    void this.run(plan.accepted.length, async () => {
      const read: ImageAttachment[] = [];
      const failures: string[] = [];
      for (const c of plan.accepted) {
        try {
          const data = await readFileAsBase64(c.file);
          // The bytes decide, as on the host (D29): a renamed AVIF or text file is
          // refused here, not after Send has already cleared the composer.
          const verdict = imageDataVerdict(c.name, data, c.mimeType);
          if (!verdict.ok) failures.push(verdict.reason);
          else read.push({ id: this.nextImageId(), name: c.name, mimeType: verdict.mimeType, data, size: verdict.size });
        } catch {
          failures.push(`${c.name} was not attached: it could not be read.`);
        }
      }
      this.report(failures);
      if (read.length > 0) await this.commit(read);
    });
  }

  private renderAttachments(): void {
    setChildren(this.attachmentsEl, this.images.map(attachmentTile));
    this.attachmentsEl.hidden = this.images.length === 0;
    this.updateSendState();
  }

  /** Clipboard images are attached unless the clipboard also has plain text (Excel, Word: the text wins). */
  private onPaste(e: ClipboardEvent): void {
    const data = e.clipboardData;
    if (!data) return;
    const files = clipboardImageFiles(data);
    if (pasteAction({ hasText: data.getData("text/plain").length > 0, imageCount: files.length }) !== "images") return;
    e.preventDefault();
    this.attachFiles(files, true);
  }

  private setDragOver(on: boolean): void {
    this.box.classList.toggle("is-dragover", on);
  }

  private onDragOver(e: DragEvent): void {
    const dt = e.dataTransfer;
    if (!dt || !isAttachableDrag(Array.from(dt.types))) return;
    e.preventDefault();
    // A drop effect the source does not allow would cancel the drop: ask for "copy" only when allowed.
    const allowed = dt.effectAllowed.toLowerCase();
    if (allowed === "all" || allowed === "uninitialized" || allowed.includes("copy")) dt.dropEffect = "copy";
    this.setDragOver(true);
  }

  private onDragLeave(e: DragEvent): void {
    // Moving between children of the box fires dragleave too; only leaving the box counts.
    const next = e.relatedTarget;
    if (next instanceof Node && this.box.contains(next)) return;
    this.setDragOver(false);
  }

  /**
   * VS Code's own uri-list (explorer, editor tabs) goes to the host, which
   * reads image files back (`imagesAttached`) and turns other files into `@`
   * chips; OS files arrive as bytes: images are attached, the rest get a
   * notice; a dropped web link stays the textarea's default (inserted as text).
   */
  private onDrop(e: DragEvent): void {
    this.setDragOver(false);
    const dt = e.dataTransfer;
    if (!dt) return;
    const types = Array.from(dt.types);
    if (!isAttachableDrag(types)) return;
    const codeUris = types.includes("application/vnd.code.uri-list") ? parseUriList(dt.getData("application/vnd.code.uri-list")) : [];
    const files = codeUris.length > 0 ? [] : Array.from(dt.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      const images = files.filter((f) => isImageFile(f.type, f.name));
      if (images.length < files.length) this.host.notify(ONLY_IMAGES_DROPPED, "warning");
      this.attachFiles(images, false);
      return;
    }
    const uris = codeUris.length > 0 ? codeUris : parseUriList(dt.getData("text/uri-list"));
    if (uris.length === 0 || uris.every(isWebUri)) return;
    e.preventDefault();
    post({ type: "dropFiles", uris });
  }

  // -------------------------------------------------------------------------

  private onInput(): void {
    // Typing leaves history browsing: the next Up starts again from the newest prompt.
    this.history.reset();
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
    const empty = this.textarea.value.trim().length === 0 && this.images.length === 0;
    const steering = this.turnActive && this.composableDuringTurn;
    // Dedicated Stop only while composing mid-turn; otherwise Send itself becomes Stop.
    this.stopBtn.hidden = !steering;
    const placeholder = steering ? PLACEHOLDER_STEER : PLACEHOLDER_IDLE;
    if (this.textarea.placeholder !== placeholder) this.textarea.placeholder = placeholder;
    if (this.turnActive && !this.composableDuringTurn) {
      btn.dataset.action = "cancel";
      btn.className = "send-btn is-stop";
      btn.disabled = false;
      btn.title = "Stop (Esc)";
      btn.setAttribute("aria-label", "Cancel the current turn");
      setChildren(btn, [icon("stop")]);
    } else {
      btn.dataset.action = "send";
      btn.className = "send-btn";
      btn.disabled = empty;
      btn.title = steering ? "Send now (Enter) — steers the running turn" : "Send (Enter)";
      btn.setAttribute("aria-label", steering ? "Send message now (steers the running turn)" : "Send message");
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
      return;
    }

    // Up on the first line / Down on the last line walk the sent prompts (like a shell).
    if (!open && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.isComposing) {
      if (e.key === "ArrowUp" && this.caretOnFirstLine() && this.recall(-1)) e.preventDefault();
      else if (e.key === "ArrowDown" && this.caretOnLastLine() && this.recall(1)) e.preventDefault();
    }
  }

  private caretOnFirstLine(): boolean {
    const ta = this.textarea;
    return !ta.value.slice(0, ta.selectionStart ?? 0).includes("\n");
  }

  private caretOnLastLine(): boolean {
    const ta = this.textarea;
    return !ta.value.slice(ta.selectionEnd ?? ta.value.length).includes("\n");
  }

  /** Show the previous (`-1`) or next (`+1`) sent prompt; false at either end. */
  private recall(direction: -1 | 1): boolean {
    const ta = this.textarea;
    const text = this.history.recall(direction, ta.value);
    if (text === null) return false;
    ta.value = text;
    ta.setSelectionRange(text.length, text.length);
    this.closePopup();
    this.autoGrow();
    this.updateSendState();
    window.clearTimeout(this.draftTimer);
    saveDraft(text);
    return true;
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
