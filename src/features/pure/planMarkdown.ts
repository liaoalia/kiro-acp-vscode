/**
 * Render the agent plan as Markdown for the `kiro-plan:` document (D11).
 * vscode-free; tested in `test/features-planMarkdown.test.ts`.
 */
import type { PlanEntryView } from "../../ui/protocol.js";

export interface PlanRenderOptions {
  sessionId?: string;
  updatedAt?: Date;
  /** A `switch_mode` permission request is waiting for the user. */
  approvalPending: boolean;
}

export const PLAN_TITLE = "# Kiro plan";
export const PLAN_EMPTY_TEXT =
  "No plan yet. Ask Kiro to plan a task and the steps will appear here as the agent reports them.";
export const PLAN_APPROVAL_NOTE =
  "> The agent is waiting for approval — use Approve/Reject in the editor title.";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Status summary such as `3 of 7 done · 1 in progress`. */
export function planStatusLine(entries: readonly PlanEntryView[]): string {
  const total = entries.length;
  const done = entries.filter((e) => e.status === "completed").length;
  const inProgress = entries.filter((e) => e.status === "in_progress").length;
  let line = `${done} of ${total} done`;
  if (inProgress > 0) {
    line += ` · ${inProgress} in progress`;
  }
  return line;
}

/** One task-list line for an entry. */
export function renderPlanEntry(entry: PlanEntryView): string {
  const box = entry.status === "completed" ? "[x]" : "[ ]";
  const marker = entry.status === "in_progress" ? "⏳ " : "";
  const badge =
    entry.priority === "high" ? "**(high)** " : entry.priority === "low" ? "(low) " : "";
  const content = entry.content.replace(/\r?\n/g, " ").trim();
  return `- ${box} ${marker}${badge}${content}`;
}

/**
 * Full document text. Layout:
 *
 * ```
 * # Kiro plan
 * _Session abc · updated 12:34:56_
 *
 * **3 of 7 done · 1 in progress**
 *
 * > approval note (when pending)
 *
 * - [x] **(high)** done task
 * - [ ] ⏳ in-progress task
 * - [ ] (low) pending task
 * ```
 */
export function renderPlanMarkdown(
  entries: readonly PlanEntryView[],
  opts: PlanRenderOptions,
): string {
  const lines: string[] = [PLAN_TITLE];
  const meta: string[] = [];
  if (opts.sessionId) {
    meta.push(`Session ${opts.sessionId}`);
  }
  if (opts.updatedAt) {
    meta.push(`updated ${formatTime(opts.updatedAt)}`);
  }
  if (meta.length > 0) {
    lines.push(`_${meta.join(" · ")}_`);
  }
  lines.push("");
  if (opts.approvalPending) {
    lines.push(PLAN_APPROVAL_NOTE, "");
  }
  if (entries.length === 0) {
    lines.push(PLAN_EMPTY_TEXT, "");
    return lines.join("\n");
  }
  lines.push(`**${planStatusLine(entries)}**`, "");
  for (const entry of entries) {
    lines.push(renderPlanEntry(entry));
  }
  lines.push("");
  return lines.join("\n");
}
