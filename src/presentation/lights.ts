/**
 * The light sets, as plain data.
 *
 * A faithful port of both Rust light builds — `spawn_lights` from
 * `src/presentation/ship_scene.rs` for the exterior and the room lights from
 * `src/presentation/interior_scene.rs` for the interior — kept Babylon-free so
 * the numbers and the colour choices can be asserted without a renderer.
 *
 * The clearest way to ruin either scene is a light nobody noticed: a shadow map
 * nobody asked for, a point light a million times too bright, or a room whose
 * lamp falls off a circle in the middle of the floor. Each of those is a data
 * bug, so each is asserted here as data.
 */

import type { InteriorPlan, Room } from '../ship/interior.ts';

/** Illuminance of the exterior's single directional light, in lux. */
export const SUN_ILLUMINANCE = 1200;

/** Brightness of the exterior's ambient term. */
export const AMBIENT_BRIGHTNESS = 90;

/** Intensity of each engine beacon's point light, in lumens. */
export const BEACON_INTENSITY = 300_000;

/**
 * The exterior's light set: one directional and one ambient term.
 *
 * The dim star, low and to the side, plus an ambient that keeps the shadowed
 * side of the hull from going pure black. The two are set separately so they can
 * be tuned against each other.
 */
export const EXTERIOR_SUN: {
 /** The directional light's colour. */
 readonly color: readonly [number, number, number];
 /** Its illuminance, in lux. */
 readonly illuminance: number;
 /**
  * Where the light sits, which is the direction it shines *from*.
  *
  * Babylon's `DirectionalLight.direction` points the same way Bevy's transform
  * forward does, so this is `(6, 8, 4)` negated and normalised — the light at
  * +X/+Y/+Z looking at the origin shines back along -X-Y-Z onto the hull.
  */
 readonly direction: readonly [number, number, number];
 /**
  * The scene has exactly one castable light, and it casts nothing.
  *
  * A shadow map here would cost a full extra depth pass over the hull and the
  * ice, and the payoff — a soft blob under the landing pads — is not worth a
  * low-end GPU's frame budget.
  */
 readonly shadowsEnabled: false;
} = {
 color: [0.85, 0.88, 1],
 illuminance: SUN_ILLUMINANCE,
 direction: directionFrom([6, 8, 4]),
 shadowsEnabled: false,
};

/** The exterior's ambient term. */
export const EXTERIOR_AMBIENT: {
 /** Its colour. */
 readonly color: readonly [number, number, number];
 /** Its brightness. */
 readonly brightness: number;
} = {
 color: [0.55, 0.62, 0.78],
 brightness: AMBIENT_BRIGHTNESS,
};

/** Luminous power of each interior room's point light, in lumens. */
export const ROOM_LIGHT_LUMENS = 1500;

/** How high in each room its light hangs, in world units. */
export const ROOM_LIGHT_HEIGHT = 1.75;

/** The interior's ambient brightness, dimmer than the exterior's 90. */
export const INTERIOR_AMBIENT_BRIGHTNESS = 60;

/** How far past a room's own diagonal its light reaches, in world units. */
export const LIGHT_RANGE_MARGIN = 1;

/**
 * The colour of a room's light, by what the room is for.
 *
 * The coldest light in the ship is the instrument panel and the warmest is the
 * living space, which is the reading a player gets for free and the thing that
 * makes the rooms distinguishable in a scene with no textures.
 */
export function roomLightColor(kind: string): readonly [number, number, number] {
 switch (kind) {
  case 'Cockpit':
   return [0.55, 0.8, 1];
  case 'Cabin':
   return [1, 0.82, 0.55];
  case 'Corridor':
   return [0.85, 0.88, 0.95];
  case 'Engineering':
   return [1, 0.7, 0.4];
  default:
   // The boundary with vacuum: cold white.
   return [0.8, 0.88, 1];
 }
}

/** Where a room's light hangs: the room's centre, at `ROOM_LIGHT_HEIGHT`. */
export function roomCentre(room: Room): readonly [number, number, number] {
 const centre = (axis: 0 | 1 | 2): number =>
  ((room.min[axis] ?? 0) + (room.max[axis] ?? 0) + 1) * 0.5;
 // The y is not the room's own centre: the lamp hangs a quarter metre below a
 // two-metre ceiling, which is what a room's own ceiling light looks like.
 return [centre(0), ROOM_LIGHT_HEIGHT, centre(2)];
}

/**
 * How far a room's light reaches: its half-diagonal, plus a margin.
 *
 * The margin is what stops the falloff from reading as a circle of light in the
 * middle of the room, which is the one way a point light's hard range cut shows
 * itself.
 */
export function roomLightRange(room: Room): number {
 const x = roomExtentOf(room, 0);
 const y = roomExtentOf(room, 1);
 const z = roomExtentOf(room, 2);
 return 0.5 * Math.hypot(x, y, z) + LIGHT_RANGE_MARGIN;
}

/** One room's lamp, as data. */
export interface RoomLight {
 /** The room's own name. */
 readonly room: string;
 /** The room's kind, which decides the colour. */
 readonly kind: string;
 /** Where the lamp hangs, in world units. */
 readonly position: readonly [number, number, number];
 /** The lamp's colour. */
 readonly color: readonly [number, number, number];
 /** Its luminous power, in lumens. */
 readonly lumens: number;
 /** How far its light reaches, in world units. */
 readonly range: number;
}

/**
 * One lamp per room, in the plan's own order.
 *
 * There are no shadow maps anywhere in either scene, which is why the interior
 * can afford five of these: the only cost a shadow-free point light carries is
 * its own fragment work.
 */
export function roomLights(plan: InteriorPlan): readonly RoomLight[] {
 return plan.rooms.map((room) => ({
  room: room.name,
  kind: room.kind,
  position: roomCentre(room),
  color: roomLightColor(room.kind),
  lumens: ROOM_LIGHT_LUMENS,
  range: roomLightRange(room),
 }));
}

/** A room's extent along `axis`, in cells. */
function roomExtentOf(room: Room, axis: 0 | 1 | 2): number {
 return (room.max[axis] ?? 0) - (room.min[axis] ?? 0) + 1;
}

/** The unit vector from `point` toward the origin. */
function directionFrom(point: readonly [number, number, number]): readonly [number, number, number] {
 const [x, y, z] = point;
 const length = Math.hypot(x ?? 0, y ?? 0, z ?? 0);
 if (length === 0) {
  return [0, 0, 0];
 }
 return [-(x ?? 0) / length, -(y ?? 0) / length, -(z ?? 0) / length];
}
