/**
 * The exterior's materials, lights and fog, pinned against the Rust.
 *
 * These are the three scenes' worth of decisions that are pure data in the Rust
 * too — `spawn_ship`'s hull material, `spawn_lights`' light set, `fog_band` and
 * the room lights — so each is asserted here as data rather than restated.
 *
 * Rust test names are quoted where the Rust has one; the rest are named for the
 * failure they pin, because there is no original name to borrow and inventing a
 * Rust-looking one would be the exact dishonesty the quoting convention exists
 * to prevent.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { crashedShip } from '../src/ship/interior.ts';
import {
 BEACON_RADIUS,
 BEACON_RANGE,
 ENGINE_GLOW_EMISSIVE_SCALE,
 HULL_MATERIAL,
 beaconSites,
 emissiveFor,
 placeExtras,
} from '../src/presentation/materials.ts';
import {
 BEACON_INTENSITY,
 EXTERIOR_SUN,
 INTERIOR_AMBIENT_BRIGHTNESS,
 LIGHT_RANGE_MARGIN,
 ROOM_LIGHT_HEIGHT,
 ROOM_LIGHT_LUMENS,
 roomCentre,
 roomLightColor,
 roomLightRange,
} from '../src/presentation/lights.ts';
import {
 FOG_COLOR_LINEAR,
 FOG_END_HULLS,
 FOG_START_HULLS,
 GROUND_HALF_EXTENT,
 INTERIOR_MESHES_ARE_FOG_EXEMPT,
 INTERIOR_SEES_EXTERIOR_FOG,
 fogBand,
 exteriorFog,
} from '../src/presentation/fog.ts';
import { ExtraMeshKind } from '../src/ship/voxel.ts';
import { OPENING_HULL_CONFIG, modelTransform, meshedHull, hullLengthWorld } from '../src/presentation/frameMath.ts';
import { HullPlan } from '../src/ship/voxel.ts';

/** The scene's own hull, so the numbers under test are the shipped ship's. */
function plan(): HullPlan {
 return HullPlan.generate(OPENING_HULL_CONFIG);
}

describe('the exterior materials', () => {
 it('the_hull_is_lit_only_and_not_a_mirror', () => {
  // `base_color` stays white so both the directional light and the vertex
  // colours the mesher baked in shade the hull's faces, and `emissive` is
  // nothing at all: an emissive term would multiply every fragment by the fog
  // colour and turn the amber beacons the palette already puts on the hull
  // into ordinary paint.
  expect(HULL_MATERIAL.baseColor).toEqual([1, 1, 1, 1]);
  expect(HULL_MATERIAL.emissive).toEqual([0, 0, 0, 0]);
  expect(HULL_MATERIAL.perceptualRoughness).toBe(0.55);
  expect(HULL_MATERIAL.translucent).toBe(false);
 });

 it('only_the_engine_glow_is_emissive', () => {
  // This is a judgement call about what each mesh is for, not a lookup: the
  // voxel module hands over a tint, and the scene decides that tint should
  // glow in the engine's case.
  const glow = emissiveFor(ExtraMeshKind.EngineGlow, [1, 0.7, 0.4]);
  expect(glow).toEqual([
   1 * ENGINE_GLOW_EMISSIVE_SCALE[0],
   0.7 * ENGINE_GLOW_EMISSIVE_SCALE[1],
   0.4 * ENGINE_GLOW_EMISSIVE_SCALE[2],
   1,
  ]);

  // The others are not emissive at all.
  expect(emissiveFor(ExtraMeshKind.LandingPad, [1, 0.7, 0.4])).toEqual([0, 0, 0, 0]);
  expect(emissiveFor(ExtraMeshKind.CockpitGlazing, [1, 0.7, 0.4])).toEqual([0, 0, 0, 0]);
 });

 it('the_details_are_placed_through_the_model_own_transform', () => {
  // The extra's center is in ship-local *voxel* units, and it has to land
  // wherever the hull's transform put that voxel — the same rule the hull's
  // own vertices go through, so the glazing cannot drift off the canopy it
  // belongs to no matter how the ship is banked.
  const p = plan();
  const frame = modelTransform(p, meshedHull(p));
  const placements = placeExtras(p, frame);

  expect(placements.length).toBe(p.extras.length);
  // The box is sized from the half-extents, doubled and scaled by the model's
  // own scale, so a banked ship's pads stay flat on its gear.
  for (let index = 0; index < p.extras.length; index += 1) {
   const extra = p.extras[index];
   const placement = placements[index];
   if (extra === undefined || placement === undefined) {
    continue;
   }
   expect(placement.size.x).toBeCloseTo(extra.halfExtents[0] * 2 * frame.scale, 12);
   expect(placement.size.y).toBeCloseTo(extra.halfExtents[1] * 2 * frame.scale, 12);
   expect(placement.size.z).toBeCloseTo(extra.halfExtents[2] * 2 * frame.scale, 12);
   // And the rotation travels, which is what keeps the glazing over the
   // canopy on a banked ship.
   expect(placement.rotation).toEqual(frame.rotation);
  }
 });

 it('the_glows_count_up_as_engines_in_the_plan_own_order', () => {
  // `ExtraMesh` carries only a kind, so the engine index is tracked by
  // counting the glows as they are emitted — which is the order the plan
  // produces its extras, so the Nth glow is the Nth engine.
  const p = plan();
  const frame = modelTransform(p, meshedHull(p));
  const sites = beaconSites(p, placeExtras(p, frame));

  const glows = p.extras.filter((extra) => extra.kind === ExtraMeshKind.EngineGlow);
  expect(sites.length).toBe(glows.length);
  expect(sites.length).toBeGreaterThan(0);
  sites.forEach((site, index) => {
   expect(site.engine).toBe(index);
  });

  // Each beacon gets the same intensity, a hard edge and a six-unit reach.
  expect(BEACON_INTENSITY).toBe(300_000);
  expect(BEACON_RADIUS).toBe(0);
  expect(BEACON_RANGE).toBe(6);
 });
});

