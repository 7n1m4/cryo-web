/**
 * The browser entry point.
 *
 * `index.html` loads this, and this is the only file that touches a canvas. It
 * takes the canvas, builds a Babylon engine and scene with the options the Rust
 * contract requires, composes the camera stack, uploads the hull mesh, and runs
 * the frame loop — and it owns the whole exterior orbit and the whole interior
 * walker, both of which are pure arithmetic elsewhere in this layer.
 *
 * It is deliberately not covered by tests: it needs a canvas, and a headless run
 * of it proves nothing. What proves it honest is that it calls the same pure
 * functions the headless tests do — `orbitFromPlan`, `stepPlayer`,
 * `orbitDragged` — which are typed strictly and asserted against the Rust.
 *
 * The state machine is *not* here. `app.build` owns the game flow; this file
 * reads it and applies the two presentation-driven transitions it is allowed to
 * make: the orbit reaching the boarding station boards the hull, and the walker
 * standing in the airlock's hatch cell leaves it. Nothing else moves the state,
 * and nothing here advances the simulation, because the simulation's clock is
 * the app's and a second clock reading a `performance.now()` in this file would
 * be a second source of truth for time.
 */

import { Color3, Color4, DirectionalLight, Engine, Mesh, MeshBuilder, PBRMaterial, PointLight, Scene, Vector3 } from 'babylonjs';

import { build } from './app.ts';
import { createCameras, engineOptions, type CameraStack } from './presentation/cameraStack.ts';
import { uploadHullGeometry } from './presentation/hullUpload.ts';
import { setHudText } from './presentation/hud.ts';
import { OPENING_HULL_CONFIG } from './presentation/frameMath.ts';
import {
 orbitDragged,
 orbitFromPlan,
 orbitPosition,
 orbitZoomed,
 type ShipOrbit,
} from './presentation/orbit.ts';
import {
 LOOK_RADIANS_PER_PIXEL,
 MAX_PITCH,
 PLAYER_SPAWN,
 boardingStation,
 eyePosition,
 lookDirection,
 playerCell,
 spawnPlayer,
 stepPlayer,
 type HeldKeys,
 type PlayerBody,
} from './presentation/player.ts';
import { EXTERIOR_AMBIENT, EXTERIOR_SUN, roomLights } from './presentation/lights.ts';
import { InputTracker } from './presentation/inputTypes.ts';
import { buildExtras } from './presentation/extras.ts';
import { exteriorFog, INTERIOR_MESHES_ARE_FOG_EXEMPT } from './presentation/fog.ts';
import { HullPlan, meshHull, meshErrorMessage } from './ship/voxel.ts';
import { crashedShip, walkableWalls } from './ship/interior.ts';
import type { SceneViews } from './game/sceneView.ts';

/** The hull the game opens with, as a plan: the shipped ship's own framing. */
const HULL_PLAN: HullPlan = HullPlan.generate(OPENING_HULL_CONFIG);

/** The interior the hull is boarded from, as the Rust's own plan. */
const INTERIOR_PLAN = crashedShip();

/**
 * The interior's wall planes, derived once from that plan: the ship layer's own
 * `walkable_walls` (interior_scene.rs:772-778), which is the same list the
 * meshes are rendered from, so the collision and the geometry cannot disagree
 * about where a doorway is. Derived here rather than per frame because the plan
 * never changes, and per frame would be 38 boxes a frame for nothing.
 */
const WALKABLE_WALLS = walkableWalls(INTERIOR_PLAN);

/** How far a pointer may drag before it is a look rather than a click. */
const DRAG_THRESHOLD_PIXELS = 4;

/** The pixels a wheel's one line of scroll reports. */
const SCROLL_PIXELS_PER_LINE = 100;

/** The canvas this entry point owns. */
function findCanvas(): HTMLCanvasElement {
 const canvas = document.getElementById('cryo-canvas');
 if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('index.html must provide <canvas id="cryo-canvas">');
 }
 return canvas;
}

/**
 * The keyboard set the interior walker consumes, as the held-key snapshot it
 * takes. Kept as one function so a caller cannot accidentally feed it edges.
 */
function heldKeysFrom(held: readonly string[]): HeldKeys {
 return {
  forward: held.includes('KeyW') || held.includes('ArrowUp'),
  back: held.includes('KeyS') || held.includes('ArrowDown'),
  left: held.includes('KeyA') || held.includes('ArrowLeft'),
  right: held.includes('KeyD') || held.includes('ArrowRight'),
  sprint: held.includes('ShiftLeft') || held.includes('ShiftRight'),
 };
}

