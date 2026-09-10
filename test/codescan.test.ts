/**
 * codescan tests — fixture-tree based (spec §15). Every expectation is exact:
 * the extractor is heuristic by design, so regressions must be loud.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo, summaryFor, fileSummaryFor, MAX_FILES } from "../src/codescan.ts";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "pi-qm-scan-"));
}

test("scanRepo extracts tsjs top-level definitions with docs and ranges", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), [
      "/** Adds numbers. */",
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "",
      "function hidden() {",
      "  return 1;",
      "}",
      "",
      "export interface Shape {",
      "  area(): number;",
      "}",
      "",
      "export type Pair = [number, number];",
      "",
      "export enum Color { Red }",
      "",
      "export const twice = (n: number) => n * 2;",
    ].join("\n"));
    const { files } = scanRepo(root);
    assert.equal(files.length, 1);
    const file = files[0]!;
    assert.equal(file.filePath, "src/a.ts");
    const byName = new Map(file.nodes.map((n) => [n.name, n]));

    const add = byName.get("add")!;
    assert.equal(add.kind, "function");
    assert.equal(add.exported, true);
    assert.equal(add.startLine, 2);
    assert.equal(add.endLine, 4);
    assert.equal(add.doc, "Adds numbers.");
    assert.ok(add.signature.includes("add(a: number, b: number)"));

    assert.equal(byName.get("hidden")!.exported, false);
    assert.equal(byName.get("Shape")!.kind, "interface");
    assert.equal(byName.get("Pair")!.kind, "type");
    assert.equal(byName.get("Color")!.kind, "enum");
    assert.equal(byName.get("twice")!.kind, "function");
    assert.equal(byName.size, 6);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scanRepo handles python indent logic, docstrings, and privacy", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "mod.py"), [
      '"""Module docstring."""',
      "class Thing:",
      "    def method(self):",
      "        return 1",
      "",
      "def top_level():",
      '    """Does the thing."""',
      "    return 2",
      "",
      "def _private():",
      "    return 3",
      "",
      "async def afunc():",
      "    return 4",
    ].join("\n"));
    const { files } = scanRepo(root);
    const file = files[0]!;
    const byName = new Map(file.nodes.map((n) => [n.name, n]));
    assert.equal(file.nodes.length, 4); // class Thing, top_level, _private, afunc — method excluded
    const top = byName.get("top_level")!;
    assert.equal(top.startLine, 6);
    assert.equal(top.endLine, 8); // stops at the blank/next-def boundary
    assert.equal(top.doc, "Does the thing.");
    assert.equal(byName.get("_private")!.exported, false);
    assert.equal(byName.get("afunc")!.exported, true);
    assert.equal(byName.get("Thing")!.kind, "class");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scanRepo falls back to generic tables for other languages", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "main.go"), [
      "// Adds one.",
      "func AddOne(n int) int {",
      "  return n + 1",
      "}",
      "",
      "type Pair struct {",
      "  A int",
      "}",
    ].join("\n"));
    const { files } = scanRepo(root);
    const byName = new Map(files[0]!.nodes.map((n) => [n.name, n]));
    assert.equal(byName.get("AddOne")!.kind, "function");
    assert.equal(byName.get("AddOne")!.doc, "Adds one.");
    assert.equal(byName.get("Pair")!.kind, "struct");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scanRepo skips vendor/dot dirs, oversized files, and unknown extensions", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, ".hidden"));
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "node_modules", "x.ts"), "function a() {}\n");
    writeFileSync(join(root, ".hidden", "y.ts"), "function b() {}\n");
    writeFileSync(join(root, "dist", "z.ts"), "function c() {}\n");
    writeFileSync(join(root, "src", "ok.ts"), "function keep() {}\n");
    writeFileSync(join(root, "src", "big.ts"), "const pad = \"" + "x".repeat(1_000_001) + "\";\nfunction dropped() {}\n");
    writeFileSync(join(root, "src", "notes.txt"), "function notCode() {}\n");
    const { files } = scanRepo(root);
    assert.deepEqual(files.map((f) => f.filePath), ["src/ok.ts"]);
    assert.equal(files[0]!.nodes.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scanRepo reports the file-count cap instead of truncating silently", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, "src"));
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, "src", `f${String(i)}.ts`), `function fn${String(i)}() {}\n`);
    }
    const { files, capped } = scanRepo(root, { maxFiles: 3 });
    assert.equal(files.length, 3);
    assert.equal(capped, true);
    const full = scanRepo(root, { maxFiles: MAX_FILES });
    assert.equal(full.capped, false);
    assert.equal(full.files.length, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sha is stable for identical content and differs for changed content", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "a.ts"), "function one() {}\n");
    const first = scanRepo(root).files[0]!.sha;
    const second = scanRepo(root).files[0]!.sha;
    assert.equal(first, second);
    writeFileSync(join(root, "a.ts"), "function one() { return 1; }\n");
    const changed = scanRepo(root).files[0]!.sha;
    assert.notEqual(first, changed);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("summaries are deterministic and carry provenance (spec §6.3/§6.4)", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), [
      "/** Adds numbers. */",
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
    ].join("\n"));
    const file = scanRepo(root).files[0]!;
    const node = file.nodes[0]!;
    const s1 = summaryFor(node);
    const s2 = summaryFor(node);
    assert.equal(s1, s2);
    assert.match(s1, /^function add — src\/a\.ts:2-4 — /);
    assert.match(s1, /Adds numbers\./);
    const fsum = fileSummaryFor(file);
    assert.match(fsum ?? "", /^file src\/a\.ts — 1 definitions$/);
    assert.equal(fileSummaryFor({ ...file, nodes: [] }), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
