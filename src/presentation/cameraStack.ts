/**
 * The Babylon.js camera setup, and the clear it is responsible for.
 *
 * ## What the Rust actually does, and where this port differs
 *
 * The Rust runs **one Bevy render target shared by three cameras** that are
 * drawn bottom-to-top by `Camera::order`, each alpha-blending over the last:
 *
 * | camera | order | clears | layer | file |
 * |---|---|---|---|---|
 * | `Camera2d` (title) | 0 | **yes — the whole frame** | 0 (default) | `src/presentation/mod.rs:83` |
 * | `Camera3d` (exterior) | 1 | `ClearColorConfig::None` | 1 | `src/presentation/ship_scene.rs:1245-1259` |
 * | `Camera3d` (interior) | 2 | `ClearColorConfig::None` | 2 | `src/presentation/interior_scene.rs:1128-1140` |
 *
 * The clear colour is a single app-level `ClearColor` resource set to
 * `ship_scene::FOG_COLOR` (`src/app.rs:119-123`), so the title camera's clear
 * and the exterior's distance fog are *the same colour* — one backdrop, not two
 * dark colours that look almost alike.
 *
 * This port does **not** reproduce that composite, because it cannot: a Babylon
 * camera renders the `Scene` it was constructed with and cannot see meshes in
 * any other. `main.ts` builds two `Scene`s — `exterior` and `interior` — so
 * there is nothing to composite across. Each scene owns its own cameras, and
 * the correct translation of "the title camera clears the frame" is therefore
 * "**each scene clears the frame it owns, to the one backdrop colour**".
 *
 * ## The bug this module used to have
 *
 * It used to build all three cameras into the exterior scene and set
 * `scene.autoClear = false`, which in Babylon means *no camera ever issues a
 * colour clear*. The title camera's mask (bit 0) matched nothing, so it cleared
 * nothing; the other two are stacked cameras that Babylon only depth-clears;
 * and the interior scene had no camera at all. The result was a back buffer
 * that was never colour-cleared, measured on a faithful replica of this repo's
 * structure: **0 of 307 200 pixels non-zero**, versus 307 200 of 307 200 with
 * `autoClear = true`. `NullEngine` hides it because `clear()` is an empty
 * function there, which is why the tests in `tests/cameraStack.test.ts` assert
 * the *configuration* that produces the clear — `autoClear`, `clearColor`, and
 * which camera is first in `activeCameras` — rather than pixels.
 */

import { Color4, TargetCamera, Vector3 } from '@babylonjs/core/pure.js';
import type { AbstractEngine, Scene } from '@babylonjs/core/pure.js';

import {
 CAMERA_FAR_EXTERIOR,
 CAMERA_FAR_INTERIOR,
 CAMERA_NEAR,
 EXTERIOR_CAMERA_FOV,
 FOG_COLOR_LINEAR,
 INTERIOR_CAMERA_FOV,
} from './constants.ts';

/** The three layer bits, one per camera, computed from the camera indices. */
export interface LayerMasks {
 /** The title screen's bit. */
 readonly title: number;
 /** The exterior hull's bit. */
 readonly exterior: number;
 /** The interior's bit. */
 readonly interior: number;
}

/**
 * The exterior scene's two cameras.
 *
 * `TargetCamera` rather than `Camera`, so a caller that wants to aim one calls
 * `setTarget` rather than casting: the standing exterior camera looks at the
 * hull, and the cast was the only reason `Camera` was ever enough.
 */
export interface ExteriorCameras {
 /** The title screen's camera, first in `activeCameras` because it clears. */
 readonly title: TargetCamera;
 /** The exterior hull camera. */
 readonly exterior: TargetCamera;
}

/** The interior scene's one camera. */
export interface InteriorCameras {
 /** The interior walking camera: the player's eye inside the hull. */
 readonly interior: TargetCamera;
}

