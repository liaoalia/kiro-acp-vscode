/**
 * Builds the HTML document for the chat webview.
 *
 * Compiled by the extension tsconfig (no DOM lib), so this is a plain string
 * builder with no DOM references. The CSP only allows the nonce'd bundle,
 * stylesheets from the extension's media folder (plus inline styles used for
 * dynamic sizing) and local/data images; nothing remote is ever loaded.
 */

export interface WebviewHtmlOptions {
  /** `webview.cspSource`. */
  cspSource: string;
  /** Random per-load nonce for the script tag. */
  nonce: string;
  /** `webview.asWebviewUri(dist/webview.js)` as a string. */
  scriptUri: string;
  /** `webview.asWebviewUri(media/chat.css)` as a string. */
  styleUri: string;
}

/** Minimal escaping for values placed inside double-quoted attributes. */
function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function getWebviewHtml(opts: WebviewHtmlOptions): string {
  const csp = [
    "default-src 'none'",
    `style-src ${opts.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${opts.nonce}'`,
    `img-src ${opts.cspSource} data:`,
    `font-src ${opts.cspSource}`,
  ].join("; ");

  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="${attr(csp)};">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    "<title>Kiro Chat</title>",
    `<link rel="stylesheet" href="${attr(opts.styleUri)}">`,
    "</head>",
    "<body>",
    '<div id="app"></div>',
    `<script nonce="${attr(opts.nonce)}" src="${attr(opts.scriptUri)}"></script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
