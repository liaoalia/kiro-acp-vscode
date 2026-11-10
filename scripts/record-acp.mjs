#!/usr/bin/env node
/**
 * Record a raw ACP exchange with `kiro-cli acp` (or any ACP agent).
 *
 * Usage:
 *   node scripts/record-acp.mjs [--cli <path>] [--arg <extra-arg>]... [--cwd <dir>]
 *                               [--prompt "<text>"] [--out <file.ndjson>] [--timeout <ms>]
 *
 * It sends `initialize`, then `session/new`, then (optionally) one
 * `session/prompt`, auto-answers permission requests with the first option,
 * serves fs/terminal requests minimally, and writes every line in both
 * directions (plus stderr) to the output file. The file is the basis for
 * docs/protocol-notes.md and for new test recordings.
 *
 * This script uses the SDK only for message framing; it logs raw JSON.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const argv = process.argv.slice(2);
const opt = { cli: "kiro-cli", args: [], cwd: process.cwd(), prompt: null, out: "docs/recordings/kiro-initialize.ndjson", timeout: 120000 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--cli") opt.cli = argv[++i];
  else if (a === "--arg") opt.args.push(argv[++i]);
  else if (a === "--cwd") opt.cwd = resolve(argv[++i]);
  else if (a === "--prompt") opt.prompt = argv[++i];
  else if (a === "--out") opt.out = argv[++i];
  else if (a === "--timeout") opt.timeout = Number(argv[++i]);
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}

mkdirSync(dirname(resolve(opt.out)), { recursive: true });
const log = createWriteStream(resolve(opt.out));
const t0 = Date.now();
function record(dir, text) {
  const line = JSON.stringify({ t: Date.now() - t0, dir, ...(dir === "stderr" ? { text } : { msg: tryParse(text) }) });
  log.write(line + "\n");
  console.error(`[${dir}] ${text.length > 400 ? text.slice(0, 400) + "…" : text}`);
}
function tryParse(s) { try { return JSON.parse(s); } catch { return s; } }

const child = spawn(opt.cli, ["acp", ...opt.args], { cwd: opt.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
child.on("error", (e) => { record("stderr", `spawn error: ${e.message}`); process.exit(1); });
child.on("exit", (code, sig) => record("stderr", `exit code=${code} signal=${sig}`));

// Tee stdout lines into the log before handing them to the SDK.
const teeIn = new TransformStream({
  transform(chunk, controller) {
    controller.enqueue(chunk);
  },
});
let inBuf = "";
child.stdout.on("data", (d) => {
  inBuf += d.toString("utf8");
  let i;
  while ((i = inBuf.indexOf("\n")) >= 0) { record("recv", inBuf.slice(0, i)); inBuf = inBuf.slice(i + 1); }
});
let errBuf = "";
child.stderr.on("data", (d) => {
  errBuf += d.toString("utf8");
  let i;
  while ((i = errBuf.indexOf("\n")) >= 0) { record("stderr", errBuf.slice(0, i)); errBuf = errBuf.slice(i + 1); }
});
const outTee = new Writable({
  write(chunk, _enc, cb) {
    const s = chunk.toString("utf8");
    for (const line of s.split("\n")) if (line.trim()) record("send", line);
    child.stdin.write(chunk, cb);
  },
});
const stream = acp.ndJsonStream(Writable.toWeb(outTee), Readable.toWeb(child.stdout).pipeThrough(teeIn));

const timer = setTimeout(() => { record("stderr", "timeout"); finish(3); }, opt.timeout);
function finish(code) { clearTimeout(timer); log.end(); child.kill(); setTimeout(() => process.exit(code), 200); }

const app = acp.client({ name: "record-acp" })
  .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
    const first = ctx.params.options[0];
    return { outcome: first ? { outcome: "selected", optionId: first.optionId } : { outcome: "cancelled" } };
  })
  .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
    const { readFile } = await import("node:fs/promises");
    try { return { content: await readFile(ctx.params.path, "utf8") }; } catch (e) { throw new acp.RequestError(-32603, String(e)); }
  })
  .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(ctx.params.path, ctx.params.content, "utf8");
    return {};
  })
  .onRequest("*", (ctx) => { throw acp.RequestError.methodNotFound(ctx.method); })
  .onNotification(acp.methods.client.session.update, () => {})
  .onNotification("*", () => {});

app.connectWith(stream, async (agent) => {
  const init = await agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, auth: { terminal: true }, _meta: { kiro: { openExternalUrl: true }, "terminal-auth": true } },
    clientInfo: { name: "kiro-acp-vscode-recorder", version: "0.0.0" },
  });
  console.error("initialize ok:", JSON.stringify(init, null, 2));
  let session;
  try {
    session = await agent.request(acp.methods.agent.session.new, { cwd: opt.cwd, mcpServers: [] });
    console.error("session/new ok:", JSON.stringify(session, null, 2));
  } catch (e) {
    console.error("session/new failed:", e);
    return finish(0);
  }
  if (opt.prompt) {
    const res = await agent.request(acp.methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: "text", text: opt.prompt }] });
    console.error("prompt done:", JSON.stringify(res));
  }
  finish(0);
}).catch((e) => { console.error("fatal:", e); finish(1); });
