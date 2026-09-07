import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export async function findGitRoot(startDir: string): Promise<string | null> {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function projectIdFromPath(absRoot: string): string {
  const real = existsSync(absRoot) ? realpathSync(absRoot) : absRoot;
  const hash = createHash("sha256").update(real).digest("hex");
  return `pi-mem-${hash.slice(0, 16)}`;
}

export async function projectIdFrom(startDir: string): Promise<string> {
  const root = await findGitRoot(startDir);
  return projectIdFromPath(root ?? startDir);
}
