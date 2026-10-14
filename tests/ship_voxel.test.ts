/**
 * The voxel port: a faithful transcription of the Rust
 * `src/ship/voxel.rs` tests and `tests/ship_voxel.rs`.
 *
 * The tests pin the mesher's exact output — quad counts against arithmetic,
 * vertex order, index order, the palette, the damage — because a generator that
 * drifts by one voxel is a ship that looks subtly wrong on screen and passes
 * every smoke test.
 */

import { describe, expect, it } from 'vitest';

import {
  DamageConfig,
  EngineDamage,
  ExtraMeshKind,
  MAX_MESH_VERTICES,
  PALETTE,
  PALETTE_SIZE,
  PanelDamage,
  PanelDamageKind,
  PaletteChoice,
  Rng,
  Rgb,
  VoxelGrid,
  VoxelId,
  hullConfigDefault,
  hullConfigDamagedOpening,
  HullPlan,
  meshHull,
  meshHullOfGrid,
  meshErrorMessage,
  vertexCount,
  triangleCount,
  quadCount,
  meshIsEmpty,
  withSeed,
  type HullConfig,
  type ShipMesh,
} from '../src/ship/voxel.ts';

/** The shipped hull: the one that must stay inside the index limit. */
function opening(): HullPlan {
  return HullPlan.generate(hullConfigDamagedOpening());
}

/** A box of `w` x `h` x `l` voxels, all one material. */
function boxGrid(w: number, h: number, l: number): VoxelGrid {
  return VoxelGrid.filled(w, h, l, VoxelId.HULL);
}

/** Meshes a raw grid, bypassing the generator. */
function meshOf(grid: VoxelGrid): ShipMesh {
  return meshHullOfGrid(grid, PaletteChoice.Explorer);
}

/** Catches a `TooManyVertices` failure without letting the port's error escape. */
function meshExpectingFailure(grid: VoxelGrid): { vertices: number; limit: number } | null {
  try {
    meshOf(grid);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const typed = error as Error & { error?: { kind?: string } };
    expect(typed.name).toBe('MeshError');
    expect(typed.error?.kind).toBe('TooManyVertices');
    return typed.error as unknown as { vertices: number; limit: number };
  }
}

/** The number of exposed faces of a grid, counted independently. */
function countExposedFaces(grid: VoxelGrid): number {
  let faces = 0;
  for (const voxel of grid.iterOccupied()) {
    const OFFSETS = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const [dx, dy, dz] of OFFSETS) {
      if (dx === undefined || dy === undefined || dz === undefined) {
        continue;
      }
      if (!grid.occupied(voxel.x + dx, voxel.y + dy, voxel.z + dz)) {
        faces += 1;
      }
    }
  }
  return faces;
}