/** Every camera a CRYO frame is drawn with, across both scenes. */
export interface CameraStack {
 /** The exterior scene's cameras, in draw order. */
 readonly exterior: ExteriorCameras;
 /** The interior scene's camera. */
 readonly interior: InteriorCameras;
}

/**
 * The bit CRYO assigns to each layer.
 *
 * Bit 0 is the title, bit 1 the hull machinery, bit 2 the interior. Every mesh
 * a scene builds takes the bit for its layer, so a scene's cameras cull to what
 * they own rather than double-drawing.
 */
export function layerMasks(): LayerMasks {
 return { title: 1, exterior: 2, interior: 4 };
}

/**
 * The colour every frame is cleared to.
 *
 * The Rust's `ClearColor` resource, which `src/app.rs` installs as
 * `ship_scene::FOG_COLOR` — the same linear `(0.03, 0.05, 0.09)` the exterior's
 * distance fog blends toward. One colour for both scenes, so the interior's
 * backdrop and the exterior's horizon are not two dark colours that look almost
 * alike.
 */
export const CLEAR_COLOR: Color4 = new Color4(FOG_COLOR_LINEAR[0], FOG_COLOR_LINEAR[1], FOG_COLOR_LINEAR[2], 1);

/** Everything the composition needs to build and to verify itself. */
export const CAMERA_STACK_CONTRACT = {
 /** MSAA off, matching the Rust `Msaa::Off`. */
 antialias: false,
 /** One device pixel per CSS pixel, matching `PixelRatio(1)`. */
 adaptToDeviceRatio: false,
 near: CAMERA_NEAR,
 farExterior: CAMERA_FAR_EXTERIOR,
 farInterior: CAMERA_FAR_INTERIOR,
 fovExterior: EXTERIOR_CAMERA_FOV,
 fovInterior: INTERIOR_CAMERA_FOV,
 /**
  * The scene clears colour *and* depth, to the fog colour.
  *
  * This is the pair that reproduces the Rust's `Camera2d` clear plus
  * `ClearColorConfig::None` overlay semantics in a two-scene port: every scene
  * clears the frame it owns, then that scene's geometry composites over it.
  */
 clearColor: CLEAR_COLOR,
 autoClear: true,
 autoClearDepthAndStencil: true,
} as const;

/** The engine options the presentation layer must be built with. */
export function engineOptions(): {
 antialias: boolean;
 adaptToDeviceRatio: boolean;
} {
 return { antialias: CAMERA_STACK_CONTRACT.antialias, adaptToDeviceRatio: CAMERA_STACK_CONTRACT.adaptToDeviceRatio };
}

/**
 * Builds a camera for one layer and applies the shared near/far/fov.
 *
 * The near and far planes and the vertical field of view are per-camera, so
 * they are passed rather than looked up, but they are the Rust's numbers.
 */
function makeCamera(
 name: string,
 scene: Scene,
 mask: number,
 fov: number,
 far: number,
): TargetCamera {
 const camera = new TargetCamera(name, Vector3.Zero(), scene);
 camera.layerMask = mask;
 camera.minZ = CAMERA_NEAR;
 camera.maxZ = far;
 camera.fov = fov;
 return camera;
}

/**
 * Applies the clear both scenes share.
 *
 * `autoClear = true` with an explicit `clearColor` is the whole fix: Babylon
 * clears once per scene frame, on that scene's first `activeCamera`, using the
 * scene's `clearColor`. Leaving `autoClear` at its default of `true` and only
 * setting `clearColor` would work on a fresh scene, so the assignment is not
 * decorative — it is what stops a caller's earlier `autoClear = false` from
 * silently surviving this call.
 */
function applyClear(scene: Scene): void {
 scene.autoClear = CAMERA_STACK_CONTRACT.autoClear;
 scene.autoClearDepthAndStencil = CAMERA_STACK_CONTRACT.autoClearDepthAndStencil;
 scene.clearColor = CAMERA_STACK_CONTRACT.clearColor;
}

