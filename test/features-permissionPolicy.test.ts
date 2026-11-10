import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PermissionPolicy,
  decide,
  decisionOfOption,
  looksLikePath,
  offeredPolicies,
  policyKey,
  selectOption,
} from "../src/features/pure/permissionPolicy.js";

const options = [
  { optionId: "once", kind: "allow_once" as const },
  { optionId: "always", kind: "allow_always" as const },
  { optionId: "no", kind: "reject_once" as const },
  { optionId: "never", kind: "reject_always" as const },
];

test("selectOption prefers allow_once / reject_once", () => {
  assert.equal(selectOption(options, "allow"), "once");
  assert.equal(selectOption(options, "reject"), "no");
});

test("selectOption falls back to *_always when *_once is missing", () => {
  const onlyAlways = options.filter((o) => o.kind.endsWith("always"));
  assert.equal(selectOption(onlyAlways, "allow"), "always");
  assert.equal(selectOption(onlyAlways, "reject"), "never");
});

test("selectOption returns undefined when no matching option exists", () => {
  assert.equal(selectOption([{ optionId: "x", kind: "reject_once" }], "allow"), undefined);
  assert.equal(selectOption([], "reject"), undefined);
});

test("decide consults the (session, kind) rule", () => {
  const policy = new PermissionPolicy();
  assert.equal(decide(policy, "s1", "edit", options), undefined);
  policy.set("s1", "kind:edit", "allow");
  assert.equal(decide(policy, "s1", "edit", options), "once");
  assert.equal(decide(policy, "s1", "execute", options), undefined, "other kinds unaffected");
  assert.equal(decide(policy, "s2", "edit", options), undefined, "other sessions unaffected");
  policy.set("s1", "kind:execute", "reject");
  assert.equal(decide(policy, "s1", "execute", options), "no");
});

test("policyKey builds kind / capability / resource keys and normalises file paths", () => {
  const subject = { toolKind: "edit", capability: "fs_write", resource: "/work/src/../hello.txt" };
  assert.equal(policyKey("kind", subject, "linux"), "kind:edit");
  assert.equal(policyKey("capability", subject, "linux"), "cap:fs_write");
  assert.equal(policyKey("resource", subject, "linux"), "res:/work/hello.txt");
  assert.equal(policyKey("resource", { toolKind: "edit", resource: "C:/Work/a/../hello.txt" }, "win32"), "res:c:\\Work\\hello.txt");
  assert.equal(policyKey("capability", { toolKind: "edit" }), undefined, "no capability → no key");
  assert.equal(policyKey("resource", { toolKind: "edit" }), undefined, "no resource → no key");
  // Non-path resources (a shell command) are kept verbatim.
  assert.equal(policyKey("resource", { toolKind: "execute", resource: "npm test" }), "res:npm test");
});

test("looksLikePath accepts absolute paths only", () => {
  assert.equal(looksLikePath("/work/hello.txt", "linux"), true);
  assert.equal(looksLikePath("C:\\work\\hello.txt", "win32"), true);
  assert.equal(looksLikePath("hello.txt", "linux"), false);
  assert.equal(looksLikePath("npm test", "linux"), false);
  assert.equal(looksLikePath("/bin/sh -c 'x'\nrm", "linux"), false);
});

test("decide prefers the resource rule, then the capability rule, then the kind rule", () => {
  const policy = new PermissionPolicy();
  const a = { toolKind: "edit", capability: "fs_write", resource: "/w/a.txt" };
  const b = { toolKind: "edit", capability: "fs_write", resource: "/w/b.txt" };
  const c = { toolKind: "edit", capability: "fs_delete", resource: "/w/c.txt" };

  policy.set("s1", policyKey("kind", a, "linux")!, "reject");
  assert.equal(decide(policy, "s1", a, options, "linux"), "no", "kind rule applies to a");
  assert.equal(decide(policy, "s1", c, options, "linux"), "no", "kind rule applies to c");

  policy.set("s1", policyKey("capability", a, "linux")!, "allow");
  assert.equal(decide(policy, "s1", a, options, "linux"), "once", "capability beats kind for a");
  assert.equal(decide(policy, "s1", b, options, "linux"), "once", "capability beats kind for b");
  assert.equal(decide(policy, "s1", c, options, "linux"), "no", "other capability still falls back to kind");

  policy.set("s1", policyKey("resource", b, "linux")!, "reject");
  assert.equal(decide(policy, "s1", b, options, "linux"), "no", "resource beats capability for b");
  assert.equal(decide(policy, "s1", a, options, "linux"), "once", "a is unaffected by b's resource rule");
  assert.equal(
    decide(policy, "s1", { ...b, resource: "/w/x/../b.txt" }, options, "linux"),
    "no",
    "resource keys are normalised",
  );
  assert.equal(decide(policy, "s2", b, options, "linux"), undefined, "other session unaffected");
});

