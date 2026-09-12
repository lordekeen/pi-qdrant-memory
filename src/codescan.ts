/**
 * Standalone structural code extractor (spec §6) — no external indexers, no
 * dependencies. Walks a repo root, extracts top-level definitions via
 * per-language line matchers, and renders deterministic single-file summaries
 * that feed the embedding pipeline. Heuristic by design: this is retrieval
 * material, not navigation data.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
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
  // Python virtual environments — un-dotted names are not caught by the
  // `entry.startsWith(".")` guard in listFilesRecursive.
  "venv", "env", "virtualenv",
  // Rust / C / other build artifacts commonly alongside `target`
  "__pycache__",
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
  /** When true, the scanRepo loop must confirm `=>` via resolveHeader. */
  needsArrowConfirm?: boolean;
}

/** Match one source line as a top-level definition for the language. */
function matchLine(language: "tsjs" | "python" | "fallback", line: string): LineMatch | undefined {
  // Leading whitespace incl. tabs — space-only counting made tab-indented
  // files look top-level (debugger finding 4).
  const indent = line.match(/^[\t ]*/)?.[0].length ?? 0;
  const t = line.trim();

  if (language === "tsjs") {
    let m = /^(export\s+)?(default\s+)?(abstract\s+)?(async\s+)?(function\*?\s+([A-Za-z_$][\w$]*))/.exec(t);
    if (m) return { kind: "function", name: m[6], indent };
    m = /^(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(t);
    if (m) return { kind: "class", name: m[4], indent };
    m = /^(export\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(t);
    if (m) return { kind: "interface", name: m[2], indent };
    // Optional <…> before `=` — generic aliases (`type Pair<T> = …`) otherwise
    // go unmatched (debugger finding 10).
    m = /^(export\s+)?type\s+([A-Za-z_$][\w$]*)(<[^=]*>)?\s*=/.exec(t);
    if (m) return { kind: "type", name: m[2], indent };
    // Arrow functions only: require `=>` after the paren group, else
    // `const ratio = (a + b) / 2;` is a false positive (debugger finding 11).
    m = /^(export\s+)?(const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(async\s*)?\([^)]*\)\s*(:[^=]+)?=>/.exec(t);
    if (m) return { kind: "function", name: m[3], indent };
    m = /^(export\s+)?(const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?[A-Za-z_$][\w$]*\s*=>/.exec(t);
    if (m) return { kind: "function", name: m[3], indent };
    // Multiline arrow: opening `(` without a close on the same line — the
    // resolveHeader scan will confirm `=>` on a subsequent line.
    m = /^(export\s+)?(const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(async\s*)?\(/.exec(t);
    if (m && !t.includes(")")) return { kind: "function", name: m[3], indent, needsArrowConfirm: true };
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
  // Go receiver methods: `func (r *Repo) Find(...)` — the generic matcher above
  // would name the receiver `r` (debugger finding 12).
  m = /^(export\s+)?(pub\s+)?func\s+\([^)]*\)\s*([A-Za-z_]\w*)/.exec(t);
  if (m) return { kind: "function", name: m[3], indent };
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

/** Upper bound on how many lines forward we scan for the header terminator. */
const MAX_HEADER_LINES = 20;

interface ResolvedHeader {
  /** 0-based index of the last header line (the line with `{`, `=>`, or `:`). */
  headerEndIdx: number;
  /** 0-based index of the first body line (headerEndIdx + 1). */
  bodyStartIdx: number;
  /** True if the declaration is an arrow function (found `=>`). */
  isArrow: boolean;
  /** The full concatenated + collapsed signature text. */
  signature: string;
}

/**
 * Starting from the definition line at `startIdx`, scan forward to find
 * the header terminator ({, =>, or : for Python). Returns the resolved
 * header metadata, or fallback if no terminator is found within bounds
 * (treated as single-line in that case).
 */
function resolveHeader(
  lines: string[],
  startIdx: number,
  language: "tsjs" | "python" | "fallback",
): ResolvedHeader {
  const limit = Math.min(lines.length, startIdx + MAX_HEADER_LINES);
  const sigParts: string[] = [];

  if (language === "python") {
    // Scan for the `:` that terminates the def/class header.
    for (let j = startIdx; j < limit; j++) {
      const t = lines[j]!;
      sigParts.push(t);
      // Python headers end with `:` (possibly followed by a comment).
      if (/:\s*(#.*)?$/.test(t.trimEnd())) {
        return {
          headerEndIdx: j,
          bodyStartIdx: j + 1,
          isArrow: false,
          signature: normalizeSignature(sigParts.join(" ")),
        };
      }
    }
    // Fallback: header is just the definition line.
    return {
      headerEndIdx: startIdx,
      bodyStartIdx: startIdx + 1,
      isArrow: false,
      signature: normalizeSignature(lines[startIdx]!),
    };
  }

  // tsjs / fallback: scan for `{` or `=>`.
  let isArrow = false;
  for (let j = startIdx; j < limit; j++) {
    const t = lines[j]!;
    sigParts.push(t);

    if (t.includes("=>")) {
      isArrow = true;
    }

    if (t.includes("{")) {
      return {
        headerEndIdx: j,
        bodyStartIdx: j + 1,
        isArrow,
        signature: normalizeSignature(sigParts.join(" ")),
      };
    }

    // A `;` at the definition indent or end of statement means a brace-less declaration
    // (type alias, arrow function with expression body, const without braces); stop scanning.
    if (t.trimEnd().endsWith(";")) {
      return {
        headerEndIdx: j,
        bodyStartIdx: j + 1,
        isArrow,
        signature: normalizeSignature(sigParts.join(" ")),
      };
    }
  }

  // No terminator found: treat as single-line.
  return {
    headerEndIdx: startIdx,
    bodyStartIdx: startIdx + 1,
    isArrow,
    signature: normalizeSignature(lines[startIdx]!),
  };
}

/** Leading contiguous doc comment directly above `defLine` (1-based), or docstring within body for Python. */
function docAbove(
  lines: string[],
  defLine: number,
  language: "tsjs" | "python" | "fallback",
  bodyStartIdx?: number,
): string {
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
    let j = bodyStartIdx ?? defLine; // 0-based idx of the first body line
    while (j < lines.length && lines[j]?.trim() === "") j++;
    const t = lines[j]?.trim() ?? "";
    for (const delim of ['"""', "'''"]) {
      if (t.startsWith(delim)) {
        // Empty docstring (`""""""` or `''''''`) is a complete statement, not an opener —
        // otherwise the forward scan swallows the rest of the file (debugger
        // finding 3). Forward scan is capped regardless.
        if (t === delim + delim) return "";
        if (t.length > 6 && t.endsWith(delim)) return collapse(t.slice(3, -3)).slice(0, MAX_DOC_CHARS);
        const block: string[] = [t.slice(3)];
        const stop = Math.min(lines.length, j + MAX_NODE_LINES);
        for (let k = j + 1; k < stop; k++) {
          const l = lines[k]?.trim() ?? "";
          if (l.endsWith(delim)) { if (l.length > 3) block.push(l.slice(0, -3)); break; }
          block.push(l);
        }
        return collapse(block.join(" ")).slice(0, MAX_DOC_CHARS);
      }
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
        // A bare closing line must be stripped before the star-prefix branch,
        // else it renders as a stray `/` in the doc (debugger finding 3).
        const stripped = t === "*/" ? ""
          : t.startsWith("/**") ? t.slice(3)
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

/** End line: closing brace at def indent (or EOF/200-line cap), or next
 * indent ≤ def (python). Indent counts tabs+spaces (debugger finding 4). */
function endLineFor(lines: string[], startIdx: number, defIndent: number, language: "tsjs" | "python" | "fallback"): number {
  const last = Math.min(lines.length, startIdx + 1 + MAX_NODE_LINES);
  const indentOf = (t: string): number => t.match(/^[\t ]*/)?.[0].length ?? 0;
  if (language === "python") {
    // End = last body line (1-based) before the first non-blank line at or
    // below the def's indent. Blank/comment lines inside the body don't end it.
    let lastContent = startIdx;
    for (let i = startIdx + 1; i < last; i++) {
      const t = lines[i];
      if (t.trim() === "" || t.trim().startsWith("#")) continue;
      if (indentOf(t) <= defIndent) break;
      lastContent = i;
    }
    return lastContent + 1;
  }
  // The closing brace must sit at the def's own indent — a nested bare `}`
  // (closing an inner if/try) must not terminate the node (debugger finding 1:
  // 73/161 nodes on this very repo had wrong ranges without the guard).
  for (let i = startIdx + 1; i < last; i++) {
    const t = lines[i];
    if (t.trim() === "") continue;
    if (indentOf(t) <= defIndent && (t.startsWith("}") || t.endsWith("}"))) return i + 1;
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

function listFilesRecursive(dir: string, maxFiles: number, skipDirs: ReadonlySet<string>, out: string[], capped: { value: boolean }): void {
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
      // lstat: symlinked directories are skipped outright — following them
      // loops on cycles and indexes files outside the root (debugger
      // finding 5: 41 duplicate entries from one self-referential link).
      st = lstatSync(full);
    } catch {
      continue; // vanished mid-scan
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (skipDirs.has(entry) || entry.startsWith(".")) continue;
      listFilesRecursive(full, maxFiles, skipDirs, out, capped);
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
  // Merged per-call skip set — the module-level SKIP_DIRS is never mutated,
  // so concurrent scans cannot leak skips into each other (debugger
  // finding 13).
  const skipDirs = options.extraSkips ? new Set([...SKIP_DIRS, ...options.extraSkips]) : SKIP_DIRS;
  listFilesRecursive(repoRoot, maxFiles, skipDirs, paths, capped);

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

      const header = resolveHeader(lines, i, language);

      // Arrow confirmation: if matchLine flagged this as needing =>
      // confirmation and resolveHeader didn't find it, skip this match.
      if (m.needsArrowConfirm && !header.isArrow) continue;

      const defLine = lines[i]!;

      // Single-line determination now uses the resolved header, not just
      // the first line: a brace on a subsequent header line is NOT single-line.
      let end: number;
      if (language === "python") {
        end = endLineFor(lines, header.headerEndIdx, m.indent, language);
      } else {
        // Brace-less (type alias, single-line const, arrow with expression body)
        // or self-closing (enum Color { Red }):
        // the header contains both `{` and `}`, or contains neither.
        const fullHeader = lines.slice(i, header.headerEndIdx + 1).join(" ");
        const singleLine = !fullHeader.includes("{") || fullHeader.includes("}");
        end = singleLine
          ? header.headerEndIdx + 1
          : endLineFor(lines, header.headerEndIdx, m.indent, language);
      }

      nodes.push({
        kind: m.kind,
        name: m.name,
        filePath: rel,
        startLine: i + 1,
        endLine: end,
        exported: isExported(defLine, language),
        doc: docAbove(lines, i + 1, language, header.bodyStartIdx),
        signature: header.signature,
      });

      // Skip past the resolved header lines so they aren't re-matched.
      if (header.headerEndIdx > i) i = header.headerEndIdx;
    }
    files.push({ filePath: rel, sha: sha256(content), nodes });
  }
  return { files, capped: capped.value };
}

function isExported(defLine: string, language: "tsjs" | "python" | "fallback"): boolean {
  if (language === "tsjs") return /(^|\s)export(\s|$)/.test(defLine.trim());
  if (language === "python") return !/^(async\s+)?(def|class)\s+_/.test(defLine.trim());
  return /(^|\s)(export|pub)(\s|$)/.test(defLine.trim());
}
