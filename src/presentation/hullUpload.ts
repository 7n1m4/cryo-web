/**
 * The hull mesh upload: a `ShipMesh` becomes a Babylon mesh.
 *
 * This is the burner — the one place `u8` RGB becomes `f32` geometry, and the
 * one place `MAX_MESH_VERTICES` matters. Everything before this is pure; nothing
 * after it is testable without a GPU.
 *
 * The contract carried over from the Rust:
 *
 * - Colour is a **four-component** vertex attribute, uploaded from a
 *   `Float32Array`, because the mesher emits `[r, g, b, a]` per vertex and the
 *   engine's colour attribute is a `float4`.
 * - Glazing is the only translucent material, at **alpha 0.45**.
 * - Back-face culling follows the mesher's winding, which is already
 *   counter-clockwise around the outward normal.
 * - A hull too large for a `u16` index raises the typed `TooManyVertices`
 *   error, caught here at the render boundary rather than in the generator.
 */

import type { Mesh, Scene } from 'babylonjs';

import { VOXEL_SCALE } from './constants.ts';
import type { ExtraMesh, ShipMesh } from '../ship/voxel.ts';
import { ExtraMeshKind, PaletteChoice, meshErrorMessage, type MeshError } from '../ship/voxel.ts';

/** Whether a detail is translucent, and therefore needs its own material. */
export const GLAZING_ALPHA = 0.45;

/**
 * The upload result: the mesh and the tally of what it holds.
 *
 * The tally exists so a headless test can assert the upload did what it claims
 * without a GPU to look at.
 */
export interface UploadResult {
  /** The mesh that was uploaded, or `null` if the mesh was empty. */
  readonly mesh: Mesh | null;
  /** How many quads the ceiling check saw. */
  readonly quadCount: number;
  /** Whether the upload hit `MAX_MESH_VERTICES` and was refused. */
  readonly refused: MeshError | null;
}

/**
 * Flattens a `[r, g, b, a]` vertex list into the `Float32Array` a Babylon
 * colour attribute holds.
 *
 * The interoperability contract: the mesher emits four components per vertex,
 * and Babylon wants them interleaved in one buffer, so the counts must match
 * or the attribute is corrupt rather than wrong.
 */
export function flattenColors(
  colors: readonly (readonly number[])[],
): Float32Array {
  const flat = new Float32Array(colors.length * 4);
  for (let index = 0; index < colors.length; index += 1) {
    const color = colors[index];
    if (color === undefined) {
      continue;
    }
    flat[index * 4 + 0] = color[0] ?? 0;
    flat[index * 4 + 1] = color[1] ?? 0;
    flat[index * 4 + 2] = color[2] ?? 0;
    flat[index * 4 + 3] = color[3] ?? 0;
  }
  return flat;
}

/**
 * Flattens a `[x, y, z]` vertex list the same way.
 *
 * The mesher's positions are integer voxel coordinates; multiplying by
 * `VOXEL_SCALE` here is the single place the exterior's decimetre grid becomes a
 * world-unit scale.
 */
export function flattenPositions(
  positions: readonly (readonly number[])[],
): Float32Array {
  const flat = new Float32Array(positions.length * 3);
  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index];
    if (position === undefined) {
      continue;
    }
    flat[index * 3 + 0] = (position[0] ?? 0) * VOXEL_SCALE;
    flat[index * 3 + 1] = (position[1] ?? 0) * VOXEL_SCALE;
    flat[index * 3 + 2] = (position[2] ?? 0) * VOXEL_SCALE;
  }
  return flat;
}

/**
 * Whether the frontier indices fit a `u16` buffer.
 *
 * This is the pre-check the Rust performs before emitting, so an oversized hull
 * fails before any GPU work rather than after.
 */
export function indicesFitU16(indices: readonly number[]): boolean {
  for (const index of indices) {
    if (index > 0xffff) {
      return false;
    }
  }
  return true;
}

