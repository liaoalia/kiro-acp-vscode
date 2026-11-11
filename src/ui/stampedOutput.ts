/**
 * An `OutputChannel` whose lines start with the local time (`HH:MM:SS.mmm`):
 * the Kiro ACP log is read to find out who waited for whom (a stuck turn,
 * a late reply), which is impossible without timestamps.
 */
import * as vscode from "vscode";

export function timeStamp(date = new Date()): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

class StampedOutputChannel implements vscode.OutputChannel {
  constructor(private readonly inner: vscode.OutputChannel) {}

  get name(): string {
    return this.inner.name;
  }

  append(value: string): void {
    this.inner.append(value);
  }

  appendLine(value: string): void {
    this.inner.appendLine(`${timeStamp()} ${value}`);
  }

  replace(value: string): void {
    this.inner.replace(value);
  }

  clear(): void {
    this.inner.clear();
  }

  show(columnOrPreserveFocus?: vscode.ViewColumn | boolean, preserveFocus?: boolean): void {
    if (typeof columnOrPreserveFocus === "boolean" || columnOrPreserveFocus === undefined) {
      this.inner.show(columnOrPreserveFocus);
    } else {
      // Deprecated overload kept for completeness.
      this.inner.show(columnOrPreserveFocus, preserveFocus);
    }
  }

  hide(): void {
    this.inner.hide();
  }

  dispose(): void {
    this.inner.dispose();
  }
}

export function stampedOutput(inner: vscode.OutputChannel): vscode.OutputChannel {
  return new StampedOutputChannel(inner);
}