/** Normalises a wheel event to lines, the unit the orbit's zoom takes. */
function toLines(event: WheelEvent): number {
 // A line-mode wheel already reports lines; a page-mode one reports pages; a
 // pixel-mode one is the common case on a trackpad and needs the divisor Bevy's
 // own default supplies.
 switch (event.deltaMode) {
  case 1:
   return event.deltaY;
  case 2:
   return event.deltaY * 40;
  default:
   return event.deltaY / SCROLL_PIXELS_PER_LINE;
 }
}

/**
 * The scenes and everything the frame loop touches.
 *
 * Both cameras are shared by both scenes, because the camera stack is one stack:
 * the title camera draws the HUD and the DOM, and the two scene cameras draw
 * over it in order. What changes with the state is which camera is *active*, and
 * that is the game layer's flow, not a second scene.
 */
interface Presentation {
 /** The orbit the exterior camera flies. */
 readonly orbit: ShipOrbit;
 /** Where the orbit must come to board, or null when the plan has no hatch. */
 readonly boardingStation: { readonly x: number; readonly y: number; readonly z: number } | null;
 /** The interior player's body, which the frame loop reassigns. */
 player: PlayerBody;
 /** The view's heading, in radians. */
 yaw: number;
 /** The view's tilt, in radians. */
 pitch: number;
 /** The keys held, as this file maintains from real DOM events. */
 readonly held: Set<string>;
 /** The pointer's last position, or null when the pointer is not dragging. */
 dragFrom: { readonly x: number; readonly y: number } | null;
 /** The edges and held keys the game layer's own systems consume. */
 readonly input: InputTracker;
}

