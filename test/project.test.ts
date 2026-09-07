import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGitRoot, projectIdFromPath } from "../src/project.ts";

test("findGitRoot finds ancestor .git dir", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-git-"));
  try {
    mkdirSync(join(root, ".git"));
    const sub = join(root, "a", "b");
    mkdirSync(sub, { recursive: true });
    assert.equal(await findGitRoot(sub), root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("findGitRoot honors .git files (worktrees)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-gitfile-"));
  try {
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere/main/.git/worktrees/x", "utf8");
    const sub = join(root, "deep");
    mkdirSync(sub, { recursive: true });
    assert.equal(await findGitRoot(sub), root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("findGitRoot returns null when no git", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-nogit-"));
  try {
    assert.equal(await findGitRoot(root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("projectIdFromPath is a stable 16-hex prefix of sha256 and prefixed pi-mem-", () => {
  const a = projectIdFromPath("C:/repos/myproj");
  const b = projectIdFromPath("C:/repos/myproj");
  const c = projectIdFromPath("C:/repos/otherproj");
  assert.match(a, /^pi-mem-[0-9a-f]{16}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});
