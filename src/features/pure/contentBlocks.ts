/**
 * Build the `session/prompt` content blocks from the typed text and the
 * context chips (DECISIONS.md D10). vscode-free; tested in
 * `test/features-contentBlocks.test.ts`.
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import type { ContextChip } from "../../ui/protocol.js";

export interface PromptCapabilities {
  /** `promptCapabilities.embeddedContext` advertised by the agent. */
  embeddedContext: boolean;
}

const MIME_BY_EXT: Record<string, string> = {
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".jsx": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".py": "text/x-python",
  ".rs": "text/x-rust",
  ".go": "text/x-go",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++",
  ".hpp": "text/x-c++",
  ".cs": "text/x-csharp",
  ".html": "text/html",
  ".css": "text/css",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".xml": "text/xml",
  ".sh": "text/x-shellscript",
  ".ps1": "text/x-powershell",
  ".txt": "text/plain",
};

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".json": "json",
  ".md": "md",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".html": "html",
  ".css": "css",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".sh": "bash",
  ".ps1": "powershell",
  ".sql": "sql",
};

/** MIME type for a few common text file types; `undefined` otherwise. */
export function guessMimeType(filePath: string): string | undefined {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()];
}

/** Fence language id for a path (empty string when unknown). */
export function languageForPath(filePath: string): string {
  return LANG_BY_EXT[path.extname(filePath).toLowerCase()] ?? "";
}

/** `file:///…` URL for an absolute path. */
export function fileUrlFor(absPath: string): string {
  return pathToFileURL(absPath).href;
}

/** Lines `start..end` (1-based, inclusive) of `text`, joined with "\n". */
export function extractLines(text: string, start: number, end: number): string {
  const lines = text.split(/\r?\n/);
  const from = Math.max(0, Math.min(start, end) - 1);
  const to = Math.min(lines.length, Math.max(start, end));
  return lines.slice(from, to).join("\n");
}

function fileLinkBlock(chip: ContextChip): acp.ContentBlock {
  const mimeType = guessMimeType(chip.path);
  return {
    type: "resource_link",
    uri: fileUrlFor(chip.path),
    name: chip.label,
    ...(mimeType ? { mimeType } : {}),
  };
}

/**
 * Compose the prompt: the text block first (when non-empty), then one block
 * per chip. Files become `resource_link`s; selections become an embedded
 * `resource` (`uri#L<start>-L<end>`) when `caps.embeddedContext`, else a
 * fenced `text` block. A selection whose file cannot be read degrades to a
 * `resource_link` for the file.
 */
export async function buildPromptBlocks(
  text: string,
  chips: readonly ContextChip[],
  read: (absPath: string) => Promise<string>,
  caps: PromptCapabilities,
): Promise<acp.ContentBlock[]> {
  const blocks: acp.ContentBlock[] = [];
  if (text.length > 0) {
    blocks.push({ type: "text", text });
  }
  const seen = new Set<string>();
  for (const chip of chips) {
    if (seen.has(chip.id)) {
      continue;
    }
    seen.add(chip.id);
    if (chip.kind === "file") {
      blocks.push(fileLinkBlock(chip));
      continue;
    }
    const start = chip.startLine ?? 1;
    const end = chip.endLine ?? start;
    let snippet: string;
    try {
      snippet = extractLines(await read(chip.path), start, end);
    } catch {
      blocks.push(fileLinkBlock(chip));
      continue;
    }
    const mimeType = guessMimeType(chip.path);
    if (caps.embeddedContext) {
      blocks.push({
        type: "resource",
        resource: {
          uri: `${fileUrlFor(chip.path)}#L${start}-L${end}`,
          text: snippet,
          ...(mimeType ? { mimeType } : {}),
        },
      });
    } else {
      const lang = languageForPath(chip.path);
      blocks.push({
        type: "text",
        text: `Selection from ${chip.label}:${start}-${end}:\n\`\`\`${lang}\n${snippet}\n\`\`\``,
      });
    }
  }
  return blocks;
}
