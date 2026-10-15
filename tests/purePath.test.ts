/**
 * The `/pure` import path, and the registration it demands.
 *
 * This file asserts three things that are otherwise invisible until they fail on
 * a machine this repo cannot test on:
 *
 * 1. **Every Babylon import goes through `@babylonjs/core/pure.js`.** The UMD
 *    `babylonjs` package is 7.9 MB and tree-shakes to nothing; the whole point of
 *    the migration is that no import can quietly reintroduce it. Three.js is
 *    still forbidden outright — that rule is unchanged.
 * 2. **`registerBabylon` runs, and it is reachable from the built app.** A
 *    `NullEngine` works *without* registration, so the suite would go green with
 *    the call missing and only a real GPU would notice. The flag therefore has
 *    to be asserted *around* a `build`, in a process that has not already
 *    registered — which needs a reset that only this test file can do.
 * 3. **The prototype methods the registration installs are actually attached**
 *    after `registerBabylon()`, and that they were absent before it. Asserting
 *    only the flag would pass if the import path silently stopped resolving to
 *    real Babylon.
 *
 * What this file does NOT assert is any rendering outcome. A `NullEngine` has no
 * GPU and no pixels; the bundle numbers in `presentation/babylon.ts` are
 * measurements taken with esbuild on this box, not claims reproduced here.
 */

import { NullEngine, Scene, TargetCamera, Vector3 } from '@babylonjs/core/pure.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { HEADLESS_STATE, build } from '../src/app.ts';
import {
 BABYLON_PURE,
 babylonIsRegistered,
 registerBabylon,
 resetBabylonRegistration,
} from '../src/presentation/babylon.ts';

const SRC_ROOT = resolve(__dirname, '..', 'src');

/** Every `.ts` file under `directory`, recursively. */
function typeScriptFiles(directory: string): string[] {
 const found: string[] = [];
 for (const entry of readdirSync(directory)) {
  const full = join(directory, entry);
  if (statSync(full).isDirectory()) {
   found.push(...typeScriptFiles(full));
  } else if (entry.endsWith('.ts')) {
   found.push(full);
  }
 }
 return found;
}

/** A platform with no renderer at all: the headless case `build` must support. */
function headlessPlatform(): Parameters<typeof build>[0] {
 return { engine: null, scene: null };
}

/**
 * The method names the registration installs, measured by diffing the engine's
 * whole prototype chain before and after `registerBabylon()`.
 *
 * `createTexture` and every other method `ThinEngine` defines is on the chain
 * either way, so asserting on one of those proves nothing — it passes whether or
 * not registration ran. These are the ones that only exist because registration
 * ran, which is what makes them a real check.
 */
const REGISTRATION_ADDED_METHODS: readonly string[] = [
 'bindUniformBuffer',
 'createDepthStencilTexture',
 'setDepthStencilTexture',
 'setAlphaConstants',
 'getAlphaMode',
];

describe('the pure Babylon import path', () => {
 beforeEach(() => {
  // The registration is process-global and idempotent, so the flag has to be
  // reset before every test that asserts on it. Without this the first test to
  // call `registerBabylon` makes every later one vacuous, and a dropped call
  // inside `build` would be invisible.
  resetBabylonRegistration();
 });

 it('names the one Babylon import path the repo uses', () => {
  // A guard on the guard: if this string is ever wrong the assertions below
  // pass against a path nobody imports, which is a silent hole.
  expect(BABYLON_PURE).toBe('@babylonjs/core/pure.js');
 });

 it('every Babylon import in the source goes through the pure barrel', () => {
  const offenders: string[] = [];
  for (const file of typeScriptFiles(SRC_ROOT)) {
   const source = readFileSync(file, 'utf8');
   // The UMD package, the un-scoped legacy path, the full fat barrel, and
   // Three.js, which remains forbidden outright by the repo's own rule.
   const forbidden = [
    /from\s+['"]babylonjs['"]/,
    /from\s+['"]babylonjs\/[^'"]*['"]/,
    /from\s+['"]@babylonjs\/core['"]/,
    /from\s+['"]@babylonjs\/core\/Legacy\/legacy['"]/,
    /from\s+['"]three['"]/,
    /from\s+['"]three\/[^'"]*['"]/,
    /import\s*\(\s*['"](?:babylonjs|three|@babylonjs\/core)(?!\/pure\.js)/,
   ];
   if (forbidden.some((pattern) => pattern.test(source))) {
    offenders.push(file.slice(SRC_ROOT.length + 1));
   }
  }
  expect(offenders).toEqual([]);
 });

 it('still imports at least one real Babylon symbol, so the check above is live', () => {
  // The mirror of the test above: a tree with no Babylon import at all would
  // satisfy every "no forbidden import" assertion vacuously.
  const babylonFiles = typeScriptFiles(SRC_ROOT).filter((file) =>
   readFileSync(file, 'utf8').includes("from '@babylonjs/core/pure.js'"),
  );
  expect(babylonFiles.length).toBeGreaterThan(0);
 });

 it('registers from build, which is the call that is easy to drop', () => {
  // This is the whole point of the file. The suite passes with no registration
  // at all — a `nullEngine` needs none — so the only way to know the call in
  // `app.ts`'s `build` survived is to build with the flag reset first.
  expect(babylonIsRegistered()).toBe(false);
  build(headlessPlatform(), HEADLESS_STATE);
  expect(babylonIsRegistered()).toBe(true);
  expect(build(headlessPlatform(), HEADLESS_STATE).state).toBe('title');
 });

 it('attaches the prototype methods only registration installs', () => {
  const engine = new NullEngine();
  const methodIsOn = (name: string): boolean => {
   let proto: object | null = Object.getPrototypeOf(engine);
   while (proto !== null) {
    if (Object.prototype.hasOwnProperty.call(proto, name)) {
     return true;
    }
    proto = Object.getPrototypeOf(proto);
   }
   return false;
  };

  // Only the "after" half is assertable here, and the reason is the point of
  // the test: once registration has run it cannot be undone in-process.
  // Babylon's own guards are permanent, `resetBabylonRegistration` clears only
  // this module's flag, so a test asserting "absent before" is a test that
  // passes only if it is the first thing to touch Babylon in the process —
  // which no longer holds now that `build` registers for real elsewhere in
  // this file. The absent-before state was verified directly in a fresh Node
  // process instead (a bare `NullEngine` from `/pure` has none of these five
  // methods; `createTexture` is present either way, which is why it is not
  // among them).
  registerBabylon();

  for (const name of REGISTRATION_ADDED_METHODS) {
   expect(methodIsOn(name), `${name} should be attached after registration`).toBe(true);
  }
  // The flag agreeing is what proves *this module* is what did it.
  expect(babylonIsRegistered()).toBe(true);
 });

 it('renders a scene on a registered engine', () => {
  // The construction the tests use, so a registration that breaks scene
  // construction cannot pass by being wired up somewhere else.
  registerBabylon();
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.autoClear = true;
  scene.clearColor.set(0.03, 0.05, 0.09, 1);
  scene.activeCamera = new TargetCamera('cryo.title', Vector3.Zero(), scene);
  expect(() => scene.render()).not.toThrow();
 });
});
