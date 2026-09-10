/**
 * Standalone structural code extractor (spec §6) — no external indexers, no
 * dependencies. Walks a repo root, extracts top-level definitions via
 * per-language line matchers, and renders deterministic single-file summaries
 * that feed the embedding pipeline. Heuristic by design: this is retrieval
 * material, not navigation data.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Hard limits (spec §6.1) — protect the embed budget and the event loop. */
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_FILES = 2_000;
const MAX_NODE_LINES = 200;
const MAX_DOC_CHARS = 400;
const MAX_SIGNATURE_CHARS = 200;

export type CodeKind =
  | "function" | "class" | "interface" | "type" | "enum" | "method"
  | "struct" | "trait" | "impl" | "module";

export interface CodeNode {
  kind: CodeKind;
  name: string;
  filePath: string; // repo-relative, posix separators
  startLine: number; // 1-based
  endLine: number;
  exported: boolean;
  doc: string; // collapsed leading doc comment, "" when absent
  signature: string; // the def line, normalized
}

export interface ScannedFile {
  filePath: string;
  sha: string; // sha256 of full file content
  nodes: CodeNode[]; // definition nodes (excludes the file point itself)
}

export interface ScanResult {
  files: ScannedFile[];
  /** Files skipped because the MAX_FILES cap was hit (reported, never silent). */
  capped: boolean;
}

interface SkipOptions {
  /** Extra directory names to skip (e.g. the agent's own test fixtures). */
  extraSkips?: string[];
  /** Override of the file-count cap for tests. */
  maxFiles?: number;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", "vendor", ".next", "target",
]);

/** language -> extensions. First matching language wins (order matters). */
const LANGUAGES: Array<{ language: "tsjs" | "python" | "fallback"; extensions: string[] }> = [
  { language: "tsjs", extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] },
  { language: "python", extensions: [".py"] },
  { language: "fallback", extensions: [".go", ".rs", ".java", ".kt", ".cs", ".rb", ".php", ".zig"] },
];

function languageFor(filePath: string): "tsjs" | "python" | "fallback" | undefined {
  const lower = filePath.toLowerCase();
  for (const lang of LANGUAGES) {
    if (lang.extensions.some((e) => lower.endsWith(e))) return lang.language;
  }
  return undefined;
}

interface LineMatch {
  kind: CodeKind;
  name: string;
  indent: number;
}

