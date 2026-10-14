# CRYO (cryo-web)

CRYO rewritten in **TypeScript + Babylon.js**, as a port of the original
Rust/Bevy implementation.

## Run it

```sh
npm install      # one runtime dependency: babylonjs
npm test         # 145 tests, vitest
npm run typecheck
npm run dev      # headless dev harness (no GPU needed)
```

## Architecture in a few lines

```
src/sim/           the simulation, engine-free and testable  (ported from Rust)
src/ship/          the voxel hull and the interior, engine-free  (ported from Rust)
src/presentation/  Babylon.js: cameras, hull mesh upload, fog, HUD
src/app.ts         the `build(platform, initialState)` startup seam
tests/             vitest, including the enforced layer-boundary test
```

**The engine is Babylon.js, not Three.js.** `src/sim/` and `src/ship/` are pure:
no engine import, no clock, no filesystem, no unseeded randomness. The boundary
is enforced by `tests/layers.test.ts` and breaking it fails CI.

See `AGENTS.md` for the full rules, including the ported semantics that must not
regress.

## What is ported

Ported faithfully from the Rust, with tests that transcribe the original test
suites:

- **Simulation** (`src/sim/simulation.ts`): `SimTime`/`Seed`/`Simulation`,
  `Activity`, snapshots, `TransitionError`, the site-suitability classifier,
  the `<` vs `<=` charge asymmetry, and the clock-overflow check that returns an
  error before mutating anything.
- **Voxel hull** (`src/ship/voxel.ts`): the palette, `VoxelGrid`,
  splitmix64 `Rng`, `HullPlan::generate`, face-culling mesher, the
  `MAX_MESH_VERTICES = 65535` ceiling and its typed error, the non-voxel extras.
- **Interior** (`src/ship/interior.ts`): rooms, portals, consoles,
  `validate()` with its eight checks in contract order, `resolveCollision`,
  `integrateMovement`'s frame-rate-independent exponential curves, and
  `nearestConsoleInView`.

**Tests: 145 passing** (simulation 41, voxel 50, interior 49, layer boundary 5).

## What is NOT ported yet

- The presentation layer is a stub-only tree right now — the Babylon camera
  composition, hull mesh upload, fog, HUD and input are not yet written. The
  engine decision is Babylon, and `src/presentation/` is reserved for it.
- `src/ship/interior.ts` has no `nearestConsoleInView` tie-break test against a
  constructed two-console equidistance fixture — the distance-zero and
  behind-the-player guards are tested, the exact tie is not.
- Nothing reads or writes a save file; the snapshot round-trip is exercised in
  memory only.
