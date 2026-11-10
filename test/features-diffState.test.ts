import { test } from "node:test";
import assert from "node:assert/strict";
import { DiffState } from "../src/features/pure/diffState.js";

const lower = (p: string) => p.toLowerCase().replace(/\//g, "\\");

test("register / diffsFor / remove", () => {
  const s = new DiffState();
  s.register("tc1", 1, { path: "/b", oldText: "x", newText: "y" });
  s.register("tc1", 0, { path: "/a", oldText: null, newText: "new" });
  assert.deepEqual(
    s.diffsFor("tc1").map((d) => d.index),
    [0, 1],
    "ordered by index",
  );
  assert.equal(s.hasDiffs("tc1"), true);
  assert.equal(s.hasDiffs("tc2"), false);
  assert.deepEqual(s.toolCallIds(), ["tc1"]);
  assert.equal(s.diffAt("tc1", 0)?.newText, "new");
  s.remove("tc1");
  assert.equal(s.hasDiffs("tc1"), false);
  assert.deepEqual(s.diffsFor("tc1"), []);
});

test("takeSubstitution matches normalised path and exact agent text", () => {
  const s = new DiffState(lower);
  s.addSubstitution("tc1", { path: "C:/ws/a.ts", agentText: "agent", userText: "user" });
  assert.equal(s.takeSubstitution("c:\\ws\\a.ts", "other"), undefined, "text must match");
  assert.equal(s.takeSubstitution("c:\\ws\\b.ts", "agent"), undefined, "path must match");
  assert.equal(s.takeSubstitution("c:\\WS\\a.ts", "agent"), "user");
  assert.equal(s.takeSubstitution("c:\\ws\\a.ts", "agent"), undefined, "consumed");
});

test("pendingFor / dropSubstitutions / replace same path", () => {
  const s = new DiffState();
  s.addSubstitution("tc1", { path: "/a", agentText: "1", userText: "2" });
  s.addSubstitution("tc1", { path: "/a", agentText: "3", userText: "4" });
  s.addSubstitution("tc2", { path: "/b", agentText: "5", userText: "6" });
  assert.deepEqual(s.pendingFor("tc1"), [{ path: "/a", agentText: "3", userText: "4" }]);
  assert.equal(s.substitutions().length, 2);
  s.dropSubstitutions("tc1");
  assert.deepEqual(s.pendingFor("tc1"), []);
  assert.equal(s.pendingFor("tc2").length, 1);
  s.clear();
  assert.equal(s.substitutions().length, 0);
});

test("removing diffs keeps substitutions", () => {
  const s = new DiffState();
  s.register("tc1", 0, { path: "/a", oldText: null, newText: "n" });
  s.addSubstitution("tc1", { path: "/a", agentText: "n", userText: "u" });
  s.remove("tc1");
  assert.equal(s.takeSubstitution("/a", "n"), "u");
});