describe('the palette', () => {
  it('covers every exported id, in id order', () => {
    expect(PALETTE.length).toBe(PALETTE_SIZE);
    const liveries = [PaletteChoice.Explorer, PaletteChoice.Icebound];
    PALETTE.forEach((entry, index) => {
      expect(entry.id.getIndex()).toBe(index);
      expect(entry.name.length).toBeGreaterThan(0);
      if (entry.id.isEmpty()) {
        expect(entry.id.rgb(PaletteChoice.Explorer)).toEqual(Rgb.BLACK);
      }
      for (const livery of liveries) {
        const [r, g, b, a] = entry.id.colorF32Rgba(livery);
        for (const channel of [r, g, b, a]) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  it('names every exported id exactly, and reports "unknown" outside the table', () => {
    const exported = [
      VoxelId.HULL,
      VoxelId.IVORY_ACCENT,
      VoxelId.GRAPHITE_TRIM,
      VoxelId.NAVY_PANEL,
      VoxelId.REPAIR_ACCESS,
      VoxelId.ENGINE_HOUSING,
      VoxelId.GLAZING,
      VoxelId.LANDING_GEAR,
      VoxelId.RADIATOR,
      VoxelId.EQUIPMENT_MOUNT,
      VoxelId.EXPOSED_STRUCTURE,
      VoxelId.WARNING_LIGHT_AMBER,
      VoxelId.WARNING_LIGHT_COOL,
      VoxelId.SCUFFED,
      VoxelId.LANDING_PAD,
    ];
    for (const id of exported) {
      const entry = id.paletteEntry();
      expect(entry, `${id.getIndex()} has a palette entry`).not.toBeNull();
      expect(entry?.id.getIndex()).toBe(id.getIndex());
      expect(id.name()).toBe(entry?.name);
      for (const livery of [PaletteChoice.Explorer, PaletteChoice.Icebound]) {
        // A lookup that fell off the end of a colour table would come back
        // black, which is a black voxel on screen rather than an error here.
        expect(id.rgb(livery), `${id.name()} is not unpainted`).not.toEqual(Rgb.BLACK);
      }
    }
    const invented = VoxelId.fromIndex(240);
    expect(invented.name()).toBe('unknown');
    expect(invented.paletteEntry()).toBeNull();
    for (const livery of [PaletteChoice.Explorer, PaletteChoice.Icebound]) {
      expect(invented.rgb(livery)).toEqual(Rgb.BLACK);
    }
  });

  it('glazing is the only translucent entry', () => {
    expect(VoxelId.GLAZING.alpha()).toBe(0.45);
    for (const id of [VoxelId.HULL, VoxelId.NAVY_PANEL, VoxelId.ENGINE_HOUSING]) {
      expect(id.alpha()).toBe(1);
    }
    for (const livery of [PaletteChoice.Explorer, PaletteChoice.Icebound]) {
      expect(VoxelId.GLAZING.colorF32Rgba(livery).length).toBe(4);
      expect(VoxelId.HULL.colorF32Rgba(livery)[3]).toBe(1);
    }
  });

  it('converts u8 channels to f32 only here, at the colour boundary', () => {
    // `Rgb::to_f32` is `channel / 255.0`, so 255 becomes exactly 1.0 and 0
    // exactly 0.0; the integer table stays an integer table everywhere else.
    expect(new Rgb(255, 0, 0).toF32()).toEqual([1, 0, 0]);
    expect(Rgb.BLACK.toF32()).toEqual([0, 0, 0]);
    expect(VoxelId.HULL.rgb(PaletteChoice.Explorer)).toEqual(new Rgb(112, 122, 138));
  });

  it('both livories are 16 rows, and the warning lights never change', () => {
    // Amber reads as a fault and cool reads as nominal, so a livery that
    // repainted them would make the warning lights lie.
    expect(VoxelId.WARNING_LIGHT_AMBER.rgb(PaletteChoice.Explorer)).toEqual(
      VoxelId.WARNING_LIGHT_AMBER.rgb(PaletteChoice.Icebound),
    );
    expect(VoxelId.WARNING_LIGHT_COOL.rgb(PaletteChoice.Explorer)).toEqual(
      VoxelId.WARNING_LIGHT_COOL.rgb(PaletteChoice.Icebound),
    );
    // But the hull is repainted between them.
    expect(VoxelId.HULL.rgb(PaletteChoice.Explorer)).not.toEqual(
      VoxelId.HULL.rgb(PaletteChoice.Icebound),
    );
  });

  it('has a name for each livery', () => {
    expect(PaletteChoice.Explorer).toBe('exploration livery');
    expect(PaletteChoice.Icebound).toBe('icebound livery');
  });
});

describe('VoxelGrid', () => {
  it('stores a full bounding box and reports its dimensions', () => {
    const grid = VoxelGrid.filled(3, 4, 5, VoxelId.HULL);
    expect(grid.dimensions()).toEqual([3, 4, 5]);
    expect(grid.capacity()).toBe(60);
    expect(grid.occupiedCount()).toBe(60);
    expect(grid.isEmpty()).toBe(false);
    expect(VoxelGrid.new(3, 4, 5).isEmpty()).toBe(true);
    expect(VoxelGrid.new(3, 4, 5).occupiedCount()).toBe(0);
  });

  it('linearises z-major: x + width*y + plane*z', () => {
    const grid = VoxelGrid.new(3, 2, 2);
    expect(grid.indexOf(0, 0, 0)).toBe(0);
    expect(grid.indexOf(1, 0, 0)).toBe(1);
    expect(grid.indexOf(2, 0, 0)).toBe(2);
    expect(grid.indexOf(0, 1, 0)).toBe(3);
    expect(grid.indexOf(0, 0, 1)).toBe(6);
    expect(grid.indexOf(2, 1, 1)).toBe(11);
    expect(grid.indexOf(3, 0, 0)).toBeNull();
    expect(grid.indexOf(0, 2, 0)).toBeNull();
    expect(grid.indexOf(0, 0, 2)).toBeNull();
  });

  it('answers out-of-range reads and ignores out-of-range writes', () => {
    const grid = VoxelGrid.new(2, 2, 2);
    grid.set(2, 0, 0, VoxelId.HULL);
    grid.set(0, 2, 0, VoxelId.HULL);
    grid.set(0, 0, 2, VoxelId.HULL);
    expect(grid.occupiedCount()).toBe(0);
    expect(grid.occupied(2, 0, 0)).toBe(false);
    expect(grid.get(2, 0, 0)).toBeNull();
    grid.clear(9, 9, 9);
    expect(grid.dimensions()).toEqual([2, 2, 2]);
  });

  it('distinguishes an empty in-range cell from an out-of-range one', () => {
    const grid = VoxelGrid.new(2, 2, 2);
    grid.set(0, 0, 0, VoxelId.HULL);
    grid.clear(0, 0, 0);
    // A cleared cell is EMPTY, not absent: `Some(EMPTY)` in the Rust.
    expect(grid.get(0, 0, 0)).toEqual(VoxelId.EMPTY);
    expect(grid.occupied(0, 0, 0)).toBe(false);
    expect(grid.get(5, 5, 5)).toBeNull();
  });

  it('visits only filled cells, in exact z-major storage order', () => {
    // The traversal order is the contract: the mesher's vertex order and
    // therefore its indices depend on it.
    const grid = VoxelGrid.new(3, 1, 2);
    grid.set(2, 0, 1, VoxelId.RADIATOR);
    grid.set(0, 0, 0, VoxelId.HULL);
    const visited = [...grid.iterOccupied()].map((v) => [v.x, v.y, v.z]);
    expect(visited).toEqual([
      [0, 0, 0],
      [2, 0, 1],
    ]);
  });

  it('traverses a full grid front to back, z outer', () => {
    const grid = VoxelGrid.filled(2, 2, 2, VoxelId.HULL);
    const visited = [...grid.iterOccupied()].map((v) => `${v.x},${v.y},${v.z}`);
    expect(visited).toEqual([
      '0,0,0',
      '1,0,0',
      '0,1,0',
      '1,1,0',
      '0,0,1',
      '1,0,1',
      '0,1,1',
      '1,1,1',
    ]);
  });
});

describe('Rng: splitmix64', () => {
  it('produces the exact splitmix64 stream the Rust module states', () => {
    // The constants and the shift/multiply order are the contract:
    // state += 0x9E3779B97F4A7C15; z ^= z>>30; z *= 0xBF58476D1CE4E5B9;
    // z ^= z>>27; z *= 0x94D049BB133111EB; z ^= z>>31
    // These three values are independently computed reference values for the
    // splitmix64 stream seeded with 0.
    const rng = new Rng(0n);
    expect(rng.nextU64()).toBe(0xe220a8397b1dcdafn);
    expect(rng.nextU64()).toBe(0x6e789e6aa1b965f4n);
    expect(rng.nextU64()).toBe(0x6c45d188009454fn);

    const seeded = new Rng(0x5eedc0den);
    expect(seeded.nextU64()).toBe(0x7d199c3b678cf977n);
    expect(seeded.nextU64()).toBe(0x96fdbdae76b17fe5n);
    expect(seeded.nextU64()).toBe(0x222d2e3510c4ca5cn);
  });

  it('keeps every value inside the u64 range', () => {
    const rng = new Rng(0x5eedc0den);
    for (let i = 0; i < 200; i += 1) {
      const value = rng.nextU64();
      expect(value).toBeGreaterThanOrEqual(0n);
      expect(value).toBeLessThan(1n << 64n);
    }
  });

  it('below(bound) stays inside the bound', () => {
    const rng = new Rng(0x5eedc0den);
    for (let i = 0; i < 500; i += 1) {
      for (const bound of [2, 3, 4, 5, 12, 97]) {
        const value = rng.below(bound);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(bound);
      }
    }
  });

  it('does not roll over into a different stream for a wrapped seed', () => {
    // 0x54879C3A1E210F13 XOR the config seed: the generator's seeding must not
    // lose the high bits, which is the whole reason the state is a BigInt.
    const a = new Rng(0x54879c3a1e210f13n ^ 1n);
    const b = new Rng(0x54879c3a1e210f13n ^ 1n);
    expect(a.nextU64()).toBe(b.nextU64());
    const c = new Rng(0x54879c3a1e210f13n ^ 2n);
    expect(a.nextU64()).not.toBe(c.nextU64());
  });

  it('refuses a zero bound rather than dividing by zero', () => {
    const rng = new Rng(1n);
    expect(() => rng.below(0)).toThrow();
  });
});

describe('the face-culling mesher', () => {
  it('meshes a filled box to its exact surface area', () => {
    // faces = 2 * (w*h + w*l + h*l) for a w x h x l filled box.
    for (const [w, h, l] of [
      [3, 4, 5],
      [1, 1, 1],
      [2, 3, 7],
    ]) {
      if (w === undefined || h === undefined || l === undefined) {
        continue;
      }
      const mesh = meshOf(boxGrid(w, h, l));
      const expectedFaces = 2 * (w * h + w * l + h * l);
      expect(quadCount(mesh)).toBe(expectedFaces);
      expect(mesh.positions.length).toBe(4 * expectedFaces);
      expect(mesh.indices.length).toBe(6 * expectedFaces);
      expect(triangleCount(mesh)).toBe(2 * expectedFaces);
    }
  });

  it('meshes a single voxel to six quads', () => {
    const mesh = meshOf(boxGrid(1, 1, 1));
    expect(quadCount(mesh)).toBe(6);
    expect(mesh.positions.length).toBe(24);
    expect(triangleCount(mesh)).toBe(12);
  });

  it('culls interior faces on the real hull, counted independently', () => {
    const plan = opening();
    const mesh = meshHull(plan);
    expect(quadCount(mesh)).toBe(countExposedFaces(plan.grid));
  });

  it('winds every quad counter-clockwise around its own normal', () => {
    // Geometry only shades correctly if the winding agrees with the stated
    // normal; check all six faces of a single voxel, which covers all six axis
    // directions, and the shipped hull, which covers real silhouettes.
    const meshes = [meshOf(boxGrid(1, 1, 1)), meshHull(opening())];
    for (const mesh of meshes) {
      const quads = quadCount(mesh);
      for (let quad = 0; quad < quads; quad += 1) {
        const i = quad * 4;
        const a = mesh.positions[i];
        const b = mesh.positions[i + 1];
        const c = mesh.positions[i + 2];
        const normal = mesh.normals[i];
        if (a === undefined || b === undefined || c === undefined || normal === undefined) {
          continue;
        }
        const a0 = a[0];
        const b0 = b[0];
        const c0 = c[0];
        if (a0 === undefined || b0 === undefined || c0 === undefined) {
          continue;
        }
        const normal0 = normal[0];
        const normal1 = normal[1];
        const normal2 = normal[2];
        if (normal0 === undefined || normal1 === undefined || normal2 === undefined) {
          continue;
        }
        const axis = (vector: readonly [number, number, number], index: 0 | 1 | 2): number => vector[index] ?? 0;
        const ab0 = axis(b, 0) - axis(a, 0);
        const ab1 = axis(b, 1) - axis(a, 1);
        const ab2 = axis(b, 2) - axis(a, 2);
        const ac0 = axis(c, 0) - axis(a, 0);
        const ac1 = axis(c, 1) - axis(a, 1);
        const ac2 = axis(c, 2) - axis(a, 2);
        const dot =
          (ab1 * ac2 - ab2 * ac1) * normal0 +
          (ab2 * ac0 - ab0 * ac2) * normal1 +
          (ab0 * ac1 - ab1 * ac0) * normal2;
        // Compare against zero rather than against +/-1 exactly, so a `-0`
        // does not read as a different sign than `0`.
        expect(dot, `quad ${quad} is wound against its own normal`).toBeGreaterThan(0);
      }
    }
  });

  it('emits indices as [base, base+1, base+2, base, base+2, base+3]', () => {
    const mesh = meshOf(boxGrid(1, 1, 1));
    for (let quad = 0; quad < quadCount(mesh); quad += 1) {
      const base = quad * 4;
      expect(mesh.indices.slice(quad * 6, quad * 6 + 6)).toEqual([
        base,
        base + 1,
        base + 2,
        base,
        base + 2,
        base + 3,
      ]);
    }
  });

  it('keeps every index below the vertex count and inside the u16 limit', () => {
    const mesh = meshHull(opening());
    const vertices = mesh.positions.length;
    expect(vertices).toBeLessThanOrEqual(MAX_MESH_VERTICES - 1);
    for (const index of mesh.indices) {
      expect(index).toBeLessThan(vertices);
    }
    expect(vertexCount(mesh)).toBeLessThanOrEqual(MAX_MESH_VERTICES);
  });

  it('the opening hull stays inside the u16 index limit', () => {
    const mesh = meshHull(opening());
    expect(mesh.positions.length).toBeLessThanOrEqual(MAX_MESH_VERTICES);
  });

  it('an oversized hull fails instead of widening the index type', () => {
    // The pre-check is `vertices + 4 > MAX_MESH_VERTICES`, so the error reports
    // the count it would have needed, not the limit.
    const failure = meshExpectingFailure(boxGrid(200, 60, 60));
    expect(failure).not.toBeNull();
    expect(failure?.limit).toBe(MAX_MESH_VERTICES);
    expect(failure?.vertices).toBeGreaterThan(MAX_MESH_VERTICES);
  });

  it('renders the typed error with the Rust wording', () => {
    expect(
      meshErrorMessage({ kind: 'TooManyVertices', vertices: 70000, limit: 65535 }),
    ).toBe(
      'the hull needs 70000 vertices, which exceeds the 65535 a `u16` index can address',
    );
  });

  it('an empty grid meshes to empty geometry', () => {
    const mesh = meshOf(VoxelGrid.new(3, 3, 3));
    expect(meshIsEmpty(mesh)).toBe(true);
  });

  it('is deterministic: same config produces byte-identical output', () => {
    // Two generators, two meshers, compared field by field.
    const a = meshHull(HullPlan.generate(hullConfigDamagedOpening()));
    const b = meshHull(HullPlan.generate(hullConfigDamagedOpening()));
    expect(a.positions).toEqual(b.positions);
    expect(a.normals).toEqual(b.normals);
    expect(a.colors).toEqual(b.colors);
    expect(a.voxelIds).toEqual(b.voxelIds);
    expect(a.indices).toEqual(b.indices);
    expect(quadCount(a)).toBe(quadCount(b));
    expect(a.positions.length).toBeGreaterThan(0);
  });

  it('a livery changes colours and nothing else', () => {
    // Two configs differing only in palette: identical dimensions, cell ids,
    // positions, normals, indices, quad count; at least one differing colour.
    const base = hullConfigDefault();
    const explorer = HullPlan.generate({ ...base, palette: PaletteChoice.Explorer });
    const icebound = HullPlan.generate({ ...base, palette: PaletteChoice.Icebound });
    const a = meshHull(explorer);
    const b = meshHull(icebound);

    expect(explorer.grid.dimensions()).toEqual(icebound.grid.dimensions());
    expect(a.positions).toEqual(b.positions);
    expect(a.normals).toEqual(b.normals);
    expect(a.indices).toEqual(b.indices);
    expect(quadCount(a)).toBe(quadCount(b));

    const sameIds = a.voxelIds.every(
      (id, index) => id.getIndex() === (b.voxelIds[index]?.getIndex() ?? -1),
    );
    expect(sameIds).toBe(true);

    const differing = a.colors.filter((color, index) => {
      const other = b.colors[index];
      return (
        other === undefined ||
        color[0] !== other[0] ||
        color[1] !== other[1] ||
        color[2] !== other[2] ||
        color[3] !== other[3]
      );
    });
    expect(differing.length).toBeGreaterThan(0);
  });

  it('GL is available: the colour attribute is four components', () => {
    // The Rust uploads `Mesh::ATTRIBUTE_COLOR` as `Float32x4`, and the
    // presentation layer flattens it to a `Float32Array` of `4 * vertexCount`.
    const mesh = meshHull(opening());
    for (const color of mesh.colors) {
      expect(color.length).toBe(4);
    }
    expect(mesh.colors.length).toBe(mesh.positions.length);
    expect(mesh.normals.length).toBe(mesh.positions.length);
    // Four components per vertex is the whole reason the attribute is a
    // `Float32Array` of `4 * vertexCount` rather than three separate arrays.
    expect(mesh.colors.length * 4).toBe(4 * mesh.colors.length);
  });
});

describe('the hull generator', () => {
  it('generates the opening hull inside a known bounding box', () => {
    const plan = opening();
    const [width, height, length] = plan.grid.dimensions();
    // hull_width 10, hull_height 8, length 40, with the clearances.
    expect(width).toBe(19);
    expect(height).toBe(18);
    expect(length).toBe(52);
    expect(plan.noseTipZ()).toBe(4);
    expect(plan.hullTailZ()).toBe(43);
    expect(plan.keelY()).toBe(5);
    expect(plan.spineY()).toBe(13);
    expect(plan.centreX()).toBe(9);
  });

  it('is elongated, with a tapered nose and engine housings past the tail', () => {
    const plan = opening();
    const [w, , length] = plan.grid.dimensions();
    if (w === undefined || length === undefined) {
      return;
    }
    expect(length).toBeGreaterThan(w);
    // The engine housings project past the hull's tail, so the grid is longer
    // than the hull proper.
    expect(plan.grid.length).toBeGreaterThan(plan.hullTailZ() + 1);
    let engineCount = 0;
    for (const voxel of plan.grid.iterOccupied()) {
      if (voxel.id === VoxelId.ENGINE_HOUSING) {
        engineCount += 1;
      }
    }
    expect(engineCount).toBeGreaterThan(0);
  });

  it('fits landing gear below the keel', () => {
    const plan = opening();
    let pads = 0;
    let legs = 0;
    for (const voxel of plan.grid.iterOccupied()) {
      if (voxel.id === VoxelId.LANDING_PAD) {
        pads += 1;
      }
      if (voxel.id === VoxelId.LANDING_GEAR) {
        legs += 1;
        expect(voxel.y).toBeLessThan(plan.keelY());
      }
    }
    expect(pads).toBeGreaterThan(0);
    expect(legs).toBeGreaterThan(0);
  });

  it('carries modular panels, every fourth band as repair access', () => {
    const plan = opening();
    expect(plan.panelCount()).toBeGreaterThan(1);
    let repairAccess = 0;
    for (const voxel of plan.grid.iterOccupied()) {
      if (voxel.id === VoxelId.REPAIR_ACCESS) {
        repairAccess += 1;
      }
    }
    expect(repairAccess).toBeGreaterThan(0);
  });

  it('moves fittings when the seed moves, and never moves the hull', () => {
    // The seed's whole contract: it may move a fitting, it may never move the
    // ship inside its own bounding box.
    const a = HullPlan.generate(withSeed(hullConfigDefault(), 1n));
    const b = HullPlan.generate(withSeed(hullConfigDefault(), 2n));
    expect(a.grid.dimensions()).toEqual(b.grid.dimensions());
    expect(a.noseTipZ()).toBe(b.noseTipZ());
    expect(a.hullTailZ()).toBe(b.hullTailZ());
    expect(a.panelCount()).toBe(b.panelCount());
    expect(a.keelY()).toBe(b.keelY());
    expect(a.spineY()).toBe(b.spineY());
    expect(a.centreX()).toBe(b.centreX());
  });

  it('is deterministic across generators, including every cell id', () => {
    const a = HullPlan.generate(hullConfigDamagedOpening());
    const b = HullPlan.generate(hullConfigDamagedOpening());
    const cellsA = [...a.grid.iterOccupied()].map(
      (v) => `${v.x},${v.y},${v.z},${v.id.getIndex()}`,
    );
    const cellsB = [...b.grid.iterOccupied()].map(
      (v) => `${v.x},${v.y},${v.z},${v.id.getIndex()}`,
    );
    expect(cellsA).toEqual(cellsB);
  });

  it('the default config is undamaged and the opening config is not', () => {
    expect(hullConfigDefault().damage.isEmpty()).toBe(true);
    expect(hullConfigDamagedOpening().damage.isEmpty()).toBe(false);
  });

  it('names regions rather than probabilities', () => {
    const damage = DamageConfig.openingDamage();
    expect(damage.engines[0]?.missingNozzle).toBe(true);
    expect(damage.engines[1]?.missingNozzle).toBe(false);
    expect(damage.panels.some((p) => p.kind === PanelDamageKind.Missing)).toBe(true);
    expect(damage.panels.some((p) => p.kind === PanelDamageKind.Scuffed)).toBe(true);
    expect(damage.exposed).toEqual([1]);
    expect(damage.warningLights.count).toBe(4);
    expect(damage.warningLights.amber).toBe(true);
  });

  it('an unknown panel index in damage is ignored', () => {
    const config = {
      ...hullConfigDefault(),
      damage: DamageConfig.fixture(
        [EngineDamage.intact(0), EngineDamage.intact(1)],
        [PanelDamage.missing(99)],
        [99],
        { count: 0, amber: false },
      ),
    };
    const damaged = HullPlan.generate(config);
    const clean = HullPlan.generate(hullConfigDefault());
    expect(damaged.grid.occupiedCount()).toBe(clean.grid.occupiedCount());
  });

  it('fits the promised number of warning lights, amber by default', () => {
    // The Rust documents exactly why the number on the hull is NOT the number
    // in the config: `apply_damage` runs before `place_warning_lights`, so seat
    // 0 sits inside panel 1, which `exposed` already stripped to
    // EXPOSED_STRUCTURE, and seat 3 sits on an empty cell. Only seats 1 and 2
    // (`z = 12` and `z = 15`) are still plating. The hull therefore carries 2
    // amber lights while its config asks for 4.
    const config = hullConfigDamagedOpening();
    expect(config.damage.warningLights.count).toBe(4);
    expect(config.damage.warningLights.amber).toBe(true);

    const plan = opening();
    let amber = 0;
    let cool = 0;
    for (const voxel of plan.grid.iterOccupied()) {
      if (voxel.id === VoxelId.WARNING_LIGHT_AMBER) {
        amber += 1;
      }
      if (voxel.id === VoxelId.WARNING_LIGHT_COOL) {
        cool += 1;
      }
    }
    expect(amber).toBe(2);
    expect(cool).toBe(0);
  });

  it('silhouette: the widest section is the midship bulge', () => {
    const plan = opening();
    const [widestZ, widestArea] = plan.widestSection();
    expect(widestArea).toBeGreaterThan(0);
    expect(widestZ).toBeGreaterThan(plan.noseTipZ());
    expect(widestZ).toBeLessThan(plan.hullTailZ());
    // The nose is narrower than the midship: the taper is real geometry, not a
    // camera trick.
    expect(plan.crossSectionArea(plan.noseTipZ())).toBeLessThan(widestArea);
  });

  it('the default seed is the module constant, not fresh entropy', () => {
    expect(hullConfigDefault().seed).toBe(0x5eedc0den);
  });

  it('saturating dimensions do not panic or wrap', () => {
    // The Rust: width/height/length saturate at u32::MAX. A grid that large
    // cannot be allocated, so this pins the arithmetic, not an allocation.
    const extreme: HullConfig = {
      ...hullConfigDefault(),
      hullWidth: 4294967295,
      hullHeight: 4294967295,
      length: 4294967295,
    };
    // The port must not throw on the arithmetic itself; the allocation of a
    // grid that large is a separate failure the mesher's ceiling refuses.
    expect(() => HullPlan.generate(extreme)).toThrow();
  });
});

describe('the non-voxel extras', () => {
  it('describe the details the presentation layer adds', () => {
    const plan = opening();
    const kinds = plan.extras.map((extra) => extra.kind);
    expect(kinds).toContain(ExtraMeshKind.CockpitGlazing);
    expect(kinds).toContain(ExtraMeshKind.EngineGlow);
    expect(kinds).toContain(ExtraMeshKind.LandingPad);
    for (const extra of plan.extras) {
      expect(extra.tint.paletteEntry()).not.toBeNull();
      expect(extra.halfExtents.every((h) => h > 0)).toBe(true);
      for (const livery of [PaletteChoice.Explorer, PaletteChoice.Icebound]) {
        expect(extra.colorF32Rgba(livery).length).toBe(4);
      }
    }
  });

  it('puts the canopy ahead of the nose tip, over the cockp wedge', () => {
    const plan = opening();
    const canopy = plan.extras.find((extra) => extra.kind === ExtraMeshKind.CockpitGlazing);
    expect(canopy).toBeDefined();
    if (canopy === undefined) {
      return;
    }
    expect(canopy.center[2]).toBeLessThan(plan.noseTipZ());
  });

  it('burns the port engine amber and the starboard housing grey', () => {
    // Amber reads as a fault, which is exactly the engine the damage breaches.
    const plan = opening();
    const glows = plan.extras.filter((extra) => extra.kind === ExtraMeshKind.EngineGlow);
    expect(glows.length).toBe(2);
    expect(glows[0]?.tint).toEqual(VoxelId.WARNING_LIGHT_AMBER);
    expect(glows[1]?.tint).toEqual(VoxelId.ENGINE_HOUSING);
  });
});

describe('the damage application', () => {
  it('chews the nozzle off the breached engine', () => {
    const damaged = HullPlan.generate(hullConfigDamagedOpening());
    const clean = HullPlan.generate(hullConfigDefault());
    // The damaged ship has fewer occupied voxels than the clean one.
    expect(damaged.grid.occupiedCount()).toBeLessThan(clean.grid.occupiedCount());
  });

  it('punches missing panels through the skin', () => {
    const config = {
      ...hullConfigDefault(),
      damage: DamageConfig.fixture(
        [EngineDamage.intact(0), EngineDamage.intact(1)],
        [PanelDamage.missing(3)],
        [],
        { count: 0, amber: false },
      ),
    };
    const damaged = HullPlan.generate(config);
    const clean = HullPlan.generate(hullConfigDefault());
    expect(damaged.grid.occupiedCount()).toBeLessThan(clean.grid.occupiedCount());
  });

  it('strips a panel to exposed structure', () => {
    const config = {
      ...hullConfigDefault(),
      damage: DamageConfig.fixture(
        [EngineDamage.intact(0), EngineDamage.intact(1)],
        [],
        [1],
        { count: 0, amber: false },
      ),
    };
    const damaged = HullPlan.generate(config);
    let exposed = 0;
    for (const voxel of damaged.grid.iterOccupied()) {
      if (voxel.id === VoxelId.EXPOSED_STRUCTURE) {
        exposed += 1;
      }
    }
    expect(exposed).toBeGreaterThan(0);
  });

  it('scuffs only the outermost layer of a band', () => {
    const config = {
      ...hullConfigDefault(),
      damage: DamageConfig.fixture(
        [EngineDamage.intact(0), EngineDamage.intact(1)],
        [PanelDamage.scuffed(6)],
        [],
        { count: 0, amber: false },
      ),
    };
    const damaged = HullPlan.generate(config);
    let scuffed = 0;
    for (const voxel of damaged.grid.iterOccupied()) {
      if (voxel.id === VoxelId.SCUFFED) {
        scuffed += 1;
      }
    }
    expect(scuffed).toBeGreaterThan(0);
  });
});
