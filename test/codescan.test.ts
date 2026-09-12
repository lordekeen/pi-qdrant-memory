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

test("endLine does not bleed past brace-less and single-line declarations", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), [
      "export interface Shape {",
      "  area(): number;",
      "}",
      "",
      "export type Pair = [number, number];",
      "",
      "export enum Color { Red }",
      "",
      "export const twice = (n: number) => n * 2;",
      "",
      "export function tail() {",
      "  if (true) {",
      "    while (false) {",
      "      const nested = 1; // nested bare braces must not end the function",
      "    }",
      "  }",
      "}",
    ].join("\n"));
    const { files } = scanRepo(root);
    const byName = new Map(files[0]!.nodes.map((n) => [n.name, n]));
    assert.equal(byName.get("Shape")!.endLine, 3);
    assert.equal(byName.get("Pair")!.endLine, 5); // was 16 (bled to next decl)
    assert.equal(byName.get("Color")!.endLine, 7);
    assert.equal(byName.get("twice")!.endLine, 9);
    // Nested bare `}` must not terminate the function early
    const tail = byName.get("tail")!;
    assert.equal(tail.endLine, 17);
    // Generic type alias is matched
    assert.ok(byName.has("Pair"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("doc capture handles multi-line JSDoc and empty python docstrings", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), [
      "/**",
      " * Adds numbers.",
      " * Second line.",
      " */",
      "export function add(a: number): number {",
      "  return a;",
      "}",
    ].join("\n"));
    writeFileSync(join(root, "empty.py"), [
      "def f():",
      '    """"""',
      "    return 1",
      "",
      "def g():",
      "    return 2",
    ].join("\n"));
    const { files } = scanRepo(root);
    const ts = files.find((f) => f.filePath === "src/a.ts")!;
    assert.equal(ts.nodes[0]!.doc, "Adds numbers. Second line.");
    const py = files.find((f) => f.filePath === "empty.py")!;
    const byName = new Map(py.nodes.map((n) => [n.name, n]));
    assert.equal(byName.get("f")!.doc, "");
    assert.equal(byName.get("g")!.endLine, 6);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tab-indented files are not misread as top-level", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "tabs.ts"), [
      "export function outer() {",
      "\tfunction helper() {",
      "\t\treturn 1;",
      "\t}",
      "}",
    ].join("\n"));
    const { files } = scanRepo(root);
    assert.equal(files[0]!.nodes.length, 1);
    assert.equal(files[0]!.nodes[0]!.name, "outer");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scanRepo skips Python venv directories", () => {
  const root = fixture();
  try {
    // Standard un-dotted venv with a .py file inside
    mkdirSync(join(root, "venv", "lib", "site-packages", "pkg"), { recursive: true });
    writeFileSync(join(root, "venv", "lib", "site-packages", "pkg", "mod.py"),
      "def vendored(): pass\n");

    // Same for "env"
    mkdirSync(join(root, "env", "lib"), { recursive: true });
    writeFileSync(join(root, "env", "lib", "x.py"), "def also_vendored(): pass\n");

    // Same for "virtualenv"
    mkdirSync(join(root, "virtualenv", "lib"), { recursive: true });
    writeFileSync(join(root, "virtualenv", "lib", "v.py"), "def virt(): pass\n");

    // Same for "__pycache__"
    mkdirSync(join(root, "__pycache__"), { recursive: true });
    writeFileSync(join(root, "__pycache__", "mod.cpython-311.py"), "def pyc(): pass\n");

    // The actual project source
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.py"), "def main(): pass\n");

    const { files } = scanRepo(root);
    assert.deepEqual(files.map((f) => f.filePath), ["src/app.py"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scanRepo handles opening brace on subsequent line (Allman style)", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "allman.ts"), [
      "export function add(",
      "  a: number,",
      "  b: number",
      "): number {",
      "  return a + b;",
      "}",
      "",
      "export class Service",
      "{",
      "  doWork() {}",
      "}",
    ].join("\n"));
    const { files } = scanRepo(root);
    const byName = new Map(files[0]!.nodes.map((n) => [n.name, n]));

    const add = byName.get("add")!;
    assert.equal(add.startLine, 1);
    assert.equal(add.endLine, 6);
    assert.ok(add.signature.includes("add("));

    const svc = byName.get("Service")!;
    assert.equal(svc.startLine, 8);
    assert.equal(svc.endLine, 11);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scanRepo detects multiline arrow function declarations", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "arrows.ts"), [
      "export const processData = (",
      "  items: string[]",
      "): number => {",
      "  return items.length;",
      "};",
    ].join("\n"));
    const { files } = scanRepo(root);
    const byName = new Map(files[0]!.nodes.map((n) => [n.name, n]));

    const proc = byName.get("processData")!;
    assert.equal(proc.kind, "function");
    assert.equal(proc.startLine, 1);
    assert.ok(proc.endLine >= 5);
    assert.ok(proc.signature.includes("processData"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scanRepo handles multiline Python signatures and single-quote docstrings", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "multi.py"), [
      "def calculate(",
      "    x: int,",
      "    y: int",
      ") -> int:",
      '    """Calculates the sum."""',
      "    return x + y",
      "",
      "def other(",
      "    a: str",
      "):",
      "    '''Single-quote doc.'''",
      "    pass",
    ].join("\n"));
    const { files } = scanRepo(root);
    const byName = new Map(files[0]!.nodes.map((n) => [n.name, n]));

    const calc = byName.get("calculate")!;
    assert.equal(calc.startLine, 1);
    assert.equal(calc.endLine, 6);  // includes the body
    assert.equal(calc.doc, "Calculates the sum.");
    assert.ok(calc.signature.includes("calculate("));

    const other = byName.get("other")!;
    assert.equal(other.doc, "Single-quote doc.");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scanRepo rejects multiline non-arrow assignments with parentheses", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "nonarrow.ts"), [
      "const total = (",
      "  1 + 2",
      ");",
    ].join("\n"));
    const { files } = scanRepo(root);
    assert.equal(files[0]!.nodes.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


