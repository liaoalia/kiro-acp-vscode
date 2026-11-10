/**
 * Markdown → sanitised DOM for agent messages.
 *
 * `marked` (GFM, no soft-break conversion) produces HTML which DOMPurify then
 * strips down: no inline styles, no event handlers, no images/embeds, links only
 * for http(s). VS Code's webview host intercepts clicks on http(s) anchors and
 * opens them externally, so plain `<a>` elements are all that is needed.
 */
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { actionButton, h, icon } from "./dom";

const marked = new Marked({ gfm: true, breaks: false, async: false });

const FORBID_TAGS = ["style", "img", "picture", "svg", "math", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "video", "audio", "link", "meta", "base"];
const FORBID_ATTR = ["style", "srcset", "ping", "formaction", "action", "background", "poster"];
const ALLOWED_URI_REGEXP = /^https?:\/\//i;

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    if (node.hasAttribute("href")) {
      node.setAttribute("rel", "noopener noreferrer");
      node.setAttribute("title", node.getAttribute("href") ?? "");
    } else {
      // A link whose href was stripped is just text.
      node.removeAttribute("target");
    }
  }
});

export function markdownToHtml(src: string): string {
  const html = marked.parse(src, { async: false });
  return DOMPurify.sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOWED_URI_REGEXP,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
}

/** Renders markdown into `target` (replacing its content) and enhances code blocks. */
export function renderMarkdownInto(target: HTMLElement, src: string): void {
  target.innerHTML = markdownToHtml(src);
  enhanceCodeBlocks(target);
}

function languageOf(code: HTMLElement | null): string {
  if (!code) return "";
  for (const cls of Array.from(code.classList)) {
    if (cls.startsWith("language-")) return cls.slice("language-".length);
  }
  return "";
}

/** Wraps each `<pre>` in a container with a language label and a Copy button. */
export function enhanceCodeBlocks(root: HTMLElement): void {
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    if (pre.parentElement?.classList.contains("codeblock")) continue;
    const lang = languageOf(pre.querySelector("code"));
    const wrapper = h("div", { class: "codeblock" });
    const tools = h(
      "div",
      { class: "code-tools" },
      h("span", { class: "code-lang" }, lang),
      actionButton("copy-code", [icon("copy"), h("span", { class: "copy-label" }, "Copy")], {
        cls: "btn btn-ghost btn-xs copy-btn",
        title: "Copy code",
        ariaLabel: "Copy code to clipboard",
      }),
    );
    pre.replaceWith(wrapper);
    wrapper.appendChild(tools);
    wrapper.appendChild(pre);
  }
}

/** Copies text, guarding against environments without the async clipboard. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
