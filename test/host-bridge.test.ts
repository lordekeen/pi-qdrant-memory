/**
 * host-bridge tests — the guarded lazy imports behind the whole host surface.
 *
 * `loadHostModules` must resolve identically in both environments this suite
 * runs in: a plain-node checkout (neither optional peer resolves) and CI (npm
 * auto-installs the peers). The assertions therefore compare the bridge against
 * a direct `import()` of the same specifiers instead of hard-coding either
 * outcome. Each peer import is wrapped independently, so a missing (or broken)
 * package must never reject the returned promise — the renderer/settings screen
 * simply see that member as `undefined` and degrade.
 *
 * This file owns host-bridge; test/entry-render.test.ts exercises the bridge
 * only as the renderer's collaborator. The peerless failure path is covered
 * here by the environment itself (plain node), while a *partially* resolving
 * peer can only arrive from an older host install — the per-import guards make
 * that one package's members undefined regardless of the other's resolution.
 *
 * Scope note (#70): the other stub-shaped suites — test/command-run.test.ts,
 * test/index.test.ts and test/deps.test.ts — are WIRING tests (they assert
 * registration/routing through a fake WireApi/runtime) and stay out of this
 * one-file-per-module cleanup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { hostModules, loadHostModules, textComponentResolved } from "../src/host-bridge.ts";

/** A direct import of a peer package: the independent truth the bridge mirrors. */
async function importPeer(specifier: string): Promise<Record<string, unknown> | undefined> {
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

test("hostModules starts empty — nothing loads at import time", () => {
  // The bridge must not touch the peer packages at module load: under plain
  // node neither resolves, and an eager import would take the extension (and
  // every unit test) down with it.
  assert.deepEqual(hostModules(), {});
  assert.equal(textComponentResolved(), false);
});

test("loadHostModules shares one promise and never rejects, even with no peers", async () => {
  const first = loadHostModules();
  const second = loadHostModules();
  assert.equal(second, first, "repeated calls return the one in-flight load");
  await first; // must fulfill in BOTH environments (guarded imports)
  assert.equal(loadHostModules(), first, "the resolved load stays cached");
});

test("the resolved bundle is the same object consumers already hold", async () => {
  const bridge = hostModules();
  await loadHostModules();
  assert.equal(hostModules(), bridge, "resolution mutates in place — no re-import, no stale copy");
  assert.equal(textComponentResolved(), bridge.Text !== undefined);
});

test("every member mirrors the peer package that provides it", async () => {
  await loadHostModules();
  const tui = await importPeer("@earendil-works/pi-tui");
  const agent = await importPeer("@earendil-works/pi-coding-agent");
  const h = hostModules();
  // Present peer → the member IS the package's export; absent peer → undefined.
  // Either way the renderer degrades gracefully instead of throwing.
  assert.equal(h.Text, tui?.Text);
  assert.equal(h.SettingsList, tui?.SettingsList);
  assert.equal(h.Input, tui?.Input);
  assert.equal(h.keyHint, agent?.keyHint);
  assert.equal(h.DynamicBorder, agent?.DynamicBorder);
  assert.equal(h.getSettingsListTheme, agent?.getSettingsListTheme);
  assert.equal(h.keyText, agent?.keyText);
  assert.equal(textComponentResolved(), tui?.Text !== undefined);
  assert.equal(textComponentResolved(), h.Text !== undefined);
});
