/**
 * Builds the SDK `Stream` for a child process, optionally tapping the
 * newline-delimited JSON in both directions for protocol tracing.
 */
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Transform, Writable, type TransformCallback } from "node:stream";
import type { AgentChildProcess } from "./process.js";
import type { ProtocolLogger } from "./types.js";

/** Pass-through transform that reports every complete line it forwards. */
export class LineTap extends Transform {
  private pending = "";

  constructor(private readonly onLine: (line: string) => void) {
    super();
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.pending += text;
    let index = this.pending.indexOf("\n");
    while (index >= 0) {
      const line = this.pending.slice(0, index).replace(/\r$/, "");
      this.pending = this.pending.slice(index + 1);
      if (line.trim().length > 0) this.safeReport(line);
      index = this.pending.indexOf("\n");
    }
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    if (this.pending.trim().length > 0) this.safeReport(this.pending);
    this.pending = "";
    callback();
  }

  private safeReport(line: string): void {
    try {
      this.onLine(line);
    } catch {
      // tracing must never break the transport
    }
  }
}

/** Attach a line-splitting listener to a readable (used for stderr). */
export function readLines(stream: Readable, onLine: (line: string) => void): void {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    pending += chunk;
    let index = pending.indexOf("\n");
    while (index >= 0) {
      const line = pending.slice(0, index).replace(/\r$/, "");
      pending = pending.slice(index + 1);
      onLine(line);
      index = pending.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (pending.length > 0) onLine(pending);
    pending = "";
  });
}

/**
 * Wrap a stream so that `intercept` sees every incoming notification before
 * the SDK does. When it returns `true` the message is consumed and never
 * reaches the SDK's dispatcher. Requests and responses always pass through.
 *
 * Used for `session/update` and Kiro `_…` notifications: the SDK's built-in
 * session-update router validates `session/update` strictly and drops unknown
 * update kinds before any app handler runs, and its async dispatch would let
 * a `session/prompt` response overtake updates sent before it. Intercepting at
 * the stream keeps wire order and lets the client stay lenient.
 */
export function interceptNotifications(
  stream: acp.Stream,
  intercept: (method: string, params: unknown, raw: acp.AnyNotification) => boolean,
): acp.Stream {
  const transform = new TransformStream<acp.AnyMessage, acp.AnyMessage>({
    transform(message, controller) {
      if (isNotification(message)) {
        let consumed = false;
        try {
          consumed = intercept(message.method, message.params, message);
        } catch {
          consumed = false;
        }
        if (consumed) return;
      }
      controller.enqueue(message);
    },
  });
  return {
    writable: stream.writable,
    readable: stream.readable.pipeThrough(transform),
  };
}

function isNotification(message: acp.AnyMessage): message is acp.AnyNotification {
  return typeof message === "object" && message !== null && "method" in message && !("id" in message);
}

/**
 * Create the ACP stream over the child's stdin/stdout. When `logger.trace`
 * exists every outgoing and incoming JSON line is reported.
 */
export function createChildStream(child: AgentChildProcess, logger: ProtocolLogger): acp.Stream {
  const trace = logger.trace?.bind(logger);

  let outbound: Writable = child.stdin;
  let inbound: Readable = child.stdout;

  if (trace) {
    const sendTap = new LineTap((line) => trace("send", line));
    sendTap.pipe(child.stdin);
    // Errors on stdin (EPIPE after exit) must not crash the host.
    sendTap.on("error", () => undefined);
    outbound = sendTap;

    const recvTap = new LineTap((line) => trace("recv", line));
    child.stdout.pipe(recvTap);
    recvTap.on("error", () => undefined);
    inbound = recvTap;
  }

  return acp.ndJsonStream(
    Writable.toWeb(outbound) as WritableStream<Uint8Array>,
    Readable.toWeb(inbound) as ReadableStream<Uint8Array>,
  );
}
