# CRYO (cryo-web)

CRYO rewritten in **TypeScript + Babylon.js**, as a port of the original
Rust/Bevy implementation.

## Run it

```sh
npm install       # one runtime dependency: babylonjs
npm test          # 158 tests, vitest
npm run typecheck # tsc --noEmit, strict
npm run dev       # the headless smoke harness
```

## Architecture in a few lines

```
src/sim/           the simulation, engine-free and testable  (ported from Rust)
src/ship/          the voxel hull and the interior, engine-free  (ported from Rust)
src/presentation/  Babylon.js: camera stack, hull upload, HUD, input
src/app.ts         the `build(platform, initialState)` startup seam
src/main.ts        the browser entry: canvas, engine, scene, render loop
tests/             vitest, including the enforced layer-boundary test
```

**The engine is Babylon.js, not Three.js.** `src/sim/` and `src/ship/` are pure:
no engine import, no clock, no filesystem, no unseeded randomness. The boundary
is enforced by `tests/layers.test.ts` and breaking it fails CI.

See `AGENTS.md` for the full rules, including the ported semantics that must not
regress.

## Ported from Rust, and tested

Ported faithfully from the Rust, with the original test suites transcribed:

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

Tests, per file, counted from the `vitest run` output:

| file | tests |
|---|---|
| `tests/simulation.test.ts` | 41 |
| `tests/ship_voxel.test.ts` | 50 |
| `tests/interior.test.ts` | 49 |
| `tests/layers.test.ts` | 5 |
| `tests/app.test.ts` | 12 |
| `tests/dev.harness.ts` | 1 (assertion-free) |
| **total** | **158** |

## The presentation layer, honestly

`src/presentation/` is written, not a stub, but it is **not rendered-verified**
— nothing here has been run against a real GPU or canvas. Everything below is
type-checked and called from typed call sites; none of it has produced pixels.

| module | what it does | what it does NOT do |
|---|---|---|
| `constants.ts` | every number the render layer owns: voxel scale, fog band and colour, camera near/far/fov, orbit and look clamps, eye height, spawn cell | — |
| `cameraStack.ts` | `createCameras(scene)` builds three `TargetCamera`s with distinct `layerMask` bits (1/2/4), sets `scene.autoClear = false` so the title camera clears and the rest composite, and **asserts the three masks are distinct** — the Rust `single_mut` collision, made loud instead of silent. | Does not create an engine, does not render, does not wire the fog (that is `main.ts`). `engineMatchesContract` reads Babylon's `getCaps()` and is called by nothing yet. |
| `hullUpload.ts` | flattens the mesher's positions/normals (scaled by `VOXEL_SCALE`) and 4-component colours into the `Float32Array`s a Babylon mesh uploads, converts indices to `Uint16Array` and returns the typed `TooManyVertices` error when they will not fit, uploads via `setVerticesData`/`setIndices`, and measures `hullLength` from the uploaded geometry. | Does not create the `Mesh` itself, does not build materials (so **no material with `alpha = 0.45` for glazing, and no `backFaceCulling` setting, exists yet**), and does not add the extras (canopy, engine glow, pads) to the scene. |
| `hud.ts` | `formatHudStatus` renders the `t{n} · {activity} · suit {n}%` line; `setHudText`/`setTitleVisible` write to the DOM, both no-ops when `document` is undefined. | A **DOM overlay**, not `babylonjs-gui`. Does not update per frame yet — `main.ts` writes it once at startup. |
| `input.ts` / `inputTypes.ts` | `InputTracker` records held keys and edges a key to exactly one frame; `frameWantsStart` and `walkFrame` turn that into intent. | Not wired to any real keyboard listener yet — no DOM event handlers exist, so nothing is actually reachable in the browser. |
| `orbit.ts` / `player.ts` | **do not exist.** | The ship orbit camera, first-person walk/look, pointer lock, boarding, and the interior mesh are not written at all. |

`src/main.ts` is the one file that touches a canvas. It builds the engine with
`antialias: false`, composes the camera stack, uploads the hull mesh, sets the
exterior fog from the uploaded hull's own length, and runs the render loop. It
is deliberately **not tested**: it needs a canvas, and none of its work is
verified by any test in this repo.

## What is NOT ported yet

- The orbit camera and first-person walk: `presentation/orbit.ts` and
  `presentation/player.ts` from the Rust were not written, so the exterior is a
  fixed camera and the interior is a fixed camera.
- No materials are built: the hull's glazing has no `alpha = 0.45` material and
  `backFaceCulling` is not set per the Rust.
- The non-voxel extras (canopy, engine glow, landing pads) are meshed in the port
  and counted by tests, but never added to the scene.
- The HUD is written once at startup rather than updated per frame, and no key or
  pointer listener is registered, so the browser build shows a static frame.
- Fog is wired: `main.ts` calls `fogBand(hullLength(mesh))` and gets the band
  from the hull it actually uploaded. It is set only on the scene, not on the
  interior camera separately, so **the interior camera currently sees the
  exterior's fog** — the Rust keeps the interior clean.
- No mouse-look, no pointer lock, no sprint, no console inspection prompt.
- `src/ship/interior.ts` has no `nearestConsoleInView` tie-break test against a
  constructed two-console equidistance fixture — the distance-zero and
  behind-the-player guards are tested, the exact tie is not.
- Nothing reads or writes a save file; the snapshot round-trip is exercised in
  memory only.

## Headless verification

`npm run dev` is **not** a rendering smoke test. It runs
`tests/dev.harness.ts` through vitest, which drives
`build(platform, initialState)` with a `null` renderer and prints four things:
two seeded simulations advancing, the clock-overflow refusal with its
before-and-after state, and the hull-mesh tally. **It never constructs a Babylon
engine and never renders.** See `AGENTS.md`.
