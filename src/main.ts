/**
 * The browser entry point.
 *
 * `index.html` loads this, and this is the only file that touches a canvas. It
 * does four things and nothing else: take the canvas, build a Babylon engine and
 * scene with the options the Rust contract requires, compose the camera stack,
 * upload the hull mesh, and run the frame loop.
 *
 * It is deliberately not covered by tests: it needs a canvas, and a headless run
 * of it proves nothing. What proves it is honest is that it calls the same
 * functions the headless harness does not — `createCameras` and
 * `uploadHullGeometry` — which are typed and typed strictly.
 */

import { Color3, Engine, Mesh, Scene, Vector3 } from 'babylonjs';

import { build } from './app.ts';
import { createCameras, engineOptions } from './presentation/cameraStack.ts';
import { hullLength, uploadHullGeometry } from './presentation/hullUpload.ts';
import { FOG_COLOR_LINEAR, fogBand } from './presentation/constants.ts';

/** The canvas this entry point owns. */
function findCanvas(): HTMLCanvasElement {
  const canvas = document.getElementById('cryo-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('index.html must provide <canvas id="cryo-canvas">');
  }
  return canvas;
}

/**
 * Builds the scene and starts the render loop.
 *
 * Returns the engine so a console can dispose it, which is the only cleanup a
 * page navigation does not do for us.
 */
export function start(): Engine {
  const canvas = findCanvas();
  const options = engineOptions();
  const engine = new Engine(canvas, options.antialias, {
    preserveDrawingBuffer: false,
    stencil: true,
  });
  // One device pixel per CSS pixel: Babylon's `adaptToDeviceRatio` at the
  // engine level is what the Rust's `PixelRatio(1)` asks for, and a hardware
  // scaling level of 1 is "no scaling", which is what `adaptToDeviceRatio:
  // false` already gives. Setting it explicitly is a guard, not a correction.
  if (!options.adaptToDeviceRatio) {
    engine.setHardwareScalingLevel(1);
  }

  const scene = new Scene(engine);
  const cameras = createCameras(scene);

  const app = build({ engine, scene }, { seed: 0n });

  // The hull geometry, uploaded once. The mesh is owned by the scene and
  // disposed with it.
  const hullMesh = new Mesh('cryo.hull', scene);
  const error = uploadHullGeometry(hullMesh, app.hullMesh);
  if (error !== null) {
    // The typed mesh failure, caught at the render boundary exactly as the
    // AGENTS contract requires — a hull too large for a `u16` index is refused
    // here rather than silently widening the index type.
    throw new Error(error.kind);
  }
  hullMesh.layerMask = 1 << 1;

  // The exterior fog, and only the exterior: the interior camera sees through
  // a separate fog setting because the interior is 36 metres and a fog tuned to
  // a 5-metre hull would eat it.
  const fog = fogBand(hullLength(app.hullMesh));
  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogStart = fog[0];
  scene.fogEnd = fog[1];
  scene.fogColor = new Color3(
    FOG_COLOR_LINEAR[0],
    FOG_COLOR_LINEAR[1],
    FOG_COLOR_LINEAR[2],
  );

  cameras.exterior.position = new Vector3(0, 1.5, 5);
  cameras.exterior.setTarget(Vector3.Zero());
  cameras.interior.position = new Vector3(0, 0.65, 2.5);
  cameras.interior.setTarget(new Vector3(0, 0.65, 4));

  engine.runRenderLoop(() => {
    scene.render();
  });

  window.addEventListener('resize', () => {
    engine.resize();
  });

  return engine;
}

if (typeof document !== 'undefined') {
  start();
}