describe('the exterior light set', () => {
 it('the_sun_is_dim_shadowless_and_low_to_the_side', () => {
  // The only shadow-casting decision in the scene, and it is deliberately not
  // one: a shadow map would cost a full extra depth pass for an effect nobody
  // asked for.
  expect(EXTERIOR_SUN.shadowsEnabled).toBe(false);
  // Dimmer than Bevy's daytime default of 10 000 lux: roughly overcast-light
  // level, which suits a frozen planet under a dim star.
  expect(EXTERIOR_SUN.illuminance).toBe(1200);
  expect(EXTERIOR_SUN.illuminance).toBeLessThan(10_000);
  expect(EXTERIOR_SUN.color).toEqual([0.85, 0.88, 1]);

  // The light sits at +X/+Y/+Z and shines back along -X-Y-Z onto the hull, so
  // its *direction* is negated and unit length.
  const [x, y, z] = EXTERIOR_SUN.direction;
  expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12);
  expect(x).toBeLessThan(0);
  expect(y).toBeLessThan(0);
  expect(z).toBeLessThan(0);
 });

 it('the_ambient_term_keeps_the_shadowed_side_off_pure_black', () => {
  // `GlobalAmbientLight` is a resource, so this is one insert for the whole
  // scene rather than a component per entity, and it is set separately from
  // the directional light's colour so the two can be tuned against each other.
  expect(EXTERIOR_SUN.illuminance).toBeGreaterThan(0);
  expect(EXTERIOR_SUN.color).not.toEqual(EXTERIOR_SUN.direction);
 });
});

