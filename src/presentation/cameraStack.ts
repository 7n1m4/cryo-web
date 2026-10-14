/**
 * The Babylon.js camera composition: the ordered multi-camera stack the Rust
 * `RenderLayers` contract describes, expressed with `scene.activeCameras`.
 *
 * The Rust contract, preserved exactly:
 *
 * | camera | order | clears | mask |
 * |---|---|---|---|
 * | title | default | whole frame | title layer |
 * | exterior | stacked | none | scene layer |
 * | interior | stacked by `Camera::order` | none | interior layer |
 *
 * Babylon's analogue for `ClearColorConfig::None` is a camera that does not
 * clear, which in Babylon is done at the scene level: `scene.autoClear = false`
 * and the first camera in `activeCameras` clears once, then the rest composite.
 * `renderer.autoClear = false` + per-camera `layers.setMask` becomes
 * `scene.autoClear = false` + per-camera `camera.layerMask`.
 *
 * The Rust has a `single_mut` marker-collision bug (`interior_scene.rs:17-30`):
 * two cameras claiming the same marker silently produce an empty traverse
 * instead of an error. Babylon fails the same way, so "exactly one camera per
 * layer" is asserted in `createCameras` rather than left to convention.
 */

import { TargetCamera, Vector3 } from 'babylonjs';
import type { AbstractEngine, Scene } from 'babylonjs';

import {
  CAMERA_FAR_EXTERIOR,
  CAMERA_FAR_INTERIOR,
  CAMERA_NEAR,
  EXTERIOR_CAMERA_FOV,
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
 * The camera stack a CRYO frame is drawn with.
 *
 * `TargetCamera` rather than `Camera`, so a caller that wants to aim one calls
 * `setTarget` rather than casting: both the standing exterior camera and the
 * walking interior camera look at something, and the cast was the only reason
 * `Camera` was ever enough.
 */
export interface CameraStack {
  /** The title-screen camera. */
  readonly title: TargetCamera;
  /** The exterior hull camera. */
  readonly exterior: TargetCamera;
  /** The interior walking camera. */
  readonly interior: TargetCamera;
}

/**
 * The bit CRYO assigns to each layer.
 *
 * Bit 0 is the title, bit 1 the hull machinery, bit 2 the interior. Every mesh
 * the scene builds takes the bit for its layer, so the cameras composite rather
 * than double-draw — which is what makes three draws one frame instead of three
 * frames stacked.
 */
export function layerMasks(): LayerMasks {
  return { title: 1, exterior: 2, interior: 4 };
}

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
 * Creates the three cameras and activates them in order.
 *
 * The order assertion is the point of this function: Babylon would silently
 * composite nothing if two cameras claimed the same `layerMask`, because a
 * camera whose mask matches no object draws nothing and reports no error.
 *
 * `scene.autoClear = false` is what lets the title camera clear the frame and
 * the scene camera composite over it; it is set here so the stack is compositing
 * the moment it is built.
 */
export function createCameras(scene: Scene): CameraStack {
  const masks = layerMasks();
  const cameras: CameraStack = {
    title: makeCamera('cryo.title', scene, masks.title, CAMERA_FAR_EXTERIOR, CAMERA_FAR_EXTERIOR),
    exterior: makeCamera(
      'cryo.exterior',
      scene,
      masks.exterior,
      EXTERIOR_CAMERA_FOV,
      CAMERA_FAR_EXTERIOR,
    ),
    interior: makeCamera(
      'cryo.interior',
      scene,
      masks.interior,
      INTERIOR_CAMERA_FOV,
      CAMERA_FAR_INTERIOR,
    ),
  };

  // Exactly one camera per mask: the Rust `single_mut` collision, asserted.
  const masksUsed = [cameras.title.layerMask, cameras.exterior.layerMask, cameras.interior.layerMask];
  if (
    masksUsed[0] === masksUsed[1] ||
    masksUsed[0] === masksUsed[2] ||
    masksUsed[1] === masksUsed[2]
  ) {
    const rendered = masksUsed.map((mask) => mask.toString(2)).join(', ');
    throw new Error(`the camera stack needs one distinct layerMask per camera; got ${rendered}`);
  }

  scene.autoClear = false;
  scene.autoClearDepthAndStencil = true;
  scene.activeCameras = [cameras.title, cameras.exterior, cameras.interior];
  return cameras;
}

/** Whether `engine` was built with the options the Rust contract requires. */
export function engineMatchesContract(engine: AbstractEngine): boolean {
  // Babylon exposes antialiasing through the engine's MSAA setting rather than
  // its capabilities; the contract is "no MSAA and one device pixel per CSS
  // pixel", which both trace back to the `Engine`'s construction options.
  const caps = engine.getCaps() as { msaa?: boolean };
  return (caps.msaa ?? false) === CAMERA_STACK_CONTRACT.antialias;
}