/** Builds both scenes and starts the render loop. */
export function start(): Engine {
 const canvas = findCanvas();
 const options = engineOptions();
 const engine = new Engine(canvas, options.antialias, {
  preserveDrawingBuffer: true,
  stencil: true,
 });
 // One device pixel per CSS pixel: Babylon's `adaptToDeviceRatio` at the engine
 // level is what the Rust's `PixelRatio(1)` asks for, and a hardware scaling
 // level of 1 is "no scaling", which is what `adaptToDeviceRatio: false`
 // already gives. Setting it explicitly is a guard, not a correction.
 if (!options.adaptToDeviceRatio) {
  engine.setHardwareScalingLevel(1);
 }

 // The hull's resting orbit, read from the framing rather than re-derived. The
 // presentation state is built before the app because the app reads the two
 // scene views, and both views close over this object.
 const presentation: Presentation = {
  orbit: orbitFromPlan(HULL_PLAN),
  boardingStation: boardingStation(INTERIOR_PLAN, orbitFromPlan(HULL_PLAN), HULL_PLAN),
  player: spawnPlayer({ x: PLAYER_SPAWN[0], y: PLAYER_SPAWN[1], z: PLAYER_SPAWN[2] }),
  yaw: 0,
  pitch: 0,
  held: new Set<string>(),
  dragFrom: null,
  input: new InputTracker(),
 };

 // The two scene views the game layer reads, so a null-renderer test can drive
 // boarding and console selection without this module ever constructing one.
 // Both are closures over `presentation`, which is why the state exists first.
 const views: SceneViews = {
  exterior: {
   getCameraPosition: (): readonly [number, number, number] => {
    const at = orbitPosition(presentation.orbit);
    return [at.x, at.y, at.z];
   },
   // `null` when the plan has no hatch: the game layer's own answer for
   // "boarding is unavailable", which is the Rust's early return on `None`.
   getBoardingStation: (): readonly [number, number, number] | null => {
    const station = presentation.boardingStation;
    return station === null ? null : [station.x, station.y, station.z];
   },
  },
  interior: {
   getPlayerCell: (): readonly [number, number, number] => {
    const cell = playerCell(presentation.player.position);
    return [cell[0] ?? 0, cell[1] ?? 0, cell[2] ?? 0];
   },
   getPlayerForward: (): readonly [number, number, number] => {
    const forward = lookDirection(presentation.yaw, presentation.pitch);
    return [forward.x, forward.y, forward.z];
   },
  },
 };

 // The exterior scene and its hull.
 const exterior = new Scene(engine);
 const cameras: CameraStack = createCameras(exterior);
 // The views are the seam the game layer reads to run its own decisions: which
 // cell the interior body is in, which way it faces, where the exterior orbit
 // camera stands and where the hatch's own boarding station is. They are built
 // here because only this module knows the Babylon-side state they close over,
 // and they are passed in rather than held back, so the boarding and airlock
 // verdicts this file's frame loop reads are the game layer's and not its own.
 const app = build({ engine, scene: exterior }, { seed: 0n }, views);

 // The app's flow drives which screen the player is on; this file only reads it
 // and applies the consequences.

 const hullMesh = new Mesh('cryo.hull', exterior);
 const error = uploadHullGeometry(hullMesh, meshHull(HULL_PLAN));
 if (error !== null) {
  // The hull is the scene. Without it there is a camera looking at ice, so
  // this is the one failure worth stopping for — and the mesher's `u16`
  // ceiling is the only way a hull refuses to build.
  throw new Error(`the hull did not mesh: ${meshErrorMessage(error)}`);
 }
 hullMesh.layerMask = 1 << 1;

 // The hull's material is lit only: white base, no emissive, and rough enough
 // not to be a mirror. The vertex colours carry the livery.
 const hullMaterial = new PBRMaterial('cryo.hull.material', exterior);
 hullMaterial.albedoColor.set(1, 1, 1);
 hullMaterial.roughness = 0.55;
 hullMaterial.emissiveColor.set(0, 0, 0);
 hullMesh.material = hullMaterial;

 // The exterior fog, and only the exterior: the interior camera sees through a
 // separate fog setting because the interior is 36 metres and a fog tuned to a
 // 5-metre hull would eat it.
 const fog = exteriorFog(HULL_PLAN);
 exterior.fogMode = Scene.FOGMODE_LINEAR;
 exterior.fogStart = fog.start;
 exterior.fogEnd = fog.end;
 exterior.fogColor = new Color3(fog.color[0], fog.color[1], fog.color[2]);

 // The dim star, low and to the side. Its direction is `looking_at` semantics
 // inverted, so the sun sits at +X/+Y/+Z and shines back along -X-Y-Z onto the
 // hull. It casts nothing: there are no shadow maps in either scene.
 const sun = new DirectionalLight('cryo.sun', new Vector3(
  EXTERIOR_SUN.direction[0],
  EXTERIOR_SUN.direction[1],
  EXTERIOR_SUN.direction[2],
 ), exterior);
 sun.diffuse.set(EXTERIOR_SUN.color[0], EXTERIOR_SUN.color[1], EXTERIOR_SUN.color[2]);
 sun.intensity = EXTERIOR_SUN.illuminance;
 sun.shadowEnabled = EXTERIOR_SUN.shadowsEnabled;

 // The scene's ambient term, which keeps the shadowed side of the hull from
 // going pure black. Babylon's ambient is a colour rather than Bevy's
 // brightness, so the two are folded together here rather than in a data
 // module — this is the one place the unit conversion happens.
 exterior.ambientColor = new Color3(
  EXTERIOR_AMBIENT.color[0] * (EXTERIOR_AMBIENT.brightness / 255),
  EXTERIOR_AMBIENT.color[1] * (EXTERIOR_AMBIENT.brightness / 255),
  EXTERIOR_AMBIENT.color[2] * (EXTERIOR_AMBIENT.brightness / 255),
 );

 // The details: the canopy, the engine glows and the landing pads.
 buildExtras(exterior, HULL_PLAN, 'cryo');

 // The interior scene, and its rooms' own lamps.
 const interior = new Scene(engine);
 interior.fogMode = Scene.FOGMODE_NONE;
 interior.clearColor = new Color4(0, 0, 0, 1);
 for (const light of roomLights(INTERIOR_PLAN)) {
  const lamp = new PointLight(`cryo.room.${light.room}`, Vector3.Zero(), interior);
  lamp.position.set(light.position[0], light.position[1], light.position[2]);
  lamp.diffuse.set(light.color[0], light.color[1], light.color[2]);
  lamp.intensity = light.lumens;
  lamp.range = light.range;
  // Every light in both scenes is shadow-free, which is why the interior can
  // afford one per room: a shadow-free point light carries no extra pass.
  lamp.shadowEnabled = false;
 }

 // The interior's own geometry: one box per room, which is what the ship
 // layer's `rooms` table describes and what the walker collides against.
 for (const room of INTERIOR_PLAN.rooms) {
  const box = MeshBuilder.CreateBox(`cryo.room.${room.name}`, {
   width: room.max[0] - room.min[0] + 1,
   height: room.max[1] - room.min[1] + 1,
   depth: room.max[2] - room.min[2] + 1,
  }, interior);
  box.position.set(
   (room.min[0] + room.max[0] + 1) / 2,
   (room.min[1] + room.max[1] + 1) / 2,
   (room.min[2] + room.max[2] + 1) / 2,
  );
  // The rooms are the only thing the interior camera can see, so they carry
  // its layer bit.
  box.layerMask = 1 << 2;
  // The exemption the fog module exists for.
  box.applyFog = !INTERIOR_MESHES_ARE_FOG_EXEMPT;
  const material = new PBRMaterial(`cryo.room.${room.name}.material`, interior);
  material.albedoColor.set(0.2, 0.22, 0.26);
  material.roughness = 0.7;
  material.emissiveColor.set(0, 0, 0);
  box.material = material;
 }

 canvas.addEventListener('pointerdown', (event: PointerEvent) => {
  presentation.dragFrom = { x: event.clientX, y: event.clientY };
 });

 window.addEventListener('pointerup', () => {
  presentation.dragFrom = null;
 });

 window.addEventListener('pointermove', (event: PointerEvent) => {
  const from = presentation.dragFrom;
  if (from === null) {
   return;
  }
  const delta = { x: event.clientX - from.x, y: event.clientY - from.y };
  if (Math.abs(delta.x) < DRAG_THRESHOLD_PIXELS && Math.abs(delta.y) < DRAG_THRESHOLD_PIXELS) {
   return;
  }
  presentation.dragFrom = { x: event.clientX, y: event.clientY };

  // The screen a drag addresses is the game layer's verdict read at the moment
  // of the gesture, not a second state machine of this file's: a drag during the
  // interior looks, and anywhere else it orbits.
  if (app.flow.state === 'interior') {
   // The interior's look: the pitch is clamped short of vertical, so the view
   // is recoverable with the gesture that got it there.
   presentation.yaw -= delta.x * LOOK_RADIANS_PER_PIXEL;
   presentation.pitch = Math.min(
    Math.max(presentation.pitch - delta.y * LOOK_RADIANS_PER_PIXEL, -MAX_PITCH),
    MAX_PITCH,
   );
  } else {
   // The exterior's orbit. The clamps live in the pure functions, so the
   // event handler only has to say what happened.
   const dragged = orbitDragged(presentation.orbit, { x: -delta.x, y: delta.y });
   Object.assign(presentation.orbit, dragged);
  }
 });

 window.addEventListener('wheel', (event: WheelEvent) => {
  if (app.flow.state !== 'exterior') {
   return;
  }
  Object.assign(presentation.orbit, orbitZoomed(presentation.orbit, toLines(event)));
 }, { passive: true });

 window.addEventListener('keydown', (event: KeyboardEvent) => {
  // The tracker owns the edges and the held set: `press` on a key already down
  // is an OS repeat and is dropped, which is what keeps one press one action.
  presentation.input.press(event.code);
  presentation.held.add(event.code);
 });

 window.addEventListener('keyup', (event: KeyboardEvent) => {
  presentation.input.release(event.code);
  presentation.held.delete(event.code);
 });

 engine.runRenderLoop(() => {
  const dt = engine.getDeltaTime() / 1000;

  // The frame: the game layer's own systems run, and only then does this file
  // read the state they arrived at. This is Bevy's order — `Update` runs the
  // state's systems, `StateTransition` applies the `NextState` they wrote — and
  // it is why the boarding and airlock verdicts are the game layer's: this file
  // supplies the input and the scenes, and receives a state.
  //
  // `dt` is handed to the walker rather than to the game layer, whose advance
  // is a fixed step per frame; see `app.ts`'s `handleFrame`.
  app.handleFrame(presentation.input.state());
  const state = app.flow.state;

  if (state === 'exterior') {
   const at = orbitPosition(presentation.orbit);
   cameras.exterior.position.set(at.x, at.y, at.z);
   const target = presentation.orbit.target;
   cameras.exterior.setTarget(new Vector3(target.x, target.y, target.z));
  } else if (state === 'interior') {
   // One frame of the walker: the pure function, with the held keys and the
   // look this file accumulated. `walk_player` and `frame_camera` are the Rust's
   // own presentation systems, and a paused frame holds the body still because
   // the pause system stops the systems rather than the clock alone.
   if (state === 'interior') {
    presentation.player = stepPlayer(
     { walls: WALKABLE_WALLS },
     presentation.player,
     heldKeysFrom([...presentation.held]),
     { x: 0, y: 0 },
     dt,
    );
    presentation.yaw = presentation.player.yaw;
    presentation.pitch = presentation.player.pitch;
   }

   const eye = eyePosition(presentation.player.position);
   cameras.interior.position.set(eye.x, eye.y, eye.z);
   const forward = lookDirection(presentation.yaw, presentation.pitch);
   cameras.interior.setTarget(new Vector3(
    eye.x + forward.x,
    eye.y + forward.y,
    eye.z + forward.z,
   ));
  }

  // The edges are this frame's only: a key held for a second must not board the
  // hull sixty times.
  presentation.input.endFrame();

  setHudText(app.hudText());

  interior.render();
  exterior.render();
 });

 window.addEventListener('resize', () => {
  engine.resize();
 });

 return engine;
}

if (typeof document !== 'undefined') {
 start();
}