test("a resource rule without consent fields never matches, and a kind-only request uses the kind rule", () => {
  const policy = new PermissionPolicy();
  policy.set("s1", "res:/w/a.txt", "allow");
  assert.equal(decide(policy, "s1", { toolKind: "edit" }, options, "linux"), undefined);
  policy.set("s1", "cap:fs_write", "allow");
  assert.equal(decide(policy, "s1", { toolKind: "edit" }, options, "linux"), undefined);
  policy.set("s1", "kind:edit", "reject");
  assert.equal(decide(policy, "s1", { toolKind: "edit" }, options, "linux"), "no");
});

test("clear removes one session (every scope) or all", () => {
  const policy = new PermissionPolicy();
  policy.set("s1", "kind:edit", "allow");
  policy.set("s1", "cap:fs_write", "allow");
  policy.set("s1", "res:/w/a.txt", "reject");
  policy.set("s2", "kind:edit", "allow");
  policy.clear("s1");
  assert.equal(policy.get("s1", "kind:edit"), undefined);
  assert.equal(policy.get("s1", "cap:fs_write"), undefined);
  assert.equal(policy.get("s1", "res:/w/a.txt"), undefined);
  assert.equal(policy.get("s2", "kind:edit"), "allow");
  policy.clear();
  assert.equal(policy.size, 0);
});

test("decisionOfOption maps option ids back to allow/reject", () => {
  assert.equal(decisionOfOption(options, "once"), "allow");
  assert.equal(decisionOfOption(options, "always"), "allow");
  assert.equal(decisionOfOption(options, "no"), "reject");
  assert.equal(decisionOfOption(options, "never"), "reject");
  assert.equal(decisionOfOption(options, "nope"), undefined);
});

test("offeredPolicies: kind labels use the tool-kind noun", () => {
  const labels = (kind: string) => offeredPolicies({ toolKind: kind }).map((p) => [p.scope, p.label, p.rejectLabel]);
  assert.deepEqual(labels("edit"), [["kind", "Allow all edits this session", "Reject all edits this session"]]);
  assert.deepEqual(labels("read"), [["kind", "Allow all reads this session", "Reject all reads this session"]]);
  assert.deepEqual(labels("execute"), [["kind", "Allow all commands this session", "Reject all commands this session"]]);
  assert.deepEqual(labels("delete"), [["kind", "Allow all deletions this session", "Reject all deletions this session"]]);
  assert.deepEqual(labels("move"), [["kind", "Allow all moves this session", "Reject all moves this session"]]);
  assert.deepEqual(labels("search"), [["kind", "Allow all searches this session", "Reject all searches this session"]]);
  assert.deepEqual(labels("fetch"), [["kind", "Allow all fetches this session", "Reject all fetches this session"]]);
  assert.deepEqual(labels("switch_mode"), [
    ["kind", "Allow all mode switches this session", "Reject all mode switches this session"],
  ]);
  assert.deepEqual(labels("think"), [["kind", "Allow all thoughts this session", "Reject all thoughts this session"]]);
  assert.deepEqual(labels("other"), [
    ["kind", "Allow all actions of this kind this session", "Reject all actions of this kind this session"],
  ]);
});

test("offeredPolicies: capability and file resource add their own entries", () => {
  const offered = offeredPolicies(
    { toolKind: "edit", capability: "fs_write", resource: "/work/src/hello.txt" },
    "linux",
  );
  assert.deepEqual(
    offered.map((p) => p.scope),
    ["kind", "capability", "resource"],
    "general to specific",
  );
  assert.equal(offered[1]!.label, "Allow all fs_write this session");
  assert.equal(offered[1]!.rejectLabel, "Reject all fs_write this session");
  assert.equal(offered[2]!.label, "Allow all changes to hello.txt this session");
  assert.equal(offered[2]!.rejectLabel, "Reject all changes to hello.txt this session");

  const win = offeredPolicies({ toolKind: "edit", resource: "C:\\Work\\tasks.json" }, "win32");
  assert.equal(win[1]!.label, "Allow all changes to tasks.json this session");
});

test("offeredPolicies: a non-path resource is quoted verbatim; a capability equal to the kind is skipped", () => {
  const offered = offeredPolicies({ toolKind: "execute", capability: "execute", resource: "npm test" });
  assert.deepEqual(
    offered.map((p) => [p.scope, p.label, p.rejectLabel]),
    [
      ["kind", "Allow all commands this session", "Reject all commands this session"],
      ["resource", 'Allow "npm test" every time this session', 'Reject "npm test" every time this session'],
    ],
  );
  assert.deepEqual(
    offeredPolicies({ toolKind: "edit", capability: "  " }).map((p) => p.scope),
    ["kind"],
    "a blank capability offers nothing",
  );
});
