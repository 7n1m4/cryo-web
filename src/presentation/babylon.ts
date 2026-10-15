/**
 * The Babylon.js import path this port uses, and the registration it requires.
 *
 * ## Why `@babylonjs/core/pure` rather than `babylonjs`
 *
 * The `babylonjs` package is a UMD bundle: every import pulls all seven point
 * eight megabytes of it in, and a bundler cannot remove a line of it. The
 * `/pure` barrel of `@babylonjs/core` re-exports the same classes but with the
 * side-effectful registrations moved behind explicit `Register*()` calls, which
 * is what makes tree-shaking effective.
 *
 * Measured on this box (esbuild, `--bundle --format=esm --minify`, one entry
 * point importing exactly the thirteen symbols this repo imports):
 *
 * | entry | raw bytes | gzip bytes |
 * |---|---|---|
 * | `babylonjs@8.56.2` (UMD) | 7 877 845 | 1 655 368 |
 * | `@babylonjs/core@9.31.0` (barrel) | 7 223 909 | 1 597 816 |
 * | `@babylonjs/core@9.31.0/pure` | 1 878 539 | 442 253 |
 *
 * The `/pure` barrel is **3.5× smaller raw and 3.7× smaller compressed** than
 * the UMD bundle it replaces. The plain `@babylonjs/core` barrel wins nothing at
 * all — it is marginally *worse* — because it still carries every registration
 * side effect as a module that cannot be dropped. So the whole gain is in the
 * `/pure` split, not in the scoped-package rename a reader might assume.
 *
 * ## What registration costs and what it buys
 *
 * `RegisterStandardEngineExtensions()` installs the engine's prototype
 * augmentations: textures, file loading, alpha blending, render targets and
 * uniform buffers. Without it a real WebGL `Engine` has no `Texture` support and
 * a `Scene.render()` that reaches for one fails on a method that was never
 * attached.
 *
 * The important qualification, because it decides how carefully this must be
 * wired: **a `NullEngine` does not need it.** Under `NullEngine` this repo's
 * suite exercises scene construction, camera stacks, mesh uploads,
 * `PBRMaterial` properties and `Scene.render()` with no registration at all,
 * and all of it works. That is precisely why an untested registration call is a
 * hazard rather than a formality — the test suite would go green with it
 * missing, and only a real GPU would notice. It is therefore called once, from
 * the one module that owns engine construction, rather than left to the caller.
 *
 * The call is idempotent: Babylon guards every individual registration with a
 * flag and a second call does nothing. That makes it safe to call before any
 * `Engine` or `NullEngine` exists, which is what lets a test import this module
 * and get a registered engine without any setup of its own.
 */

import { RegisterStandardEngineExtensions } from '@babylonjs/core/pure.js';

/** The one import path the Babylon-using modules in this repo share. */
export const BABYLON_PURE = '@babylonjs/core/pure.js';

/**
 * Whether the registration this module performs has run.
 *
 * Babylon does not expose its own guard flags, so this is a record the module
 * keeps for itself rather than a state it reads back. A test asserting it is
 * `true` after `registerBabylon()` covers the wiring; the flag is not a
 * substitute for a real GPU having called a prototype method, and
 * `tests/purePath.test.ts` asserts the prototype methods too for that reason.
 */
let registered = false;

/**
 * Installs the Babylon engine extensions the port needs, exactly once.
 *
 * Called from `src/app.ts`'s `build`, so every entry point — `main.ts`'s canvas
 * run and the headless `build` the tests drive — gets a registered engine
 * without any of them knowing. `src/app.ts` is where the engine is handed in,
 * which is the only place that can promise the call happened before anything
 * built a scene on top of it.
 */
export function registerBabylon(): void {
 // Idempotent in Babylon; the flag here is what the test asserts on, so that
 // the "registration happened" claim is falsifiable rather than assumed.
 RegisterStandardEngineExtensions();
 registered = true;
}

/**
 * Whether `registerBabylon` has run, i.e. whether a registered engine exists.
 */
export function babylonIsRegistered(): boolean {
 return registered;
}

/**
 * Forgets that `registerBabylon` ran, so a test can observe a fresh process.
 *
 * This clears *this module's* flag only. Babylon's own guards are untouched, so
 * the prototype methods stay attached and `registerBabylon` re-does nothing —
 * which is exactly what makes it safe: a test asserting "absent before,
 * present after" sees the flag change while the engine wiring is genuinely
 * idempotent. It exists because registration is process-global and one-shot, and
 * without a reset the first test to call `registerBabylon` would make every
 * later assertion about it vacuous — including the one that matters, that
 * `app.ts`'s `build` still performs the call.
 */
export function resetBabylonRegistration(): void {
 registered = false;
}