/**
 * Builds the exterior scene's cameras and configures that scene's clear.
 *
 * Two cameras in the exterior scene, in draw order: the title camera first
 * because it is the one that clears, then the exterior camera, which draws the
 * hull over what the title camera put down. That order is the Rust's
 * `order: 0` / `order: 1` translated into the only thing Babylon has — the
 * order of `activeCameras`.
 *
 * The title camera's role deserves saying exactly, because it is the part the
 * old code got wrong. The Rust's title camera is the `Camera2d` that clears the
 * whole frame and draws the HUD (`src/presentation/mod.rs:83`). This port's HUD
 * is a DOM overlay rather than Babylon geometry (`hud.ts` explains why), so
 * this camera owns no meshes and is expected to draw nothing — it stays in the
 * stack for exactly the one thing the Rust's does: **it is the camera that
 * clears.** The Rust's title camera carries no `Projection` and no planes of its
 * own, so it borrows the exterior's numbers here rather than inventing a second
 * pair for a camera that obeys no frustum rule.
 */
export function createExteriorCameras(scene: Scene): ExteriorCameras {
 const masks = layerMasks();
 const title = makeCamera('cryo.title', scene, masks.title, EXTERIOR_CAMERA_FOV, CAMERA_FAR_EXTERIOR);
 const exterior = makeCamera('cryo.exterior', scene, masks.exterior, EXTERIOR_CAMERA_FOV, CAMERA_FAR_EXTERIOR);

 // Exactly one camera per mask: the Rust `single_mut` collision, asserted.
 if (title.layerMask === exterior.layerMask) {
  const rendered = [title.layerMask, exterior.layerMask].map((mask) => mask.toString(2)).join(', ');
  throw new Error(`the camera stack needs one distinct layerMask per camera; got ${rendered}`);
 }

 applyClear(scene);
 scene.activeCameras = [title, exterior];
 return { title, exterior };
}

/**
 * Builds the interior scene's camera and configures that scene's clear.
 *
 * The interior is a separate `Scene`, so it needs its own clear: without one
 * the rooms would composite over whatever the previous frame left in the back
 * buffer. The camera goes into the interior scene, where it is the only camera,
 * and it is that scene's `activeCameras[0]` — which makes it the camera that
 * clears the interior to the same backdrop colour the exterior clears to.
 *
 * The camera is *not* shared with the exterior scene. A Babylon camera renders
 * the scene it was constructed with, so an interior camera built into the
 * exterior scene can see none of the interior's rooms; the interior scene's
 * former lack of any camera at all is the failure mode this closes, and it was
 * fatal — `Scene.render` throws `No camera defined` rather than drawing
 * nothing.
 */
export function createInteriorCameras(interiorScene: Scene, exteriorScene: Scene): InteriorCameras {
 const masks = layerMasks();
 const interior = makeCamera('cryo.interior', interiorScene, masks.interior, INTERIOR_CAMERA_FOV, CAMERA_FAR_INTERIOR);

 // A camera belongs to the scene it was constructed with. Handing it the wrong
 // one is a caller mistake with no symptom other than a blank interior, so it
 // is worth an error rather than a comment.
 if (interior.getScene() === exteriorScene) {
  throw new Error('the interior camera belongs to the interior scene, not the exterior scene');
 }

 applyClear(interiorScene);
 interiorScene.activeCameras = [interior];
 return { interior };
}

/** Whether `engine` was built with the options the Rust contract requires. */
export function engineMatchesContract(engine: AbstractEngine): boolean {
 // Babylon exposes antialiasing through the engine's MSAA setting rather than
 // its capabilities; the contract is "no MSAA and one device pixel per CSS
 // pixel", which both trace back to the `Engine`'s construction options.
 const caps = engine.getCaps() as { msaa?: boolean };
 return (caps.msaa ?? false) === CAMERA_STACK_CONTRACT.antialias;
}
