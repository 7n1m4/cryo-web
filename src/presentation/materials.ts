/**
 * What the exterior scene is made of, as plain data.
 *
 * A faithful port of the material and extras decisions in the Rust
 * `src/presentation/ship_scene.rs` — `spawn_ship`'s hull material and
 * `spawn_extra_meshes`' per-detail materials — kept Babylon-free so the
 * decisions themselves can be asserted without a renderer.
 *
 * The split matters. What the Rust decides here is *not* geometry: it is which
 * meshes are translucent, which glow, how glossy the hull is, and where the
 * beacons sit. Those are the things a re-implementation would get wrong in a
 * dozen small ways, and none of them need a `StandardMaterial` to check.
 *
 * The Babylon-facing half lives in `extras.ts` and reads these tables; the
 * tables are the port, the reader is the wiring.
 */

import type { ExtraMeshKind, HullPlan } from '../ship/voxel.ts';
import { ExtraMeshKind as Kind } from '../ship/voxel.ts';
import type { ModelFrame, Vec3Like } from './frameMath.ts';
import { transformPoint } from './frameMath.ts';

/**
 * The hull's material: lit only, and deliberately not shiny.
 *
 * `baseColor` stays white so both the directional light and the vertex colours
 * the mesher baked in shade the hull's faces, and the emissive term is nothing
 * at all. An emissive term here would multiply every fragment by the fog colour
 * and turn the amber beacons the palette already puts on the hull into ordinary
 * paint.
 */
export interface HullMaterialSpec {
 /** White: the vertex colours carry the livery, not the material. */
 readonly baseColor: readonly [number, number, number, number];
 /** Nothing: an emissive hull is a flat hull. */
 readonly emissive: readonly [number, number, number, number];
 /**
  * How rough the hull's surface is.
  *
  * Pushed up because polished metal on a battered hull would give a mirror, and
  * a mirror doubles the work the specular pass does for no visual gain at this
  * scale.
  */
 readonly perceptualRoughness: number;
 /** The hull is opaque. */
 readonly translucent: boolean;
}

/** The hull's material, exactly as the Rust builds it. */
export const HULL_MATERIAL: HullMaterialSpec = {
 baseColor: [1, 1, 1, 1],
 emissive: [0, 0, 0, 0],
 perceptualRoughness: 0.55,
 translucent: false,
};

/**
 * The canopy glazing's opacity, as a fraction.
 *
 * Glazing is the one translucent thing in the exterior: it reads as glass,
 * which is what says "cockpit" without a window frame. The voxel module's
 * palette already carries the alpha, so the material inherits it — this
 * constant is the number the palette entry for the glazing carries, quoted here
 * so a test can state it rather than trust the table.
 */
export const GLAZING_ALPHA = 0.45;

/** How much the engine glow's emissive term is scaled up per channel. */
export const ENGINE_GLOW_EMISSIVE_SCALE: readonly [number, number, number] = [2, 1.4, 0.6];

/** How far an engine beacon's light reaches, in world units. */
export const BEACON_RANGE = 6.0;

/**
 * How soft a beacon's light edge is.
 *
 * Zero is a hard-edged falloff, which on a small hull reads as a crisp circle of
 * light on the ice rather than as a smeared one.
 */
export const BEACON_RADIUS = 0;

/** The emissive term for a detail's tint, by what the detail is *for*. */
export function emissiveFor(kind: ExtraMeshKind, rgb: readonly [number, number, number]): readonly [number, number, number, number] {
 // Engine glow is emissive; the others are not. This is a judgement call about
 // what each mesh is for, not a lookup: the voxel module hands over a tint, and
 // the scene decides that tint should glow in the engine's case.
 if (kind === Kind.EngineGlow) {
  const [x, y, z] = ENGINE_GLOW_EMISSIVE_SCALE;
  return [(rgb[0] ?? 0) * (x ?? 1), (rgb[1] ?? 0) * (y ?? 1), (rgb[2] ?? 0) * (z ?? 1), 1];
 }
 return [0, 0, 0, 0];
}

/** One detail's box, in world space, as the model transform places it. */
export interface ExtraPlacement {
 /** The detail's centre, in world units. */
 readonly center: Vec3Like;
 /** The detail's full size, in world units. */
 readonly size: Vec3Like;
 /** The model's own rotation, which the box inherits and the position does not. */
 readonly rotation: { readonly pitch: number; readonly bank: number };
}

/**
 * Places every detail of a hull, in world space.
 *
 * The extra's `center` is in ship-local *voxel* units, and it has to land
 * wherever the hull's transform put that voxel. Applying the model's own
 * transform — rotation, then scale, then translation, which is exactly what
 * `transformPoint` does — is the same rule the hull's vertices go through, so
 * the glazing cannot drift off the canopy it belongs to no matter how the ship
 * is banked.
 *
 * The box inherits the model's rotation but not its translation: the position is
 * already in world space because the centre went through the model transform.
 * Rotating a box that is already placed would move it.
 */
export function placeExtras(plan: HullPlan, frame: ModelFrame): readonly ExtraPlacement[] {
 return plan.extras.map((extra) => ({
  center: transformPoint(frame, { x: extra.center[0], y: extra.center[1], z: extra.center[2] }),
  size: {
   x: extra.halfExtents[0] * 2 * frame.scale,
   y: extra.halfExtents[1] * 2 * frame.scale,
   z: extra.halfExtents[2] * 2 * frame.scale,
  },
  rotation: frame.rotation,
 }));
}

/** Where each engine beacon belongs, in the order the extras carry them. */
export interface BeaconSite {
 /** The engine index this beacon belongs to, from zero as glows are emitted. */
 readonly engine: number;
 /** Where the beacon sits, in world units. */
 readonly center: Vec3Like;
}

/**
 * Which of the placed details are engine glows, and which engine each belongs to.
 *
 * The engine index is tracked by counting the glows as they are emitted rather
 * than by asking the voxel module for an index, because `ExtraMesh` carries only
 * a kind. That is also the order the plan produces its extras, so the Nth glow is
 * the Nth engine.
 */
export function beaconSites(plan: HullPlan, placements: readonly ExtraPlacement[]): readonly BeaconSite[] {
 const sites: BeaconSite[] = [];
 let engine = 0;
 for (let index = 0; index < plan.extras.length; index += 1) {
  if (plan.extras[index]?.kind === Kind.EngineGlow) {
   const placement = placements[index];
   if (placement !== undefined) {
    sites.push({ engine, center: placement.center });
    engine += 1;
   }
  }
 }
 return sites;
}
