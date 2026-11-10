import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCliPath, shellWrappedCommand } from "../src/acp/index.js";

function existsIn(found: string[]): (p: string) => Promise<boolean> {
  const set = new Set(found.map((f) => f.toLowerCase()));
  return async (p) => set.has(p.toLowerCase());
}

function tracking(found: string[]): { exists: (p: string) => Promise<boolean>; probed: string[] } {
  const probed: string[] = [];
  const inner = existsIn(found);
  return {
    probed,
    exists: async (p) => {
      probed.push(p);
      return inner(p);
    },
  };
}

test("resolveCliPath keeps values containing a path separator", async () => {
  const exists = existsIn([]);
  assert.equal(await resolveCliPath("C:\\tools\\kiro-cli.exe", "win32", {}, exists), "C:\\tools\\kiro-cli.exe");
  assert.equal(await resolveCliPath("./bin/kiro-cli", "linux", {}, exists), "./bin/kiro-cli");
});

test("resolveCliPath keeps a bare value that exists as given", async () => {
  const exists = existsIn(["kiro-cli"]);
  assert.equal(await resolveCliPath("kiro-cli", "linux", { PATH: "/usr/bin" }, exists), "kiro-cli");
});

test("resolveCliPath searches PATH entries in order with PATHEXT on win32", async () => {
  const { exists, probed } = tracking(["C:\\b\\kiro-cli.EXE"]);
  const env = { Path: "C:\\a;C:\\b;C:\\c", PATHEXT: ".EXE;.CMD" };
  const result = await resolveCliPath("kiro-cli", "win32", env, exists);
  assert.equal(result, "C:\\b\\kiro-cli.EXE");
  assert.deepEqual(probed, ["kiro-cli", "C:\\a\\kiro-cli", "C:\\a\\kiro-cli.EXE", "C:\\a\\kiro-cli.CMD", "C:\\b\\kiro-cli", "C:\\b\\kiro-cli.EXE"]);
});

test("resolveCliPath does not append PATHEXT when the name already has an extension", async () => {
  const { exists, probed } = tracking(["C:\\a\\kiro-cli.exe"]);
  const result = await resolveCliPath("kiro-cli.exe", "win32", { PATH: "C:\\a", PATHEXT: ".EXE" }, exists);
  assert.equal(result, "C:\\a\\kiro-cli.exe");
  assert.deepEqual(probed, ["kiro-cli.exe", "C:\\a\\kiro-cli.exe"]);
});

test("resolveCliPath searches PATH on linux", async () => {
  const exists = existsIn(["/usr/local/bin/kiro-cli"]);
  const result = await resolveCliPath("kiro-cli", "linux", { PATH: "/usr/bin:/usr/local/bin" }, exists);
  assert.equal(result, "/usr/local/bin/kiro-cli");
});

test("resolveCliPath falls back to the win32 default install locations", async () => {
  const env = { PATH: "C:\\nothing", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", ProgramFiles: "C:\\Program Files" };
  const { exists, probed } = tracking(["C:\\Users\\me\\AppData\\Local\\Programs\\Kiro-Cli\\kiro-cli.exe"]);
  const result = await resolveCliPath("kiro-cli", "win32", env, exists);
  assert.equal(result, "C:\\Users\\me\\AppData\\Local\\Programs\\Kiro-Cli\\kiro-cli.exe");
  assert.ok(probed.includes("C:\\Program Files\\Kiro-Cli\\kiro-cli.exe"), "Program Files is probed first");
  assert.ok(
    probed.indexOf("C:\\Program Files\\Kiro-Cli\\kiro-cli.exe") < probed.indexOf(result),
    "Program Files is probed before LOCALAPPDATA",
  );
});

test("resolveCliPath falls back to the darwin default install locations", async () => {
  const { exists, probed } = tracking(["/Users/me/.local/bin/kiro-cli"]);
  const result = await resolveCliPath("kiro-cli", "darwin", { PATH: "/usr/bin", HOME: "/Users/me" }, exists);
  assert.equal(result, "/Users/me/.local/bin/kiro-cli");
  assert.deepEqual(probed.slice(-3), ["/opt/homebrew/bin/kiro-cli", "/usr/local/bin/kiro-cli", "/Users/me/.local/bin/kiro-cli"]);
});

test("resolveCliPath falls back to the linux default install locations", async () => {
  const { exists, probed } = tracking(["/usr/bin/kiro-cli"]);
  const result = await resolveCliPath("kiro-cli", "linux", { PATH: "/opt/none", HOME: "/home/me" }, exists);
  assert.equal(result, "/usr/bin/kiro-cli");
  assert.deepEqual(probed.slice(-3), ["/home/me/.local/bin/kiro-cli", "/usr/local/bin/kiro-cli", "/usr/bin/kiro-cli"]);
});

test("resolveCliPath returns the configured value unchanged when nothing is found", async () => {
  const exists = existsIn([]);
  assert.equal(await resolveCliPath("kiro-cli", "linux", { PATH: "/usr/bin", HOME: "/home/me" }, exists), "kiro-cli");
});

test("resolveCliPath only tries kiro-cli defaults for the kiro-cli command", async () => {
  const { exists, probed } = tracking(["/usr/bin/kiro-cli"]);
  assert.equal(await resolveCliPath("node", "linux", { PATH: "/opt/none", HOME: "/home/me" }, exists), "node");
  assert.ok(!probed.includes("/usr/bin/kiro-cli"));
});

test("shellWrappedCommand routes .cmd/.bat through cmd.exe on win32 only", () => {
  const env = { ComSpec: "C:\Windows\System32\cmd.exe" };
  const cmd = shellWrappedCommand("C:\tools\kiro-cli.cmd", ["acp", "--agent-engine=v3"], "win32", env);
  assert.equal(cmd.command, env.ComSpec);
  assert.deepEqual(cmd.args, ["/d", "/s", "/c", '""C:\tools\kiro-cli.cmd" "acp" "--agent-engine=v3""']);
  const exe = shellWrappedCommand("C:\Program Files\Kiro-Cli\kiro-cli.exe", ["acp"], "win32", env);
  assert.deepEqual(exe, { command: "C:\Program Files\Kiro-Cli\kiro-cli.exe", args: ["acp"] });
  const posix = shellWrappedCommand("/opt/wrap/kiro-cli.cmd", ["acp"], "linux", env);
  assert.deepEqual(posix, { command: "/opt/wrap/kiro-cli.cmd", args: ["acp"] });
});