/** Match one source line as a top-level definition for the language. */
function matchLine(language: "tsjs" | "python" | "fallback", line: string): LineMatch | undefined {
  const trimmedStart = line.length - line.trimStart().length;
  const indent = line.match(/^ */)?.[0].length ?? trimmedStart;
  const t = line.trim();

  if (language === "tsjs") {
    let m = /^(export\s+)?(default\s+)?(abstract\s+)?(async\s+)?(function\*?\s+([A-Za-z_$][\w$]*))/.exec(t);
    if (m) return { kind: "function", name: m[6], indent };
    m = /^(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(t);
    if (m) return { kind: "class", name: m[4], indent };
    m = /^(export\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(t);
    if (m) return { kind: "interface", name: m[2], indent };
    m = /^(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/.exec(t);
    if (m) return { kind: "type", name: m[2], indent };
    m = /^(export\s+)?(const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(async\s*)?\(/.exec(t);
    if (m) return { kind: "function", name: m[3], indent };
    m = /^(export\s+)?enum\s+([A-Za-z_$][\w$]*)/.exec(t);
    if (m) return { kind: "enum", name: m[2], indent };
    return undefined;
  }

  if (language === "python") {
    let m = /^(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(t);
    if (m) return { kind: "function", name: m[2], indent };
    m = /^class\s+([A-Za-z_]\w*)/.exec(t);
    if (m) return { kind: "class", name: m[1], indent };
    return undefined;
  }

  // fallback
  let m = /^(export\s+)?(pub\s+)?(async\s+)?(fn|func|function)\s+\(?\s*([A-Za-z_][\w.]*)/.exec(t);
  if (m) return { kind: "function", name: m[5], indent };
  // Go idiom: `type Name struct {` / `type Name interface {` — must win over the
  // plain `type` alias matcher below.
  m = /^(export\s+)?(pub\s+)?type\s+([A-Za-z_]\w*)\s+(struct|interface)/.exec(t);
  if (m) return { kind: m[4] === "struct" ? "struct" : "interface", name: m[3], indent };
  m = /^(export\s+)?(pub\s+)?(class|struct|trait|interface)\s+([A-Za-z_]\w*)/.exec(t);
  if (m) return { kind: m[3] === "struct" ? "struct" : m[3] === "trait" ? "trait" : m[3] === "interface" ? "interface" : "class", name: m[4], indent };
  m = /^(export\s+)?(pub\s+)?impl\s+([A-Za-z_][\w:]*)/.exec(t);
  if (m) return { kind: "impl", name: m[3], indent };
  m = /^(export\s+)?(pub\s+)?type\s+([A-Za-z_]\w*)/.exec(t);
  if (m) return { kind: "type", name: m[3], indent };
  return undefined;
}

/** Collapse internal whitespace — the summary text must be deterministic. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Leading contiguous doc comment directly above `defLine` (1-based). */
function docAbove(lines: string[], defLine: number, language: "tsjs" | "python" | "fallback"): string {
  const collected: string[] = [];
  let i = defLine - 2; // line index above the def
  if (language === "python") {
    // `#` runs above the def…
    for (; i >= 0; i--) {
      const t = lines[i]?.trim() ?? "";
      if (t.startsWith("#") && !t.startsWith("#!")) collected.unshift(t.replace(/^#\s?/, ""));
      else if (t !== "") break;
    }
    if (collected.length) return collapse(collected.join(" ")).slice(0, MAX_DOC_CHARS);
    // …otherwise the docstring is the first statement of the body.
    let j = defLine; // 0-based idx of the first body line (defLine is 1-based)
    while (j < lines.length && lines[j]?.trim() === "") j++;
    const t = lines[j]?.trim() ?? "";
    if (t.startsWith('"""')) {
      if (t.length > 6 && t.endsWith('"""')) return collapse(t.slice(3, -3)).slice(0, MAX_DOC_CHARS);
      const block: string[] = [t.slice(3)];
      for (let k = j + 1; k < lines.length; k++) {
        const l = lines[k]?.trim() ?? "";
        if (l.endsWith('"""')) { if (l.length > 3) block.push(l.slice(0, -3)); break; }
        block.push(l);
      }
      return collapse(block.join(" ")).slice(0, MAX_DOC_CHARS);
    }
    return "";
  }

  // brace languages: `/** … */` (accepted) or `//` runs (accepted)
  const t0 = lines[i]?.trim() ?? "";
  if (t0.endsWith("*/")) {
    const block: string[] = [];
    if (t0.startsWith("/**") && t0.length > 4) {
      block.unshift(t0.slice(3, -2));
    } else {
      for (;;) {
        const t = lines[i]?.trim() ?? "";
        const stripped = t.startsWith("/**") ? t.slice(3)
          : t.startsWith("/*") ? t.slice(2)
          : t.startsWith("*") ? t.slice(1)
          : t;
        block.unshift(stripped.replace(/\*\/$/, "").trim());
        if (t.startsWith("/**") || t.startsWith("/*") || i === 0) break;
        i--;
      }
    }
    return collapse(block.join(" ")).slice(0, MAX_DOC_CHARS);
  }
  for (; i >= 0; i--) {
    const t = lines[i]?.trim() ?? "";
    if (t.startsWith("//")) collected.unshift(t.replace(/^\/\/\s?/, ""));
    else break;
  }
  return collapse(collected.join(" ")).slice(0, MAX_DOC_CHARS);
}

/** End line: matching closing brace at def indent, or next indent ≤ def (python). */
function endLineFor(lines: string[], startIdx: number, defIndent: number, language: "tsjs" | "python" | "fallback"): number {
  const last = Math.min(lines.length, startIdx + 1 + MAX_NODE_LINES);
  if (language === "python") {
    // End = last body line (1-based) before the first non-blank line at or
    // below the def's indent. Blank/comment lines inside the body don't end it.
    let lastContent = startIdx;
    for (let i = startIdx + 1; i < last; i++) {
      const t = lines[i];
      if (t.trim() === "" || t.trim().startsWith("#")) continue;
      if ((t.match(/^ */)?.[0].length ?? 0) <= defIndent) break;
      lastContent = i;
    }
    return lastContent + 1;
  }
  for (let i = startIdx + 1; i < last; i++) {
    const t = lines[i];
    if (t.trim() === "") continue;
    if ((t.match(/^ */)?.[0].length ?? 0) <= defIndent && (t.startsWith("}") || t.endsWith("}"))) return i + 1;
    if (t.trim() === "}") return i + 1;
  }
  return last;
}

function normalizeSignature(line: string): string {
  let s = collapse(line);
  s = s.replace(/[{:]\s*$/, "").trim();
  return s.length > MAX_SIGNATURE_CHARS ? s.slice(0, MAX_SIGNATURE_CHARS) : s;
}

/** Deterministic summary text for one node (spec §6.3). */
export function summaryFor(node: CodeNode): string {
  const doc = node.doc ? `\n${node.doc}` : "";
  return `${node.kind} ${node.name} — ${node.filePath}:${node.startLine}-${node.endLine} — ${node.signature}${doc}`;
}

/** Deterministic file-level summary (spec §6.4); undefined when the file has no defs. */
export function fileSummaryFor(file: ScannedFile): string | undefined {
  if (!file.nodes.length) return undefined;
  return `file ${file.filePath} — ${file.nodes.length} definitions`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function listFilesRecursive(root: string, dir: string, maxFiles: number, out: string[], capped: { value: boolean }): void {
  if (out.length >= maxFiles) { capped.value = true; return; }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // unreadable dir: skip silently, scan the rest
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) { capped.value = true; return; }
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // vanished mid-scan
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
      listFilesRecursive(root, full, maxFiles, out, capped);
    } else if (st.isFile()) {
      if (st.size > MAX_FILE_BYTES) continue;
      if (languageFor(entry) === undefined) continue;
      out.push(full);
    }
  }
}

/**
 * Scan `repoRoot` for structural definitions. Never throws on unreadable
 * files/dirs — they are skipped. File-count overflow is reported via
 * `result.capped` (and a console.error at the sync layer), never silently
 * swallowed.
 */
export function scanRepo(repoRoot: string, options: SkipOptions = {}): ScanResult {
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const paths: string[] = [];
  const capped = { value: false };
  const skips = options.extraSkips ? new Set([...SKIP_DIRS, ...options.extraSkips]) : SKIP_DIRS;
  const saved = SKIP_DIRS; // listFilesRecursive uses the module set; extend via wrapper below
  void saved;
  if (options.extraSkips) {
    for (const s of options.extraSkips) SKIP_DIRS.add(s);
  }
  try {
    listFilesRecursive(repoRoot, repoRoot, maxFiles, paths, capped);
  } finally {
    if (options.extraSkips) {
      for (const s of options.extraSkips) SKIP_DIRS.delete(s);
    }
  }
  void skips;

  const files: ScannedFile[] = [];
  for (const abs of paths) {
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const rel = relative(repoRoot, abs).split(sep).join("/");
    const language = languageFor(rel);
    if (!language) continue;
    const lines = content.split("\n");
    const nodes: CodeNode[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = matchLine(language, lines[i]!);
      if (!m || m.indent !== 0) continue;
      const end = endLineFor(lines, i, m.indent, language);
      nodes.push({
        kind: m.kind,
        name: m.name,
        filePath: rel,
        startLine: i + 1,
        endLine: end,
        exported: isExported(lines[i]!, language),
        doc: docAbove(lines, i + 1, language),
        signature: normalizeSignature(lines[i]!),
      });
    }
    files.push({ filePath: rel, sha: sha256(content), nodes });
  }
  return { files, capped: capped.value };
}

function isExported(defLine: string, language: "tsjs" | "python" | "fallback"): boolean {
  if (language === "tsjs") return /(^|\s)export(\s|$)/.test(defLine.trim());
  if (language === "python") return !/^(def|class)\s+_/.test(defLine.trim());
  return /(^|\s)(export|pub)(\s|$)/.test(defLine.trim());
}
