/**
 * The camera stack's clear configuration, exercised under a null renderer.
 *
 * `NullEngine.clear()` is an empty function, so this file cannot see a pixel and
 * does not claim to. What it *can* assert — and what is the actual contract —
 * is the configuration that makes Babylon issue a colour clear at all:
 *
 * - `scene.autoClear` must be `true`. At `false` Babylon calls `engine.clear`
 *   with the colour flag off, which is a depth-only clear: the back buffer
 *   keeps whatever the last frame left in it.
 * - `scene.clearColor` must be the fog colour, the Rust's single `ClearColor`
 *   resource (`src/app.rs:119-123`).
 * - The clearing camera must be `activeCameras[0]`, because Babylon clears once
 *   per *scene* frame on the scene's first active camera.
 *
 * Each of those is one edit away from being silently wrong, and the symptom on
 * a real GPU is a screen that is never backgrounded. That is the defect this
 * file is written to fail on: the stack used to set `autoClear = false`, which
 * produced **0 of 307 200 non-zero pixels** against **307 200 of 307 200** with
 * the clear on, measured on a faithful replica of this repo's structure.
 */

import { Camera, Color4, NullEngine, Scene, type IColor4Like } from '@babylonjs/core/pure.js';
import { describe, expect, it } from 'vitest';

import {
 CAMERA_STACK_CONTRACT,
 CLEAR_COLOR,
 createExteriorCameras,
 createInteriorCameras,
 layerMasks,
} from '../src/presentation/cameraStack.ts';
import { FOG_COLOR_LINEAR } from '../src/presentation/fog.ts';

/** The two scenes `main.ts` builds, with nothing in them. */
function scenes(): { engine: NullEngine; exterior: Scene; interior: Scene } {
 const engine = new NullEngine();
 return { engine, exterior: new Scene(engine), interior: new Scene(engine) };
}

/** What `engine.clear` was called with, as a colour hex plus its three flags. */
interface ClearCall {
 readonly color: string | null;
 readonly colour: boolean;
 readonly depth: boolean;
 readonly stencil: boolean;
}

/**
 * A scene's `activeCameras`, which is `null` until something assigns to it.
 *
 * `Scene.activeCameras` is `Nullable<Camera[]>` because a scene may instead use
 * the singular `activeCamera`. Narrowing it here means every assertion below
 * reads a real array rather than a cast, and the error is a readable one if a
 * future refactor leaves the stack unset.
 */
function activeCamerasOf(scene: Scene): readonly Camera[] {
 const cameras = scene.activeCameras;
 if (cameras === null) {
  throw new Error('the scene has no activeCameras; the camera stack was never applied to it');
 }
 return cameras;
}

/**
 * Records every `engine.clear` a `scene.render()` issues.
 *
 * The instrumentation is the reason a `NullEngine` can verify a clear at all:
 * the engine's `clear` is normally a no-op, so it is replaced with a recorder.
 * That observes Babylon's own decision to clear, not the GPU's result of
 * clearing — the distinction this whole file is careful about.
 */
function recordClears(engine: NullEngine, scene: Scene): ClearCall[] {
 const calls: ClearCall[] = [];
 // The signature is the abstract engine's four-argument colour form. Babylon
 // passes the colour as `null` for a depth-only clear, and `false` for its
 // back-buffer flag — both of which are the `autoClear = false` bug.
 type ClearArgs = Parameters<NullEngine['clear']>;
 const inner: (...args: ClearArgs) => void = engine.clear.bind(engine);
 engine.clear = (color: IColor4Like, backBuffer: boolean, depth: boolean, stencil?: boolean): void => {
  calls.push({
   color: color instanceof Color4 ? color.toHexString() : null,
   colour: backBuffer,
   depth,
   stencil: stencil ?? false,
  });
  inner(color, backBuffer, depth, stencil);
 };
 scene.render();
 return calls;
}