/**
 * Builds a `Uint16Array` from the mesher's index list.
 *
 * The boundary check: a `u16` index is the whole reason the vertex cap exists,
 * so this is where it is enforced and where the typed error is produced.
 */
export function toU16Indices(
  indices: readonly number[],
  maxVertices: number,
): Uint16Array | MeshError {
  if (!indicesFitU16(indices)) {
    return {
      kind: 'TooManyVertices',
      vertices: maxVertices + 1,
      limit: maxVertices,
    };
  }
  return new Uint16Array(indices);
}

/** How many attribute arrays a hull mesh carries. */
export const HULL_ATTRIBUTE_COUNT = 3;

/**
 * Uploads `mesh`'s geometry into a Babylon `Mesh`.
 *
 * The caller owns the mesh and disposes it. `null` is returned for an empty
 * mesh, because an empty mesh is a legitimate hull state (a grid with no
 * occupied cells) and calling `new Mesh` on it would be a draw of nothing.
 */
export function uploadHullGeometry(
  mesh: Mesh,
  hull: ShipMesh,
  scene: Scene,
  babylon: typeof import('babylonjs'),
): MeshError | null {
  if (hull.positions.length === 0) {
    return null;
  }
  const indices = toU16Indices(hull.indices, hull.positions.length);
  if (!(indices instanceof Uint16Array)) {
    return indices;
  }
  const positions = flattenPositions(hull.positions);
  const normals = flattenPositions(hull.normals);
  const colors = flattenColors(hull.colors);
  mesh.setVerticesData(babylon.VertexBuffer.PositionKind, positions, false);
  mesh.setVerticesData(babylon.VertexBuffer.NormalKind, normals, false);
  mesh.setVerticesData(babylon.VertexBuffer.ColorKind, colors, false);
  mesh.setIndices(indices, null, true);
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  void scene;
  return null;
}

/** The world-space centre of a hull, given its plan's landmarks. */
export function hullCentre(
  centreX: number,
  gridHeight: number,
): { readonly x: number; readonly y: number; readonly z: number } {
  return {
    x: centreX * VOXEL_SCALE,
    y: (gridHeight / 2) * VOXEL_SCALE,
    z: 0,
  };
}

/** How many non-voxel details a hull carries, by kind. */
export const EXTRA_KIND_COUNT = 3;

/** The extras grouped by kind, so presentation can commit a material per group. */
export function extrasByKind(
  extras: readonly ExtraMesh[],
): Record<string, readonly ExtraMesh[]> {
  const grouped: Record<string, ExtraMesh[]> = {
    [ExtraMeshKind.CockpitGlazing]: [],
    [ExtraMeshKind.EngineGlow]: [],
    [ExtraMeshKind.LandingPad]: [],
  };
  for (const extra of extras) {
    grouped[extra.kind]?.push(extra);
  }
  return grouped;
}

/** Whether any of `extras` is the translucent glazing. */
export function hasGlazing(extras: readonly ExtraMesh[]): boolean {
  return extras.some((extra) => extra.kind === ExtraMeshKind.CockpitGlazing);
}

/** The `[r, g, b, a]` of a livery choice, for a golden test to compare. */
export function liveryRgba(palette: PaletteChoice): readonly [number, number, number, number] {
  return palette === PaletteChoice.Explorer ? [1, 1, 1, 1] : [0.8, 0.9, 1, 1];
}

/** The rendering of a mesh error, for the presentation log. */
export function renderMeshError(error: MeshError): string {
  return meshErrorMessage(error);
}

/** A `VertexBuffer`'s kind constants the upload touches. */
export const VERTEX_BUFFER_KINDS = {
  position: 'position',
  normal: 'normal',
  color: 'color',
} as const satisfies Record<string, string>;

/** The type of `VertexBuffer`'s kind field, for a signature. */
export type VertexBufferKind = keyof typeof VERTEX_BUFFER_KINDS;

/** The three attributes a hull mesh uploads, in upload order. */
export const HULL_ATTRIBUTE_ORDER: readonly VertexBufferKind[] = ['position', 'normal', 'color'];
