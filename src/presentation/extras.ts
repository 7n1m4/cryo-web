/**
 * The non-voxel details as Babylon meshes: the canopy, the engine glows and the
 * landing pads.
 *
 * The decisions are `materials.ts` — which detail is translucent, which is
 * emissive — and this module is the wiring that turns them into real meshes with
 * real materials. That split is deliberate: a decision asserted as data can be
 * checked in a null-renderer test, and only the wiring needs a canvas.
 *
 * Every detail is a single box positioned from the voxel module's `ExtraMesh`
 * description. That is the extent of what presentation invents here: the module
 * says *where* and *what colour*, and this function says *how big the box is*,
 * which is a rendering concern.
 *
 * The details are separate meshes rather than part of the hull because they are
 * not voxels — the canopy is a smooth box, the engine glow is emissive, the pads
 * are flat. Modelling them as voxels would either lose that smoothness or cost
 * far more faces than the effect is worth.
 */

import { MeshBuilder, PBRMaterial, type Mesh, type Scene } from '@babylonjs/core/pure.js';

import type { ExtraMeshKind } from '../ship/voxel.ts';
import { ExtraMeshKind as Kind } from '../ship/voxel.ts';
import type { HullPlan } from '../ship/voxel.ts';
import type { ModelFrame } from './frameMath.ts';
import { meshedHull, modelTransform } from './frameMath.ts';
import { GLAZING_ALPHA, placeExtras, emissiveFor } from './materials.ts';

/** One built detail, with its material's deciding facts attached. */
export interface BuiltExtra {
 /** The mesh Babylon draws. */
 readonly mesh: Mesh;
 /** Which detail this is. */
 readonly kind: ExtraMeshKind;
 /** Whether this detail's material is the scene's only translucent one. */
 readonly translucent: boolean;
 /** Whether this detail glows. */
 readonly emissive: boolean;
 /**
  * Whether this mesh must be exempt from the exterior's fog.
  *
  * Always `false` here: the exterior's fog band ends well inside the hull's own
  * extent, so no detail is far enough away to be affected. The exemption is the
  * *interior's*, and it is asserted in `fog.ts`.
  */
 readonly fogExempt: boolean;
}

/**
 * Builds every detail of a hull.
 *
 * The centre is brought to world space through the model's own transform —
 * rotation, then scale, then translation — which is the same rule the hull's
 * vertices go through, so the glazing cannot drift off the canopy it belongs to
 * no matter how the ship is banked. Only the rotation travels to the mesh: the
 * position is already in world space because the centre went through the model
 * transform, and rotating an already-placed box would move it.
 */
export function buildExtras(scene: Scene, plan: HullPlan, namePrefix: string): readonly BuiltExtra[] {
 const hull = meshedHull(plan);
 const frame: ModelFrame = modelTransform(plan, hull);
 const placements = placeExtras(plan, frame);
 const built: BuiltExtra[] = [];

 for (let index = 0; index < plan.extras.length; index += 1) {
  const extra = plan.extras[index];
  const placement = placements[index];
  if (extra === undefined || placement === undefined) {
   continue;
  }

  // The box is sized from the half-extents, doubled and scaled by the model's
  // own scale — the same factor the centre went through.
  const mesh: Mesh = MeshBuilder.CreateBox(
   `${namePrefix}-extra-${index}`,
   {
    width: placement.size.x,
    height: placement.size.y,
    depth: placement.size.z,
   },
   scene,
  );
  mesh.position.set(placement.center.x, placement.center.y, placement.center.z);
  mesh.rotation.z = frame.rotation.bank;
  mesh.rotation.x = frame.rotation.pitch;

  const material = new PBRMaterial(`${namePrefix}-extra-material-${index}`, scene);
  const rgba = extra.colorF32Rgba(plan.config.palette);
  material.albedoColor.set(rgba[0], rgba[1], rgba[2]);

  // Glazing is the one translucent thing in the scene: it reads as glass,
  // which is what says "cockpit" without a window frame. Its alpha comes from
  // the palette entry the voxel module already carries.
  const translucent = extra.kind === Kind.CockpitGlazing;
  if (translucent) {
   material.alpha = GLAZING_ALPHA;
   // A two-sided translucent box: from inside the canopy a single-sided pane
   // would vanish, and the interior's cockpit is exactly where that shows.
   material.backFaceCulling = false;
  }

  // Engine glow is emissive; the others are not. The emissive colour is the
  // tint scaled per channel, which is what makes the wash read as warm rather
  // than as a white box.
  const [r, g, b] = extra.colorF32Rgba(plan.config.palette);
  const emissive = extra.kind === Kind.EngineGlow;
  if (emissive) {
   const glow = emissiveFor(extra.kind, [r, g, b]);
   material.emissiveColor.set(glow[0], glow[1], glow[2]);
  }

  mesh.material = material;

  built.push({ mesh, kind: extra.kind, translucent, emissive, fogExempt: false });
 }

 return built;
}
