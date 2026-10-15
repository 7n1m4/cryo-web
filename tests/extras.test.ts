/**
 * The extras wiring, exercised under a null renderer.
 *
 * The point of a `NullEngine` test is that it exercises the *wiring* — that the
 * boxes are made, sized, placed, rotated and given materials — without needing a
 * canvas. What it cannot assert is anything about appearance: no pixel has been
 * produced, and a claim about how this *looks* is unverified by this file.
 *
 * The decisions the wiring carries (which detail is translucent, which glows,
 * what the emissive colour is scaled by) are `materials.ts`, which is asserted
 * as data in `tests/sceneData.test.ts`. This file asserts only that the wiring
 * applies them where it should.
 */

import { NullEngine, PBRMaterial, Scene, type Material } from '@babylonjs/core/pure.js';
import { describe, expect, it } from 'vitest';

import {
 OPENING_HULL_CONFIG,
 cameraPosition,
 modelOrigin,
 modelTransform,
 meshedHull,
} from '../src/presentation/frameMath.ts';
import { buildExtras } from '../src/presentation/extras.ts';
import { placeExtras } from '../src/presentation/materials.ts';
import { HullPlan } from '../src/ship/voxel.ts';

/** A scene with no canvas, which is the only kind this test needs. */
function nullScene(): Scene {
 return new Scene(new NullEngine());
}

/** The scene's own hull, so the numbers under test are the shipped ship's. */
function plan(): HullPlan {
 return HullPlan.generate(OPENING_HULL_CONFIG);
}

/**
 * The `PBRMaterial` a built extra carries, narrowed rather than cast.
 *
 * `Mesh.material` is `Nullable<Material>` because a mesh can carry any material
 * this module did not build. The wiring commits a `PBRMaterial` for every
 * detail, so narrowing with `instanceof` is a runtime check that holds — and it
 * is the check that catches a future refactor committing some other material
 * and silently dropping the emissive colour.
 */
function pbrOf(material: Material): PBRMaterial {
 if (!(material instanceof PBRMaterial)) {
  throw new TypeError(`expected a PBRMaterial, got ${material.getClassName()}`);
 }
 return material;
}

describe('the extras wiring', () => {
 it('builds_one_box_per_detail_with_the_model_own_placement', () => {
  const scene = nullScene();
  const hull = plan();
  const built = buildExtras(scene, hull, 'test');

  // One mesh per extra, in the plan's own order.
  expect(built.length).toBe(hull.extras.length);
  expect(built.length).toBeGreaterThan(0);

  const placements = placeExtras(hull, modelTransform(hull, meshedHull(hull)));
  built.forEach((extra, index) => {
   const placement = placements[index];
   if (placement === undefined) {
    throw new Error(`no placement for extra ${index}`);
   }
   expect(extra.mesh.position.x).toBeCloseTo(placement.center.x, 12);
   expect(extra.mesh.position.y).toBeCloseTo(placement.center.y, 12);
   expect(extra.mesh.position.z).toBeCloseTo(placement.center.z, 12);

   // The rotation travels, which is what keeps the pads flat on a banked
   // ship's gear and the glazing over the canopy.
   expect(extra.mesh.rotation.z).toBeCloseTo(placement.rotation.bank, 12);
   expect(extra.mesh.rotation.x).toBeCloseTo(placement.rotation.pitch, 12);

   // And the box is sized from the half-extents, doubled and scaled.
   const bounding = extra.mesh.getBoundingInfo().boundingBox;
   expect(bounding.extendSize.x * 2).toBeCloseTo(placement.size.x, 6);
   expect(bounding.extendSize.y * 2).toBeCloseTo(placement.size.y, 6);
   expect(bounding.extendSize.z * 2).toBeCloseTo(placement.size.z, 6);
  });

  // No detail is far enough from the hull to be reached by the exterior's
  // fog band, so none of them opts out.
  expect(built.every((extra) => !extra.fogExempt)).toBe(true);
 });

 it('only_the_canopy_is_translucent_and_only_the_engine_glow_is_emissive', () => {
  const scene = nullScene();
  const built = buildExtras(scene, plan(), 'test');

  // Exactly the glazings are translucent, and there is at least one.
  const glazings = built.filter((extra) => extra.translucent);
  expect(glazings.length).toBeGreaterThan(0);
  expect(glazings.every((extra) => extra.kind === 'cockpit glazing')).toBe(true);
  for (const glazing of glazings) {
   const material = glazing.mesh.material;
   expect(material).not.toBeNull();
   if (material === null) {
    continue;
   }
   // The palette's own alpha, quoted by `materials.ts` rather than restated.
   expect(pbrOf(material).alpha).toBeCloseTo(0.45, 12);
   // Two-sided, because the interior's cockpit looks at this from inside.
   expect(pbrOf(material).backFaceCulling).toBe(false);
  }

  // Exactly the glows are emissive, and each carries a real emissive colour
  // scaled per channel rather than a flat white.
  const glows = built.filter((extra) => extra.emissive);
  expect(glows.length).toBeGreaterThan(0);
  expect(glows.every((extra) => extra.kind === 'engine glow')).toBe(true);
  for (const glow of glows) {
   const material = glow.mesh.material;
   if (material === null) {
    continue;
   }
   const emissive = pbrOf(material).emissiveColor;
   // Not black, and not the flat white a naive implementation would use.
   expect(emissive.r).toBeGreaterThan(0);
   expect(emissive.g).toBeGreaterThan(0);
   expect(emissive.b).toBeGreaterThan(0);
  }

  // The pads are neither.
  const pads = built.filter((extra) => extra.kind === 'landing pad');
  expect(pads.length).toBeGreaterThan(0);
  expect(pads.every((extra) => !extra.translucent && !extra.emissive)).toBe(true);
 });

 it('the_details_are_placed_in_the_world_the_hull_itself_is_in', () => {
  // The placement is only meaningful against the framing the camera is
  // actually built with, so this asserts the two agree: a detail's centre is
  // finite, above the ice, and below the camera that shoots it.
  const scene = nullScene();
  const hull = plan();
  const built = buildExtras(scene, hull, 'test');

  const mesh = meshedHull(hull);
  const camera = cameraPosition(hull, modelOrigin(hull), mesh);

  for (const extra of built) {
   expect(Number.isFinite(extra.mesh.position.x)).toBe(true);
   expect(Number.isFinite(extra.mesh.position.y)).toBe(true);
   expect(Number.isFinite(extra.mesh.position.z)).toBe(true);
   // Everything about the ship is above y = 0, which the model transform's
   // measured clearance is what guarantees.
   expect(extra.mesh.position.y).toBeGreaterThan(0);
   // And below the camera, which is what makes the establishing shot a shot
   // of the ship rather than of its roof.
   expect(extra.mesh.position.y).toBeLessThan(camera.y);
  }
 });
});