describe('the camera stack clear configuration', () => {
 it('clears the exterior scene to the fog colour on its first camera', () => {
  const { engine, exterior } = scenes();
  const cameras = createExteriorCameras(exterior);

  expect(exterior.autoClear).toBe(true);
  expect(exterior.clearColor.toHexString()).toBe(CLEAR_COLOR.toHexString());

  // The title camera is first: it is the Rust `order: 0` camera that clears
  // the frame, so it is the one Babylon issues the clear for.
  const stack = activeCamerasOf(exterior);
  expect(stack[0]).toBe(cameras.title);
  expect(stack[1]).toBe(cameras.exterior);

  const calls = recordClears(engine, exterior);
  // Exactly one clear, and it is the colour one: a `false` colour flag is the
  // `autoClear = false` bug, which leaves the back buffer untouched.
  const colourClears = calls.filter((call) => call.colour);
  expect(colourClears).toHaveLength(1);
  expect(colourClears[0]?.color).toBe(CLEAR_COLOR.toHexString());
  expect(colourClears[0]?.depth).toBe(true);
  expect(colourClears[0]?.stencil).toBe(true);
 });

 it('clears the interior scene on its own camera, to the same colour', () => {
  const { engine, exterior, interior } = scenes();
  createExteriorCameras(exterior);
  const cameras = createInteriorCameras(interior, exterior);

  // The interior is a separate scene, so it needs a clear of its own. Without
  // one its rooms composite over whatever the last frame left behind.
  expect(interior.autoClear).toBe(true);
  expect(interior.clearColor.toHexString()).toBe(CLEAR_COLOR.toHexString());
  // One camera, and it is this one. Element-wise rather than a structural
  // comparison, because two cameras are the same when they are the same object
  // and no traversal of an engine can improve on that.
  const interiorStack = activeCamerasOf(interior);
  expect(interiorStack).toHaveLength(1);
  expect(interiorStack[0]).toBe(cameras.interior);

  const colourClears = recordClears(engine, interior).filter((call) => call.colour);
  expect(colourClears).toHaveLength(1);
  expect(colourClears[0]?.color).toBe(CLEAR_COLOR.toHexString());
 });

 it('puts the interior camera in the interior scene, where it can see the rooms', () => {
  const { engine, exterior, interior } = scenes();
  createExteriorCameras(exterior);
  const cameras = createInteriorCameras(interior, exterior);

  // A Babylon camera renders the scene it was constructed with. The interior
  // camera built into the *exterior* scene can see none of the interior's
  // rooms, which is how this repo's interior used to be wired — and the
  // interior scene had no camera at all, so `interior.render()` threw
  // `No camera defined` rather than drawing anything.
  expect(cameras.interior.getScene()).toBe(interior);
  expect(cameras.interior.getScene()).not.toBe(exterior);
  expect(activeCamerasOf(interior)).toHaveLength(1);

  // The interior scene renders, because it now has a camera. Before the fix
  // this line threw: a `Scene` with no camera is a `render()` that cannot run.
  expect(() => recordClears(engine, interior)).not.toThrow();
 });

 it('matches the Rust clear colour exactly', () => {
  // The Rust installs `ClearColor(FOG_COLOR)` at `src/app.rs:119-123`; the
  // port has one backdrop rather than two dark colours that look alike.
  expect(CLEAR_COLOR.r).toBeCloseTo(FOG_COLOR_LINEAR[0], 12);
  expect(CLEAR_COLOR.g).toBeCloseTo(FOG_COLOR_LINEAR[1], 12);
  expect(CLEAR_COLOR.b).toBeCloseTo(FOG_COLOR_LINEAR[2], 12);
  expect(CLEAR_COLOR.a).toBe(1);
 });

 it('gives every camera its own layer bit, as the Rust layers do', () => {
  const { exterior, interior } = scenes();
  const ext = createExteriorCameras(exterior);
  const int = createInteriorCameras(interior, exterior);
  const masks = layerMasks();

  // Three disjoint bits, one per camera, matching the Rust's three disjoint
  // render layers. A camera whose mask matches nothing draws nothing and
  // reports no error, which is the failure the uniqueness check guards.
  const used = [ext.title.layerMask, ext.exterior.layerMask, int.interior.layerMask];
  expect(new Set(used).size).toBe(3);
  expect(used).toEqual([masks.title, masks.exterior, masks.interior]);
 });

 it('throws when a camera is handed the wrong scene', () => {
  const { exterior } = scenes();
  // Passing the exterior scene as the interior scene puts the interior camera
  // where it can see nothing. It is a caller error with no symptom other than
  // a blank screen, so it is worth failing on rather than documenting.
  expect(() => createInteriorCameras(exterior, exterior)).toThrow(/interior scene/);
 });

 it('keeps the engine contract the Rust requires', () => {
  // MSAA off, one device pixel per CSS pixel. Untouched by the clear fix, and
  // asserted so a later change to either is caught here rather than on a GPU.
  expect(CAMERA_STACK_CONTRACT.antialias).toBe(false);
  expect(CAMERA_STACK_CONTRACT.adaptToDeviceRatio).toBe(false);
  expect(CAMERA_STACK_CONTRACT.autoClear).toBe(true);
 });
});