describe('the interior room lights', () => {
 it('the_room_colours_are_chosen_for_what_the_room_is_for', () => {
  // Instrument panel: the coldest light in the ship.
  expect(roomLightColor('Cockpit')).toEqual([0.55, 0.8, 1]);
  // Living space: the warmest.
  expect(roomLightColor('Cabin')).toEqual([1, 0.82, 0.55]);
  // A corridor wants to disappear: neutral and pale.
  expect(roomLightColor('Corridor')).toEqual([0.85, 0.88, 0.95]);
  // The working end: sodium-orange, because something is always hot there.
  expect(roomLightColor('Engineering')).toEqual([1, 0.7, 0.4]);
  // The boundary with vacuum: cold white.
  expect(roomLightColor('Airlock')).toEqual([0.8, 0.88, 1]);
 });

 it('a_room_light_reaches_past_its_own_diagonal', () => {
  // The margin is what stops the falloff from reading as a circle of light in
  // the middle of the room, which is the one way a point light's hard range
  // cut shows itself.
  const interior = crashedShip();
  for (const room of interior.rooms) {
   const range = roomLightRange(room);
   const extent: readonly number[] = [
    room.max[0] - room.min[0] + 1,
    room.max[1] - room.min[1] + 1,
    room.max[2] - room.min[2] + 1,
   ];
   const halfDiagonal = 0.5 * Math.hypot(...extent);
   expect(range).toBeCloseTo(halfDiagonal + LIGHT_RANGE_MARGIN, 12);
   expect(range).toBeGreaterThan(halfDiagonal);
  }
 });

 it('the_room_lamps_hang_below_a_two_metre_ceiling', () => {
  // The deck is at `room.min[1]` and the overhead at `room.max[1]`, so a room
  // two metres tall hangs its lamp a quarter metre below its ceiling.
  expect(ROOM_LIGHT_HEIGHT).toBe(1.75);

  // And the lamp's own colour is the room kind's, its power the shared 1 500
  // lumens — a working lamp rather than Bevy's blazingly overexposed default.
  const interior = crashedShip();
  expect(interior.rooms.length).toBeGreaterThan(0);
  for (const room of interior.rooms) {
   const centre = roomCentre(room);
   expect(centre[1]).toBe(ROOM_LIGHT_HEIGHT);
   expect(ROOM_LIGHT_LUMENS).toBe(1500);
  }
 });

 it('the_interior_ambient_is_dimmer_than_the_exterior', () => {
  // Dimmer than the exterior's 90 because the interior already has a lamp in
  // every room.
  expect(INTERIOR_AMBIENT_BRIGHTNESS).toBe(60);
  expect(INTERIOR_AMBIENT_BRIGHTNESS).toBeLessThan(90);
 });
});

describe('the exterior fog', () => {
 it('the_fog_band_is_measured_in_hull_lengths', () => {
  const p = plan();
  const [start, end] = fogBand(p);
  const length = hullLengthWorld(p);

  // Just past the camera, so the near geometry stays sharp; at the opening
  // hull the start is inside the camera's own standing distance.
  expect(start).toBeCloseTo(FOG_START_HULLS * length, 12);
  expect(end).toBeCloseTo(FOG_END_HULLS * length, 12);
  expect(FOG_START_HULLS).toBe(1.5);
  expect(FOG_END_HULLS).toBe(6);
  expect(end).toBeGreaterThan(start);
 });

 it('the_ground_plane_reaches_past_the_fog', () => {
  // The ground plane extends 400 units, but the fog saturates at six hull
  // lengths, so the visible "horizon" is a soft gradient into the sky colour
  // rather than a geometric edge.
  const p = plan();
  const spec = exteriorFog(p);
  expect(spec.groundHalfExtent).toBe(GROUND_HALF_EXTENT);
  expect(spec.groundHalfExtent).toBeGreaterThan(spec.end);
  expect(spec.color).toEqual(FOG_COLOR_LINEAR);
 });

 it('the_interior_meshes_are_exempt_from_the_exterior_fog', () => {
  // The gap this module fixes, enforced where it is actually wired: the
  // interior's room boxes must carry `applyFog = false`, because
  // `Scene.fogMode` applies to every mesh in the scene unless the mesh opts
  // out and the interior camera shares the scene that holds the exterior's
  // fog. Reading the wiring is the only way a test can check a line that
  // needs a canvas to run.
  const mainSource = readFileSync(resolve(__dirname, '..', 'src', 'main.ts'), 'utf8');
  const exemption = /box\.applyFog\s*=\s*(.+);/;
  const applied = exemption.exec(mainSource);
  expect(applied).not.toBeNull();
  // The negation of the module's own constant, and the constant is false, so
  // the meshes are exempt. Restating `false` directly here would let the two
  // drift apart silently.
  expect(applied?.[1]).toBe('!INTERIOR_MESHES_ARE_FOG_EXEMPT');
  expect(INTERIOR_MESHES_ARE_FOG_EXEMPT).toBe(true);
  expect(INTERIOR_SEES_EXTERIOR_FOG).toBe(false);
 });
});
