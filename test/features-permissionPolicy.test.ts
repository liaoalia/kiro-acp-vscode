import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PermissionPolicy,
  decide,
  decisionOfOption,
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

test("decide consults the (session, toolKind) rule", () => {
  const policy = new PermissionPolicy();
  assert.equal(decide(policy, "s1", "edit", options), undefined);
  policy.set("s1", "edit", "allow");
  assert.equal(decide(policy, "s1", "edit", options), "once");
  assert.equal(decide(policy, "s1", "execute", options), undefined, "other kinds unaffected");
  assert.equal(decide(policy, "s2", "edit", options), undefined, "other sessions unaffected");
  policy.set("s1", "execute", "reject");
  assert.equal(decide(policy, "s1", "execute", options), "no");
});

test("clear removes one session or all", () => {
  const policy = new PermissionPolicy();
  policy.set("s1", "edit", "allow");
  policy.set("s2", "edit", "allow");
  policy.clear("s1");
  assert.equal(policy.get("s1", "edit"), undefined);
  assert.equal(policy.get("s2", "edit"), "allow");
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
