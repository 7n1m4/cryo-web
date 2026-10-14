# CRYO (cryo-web)

CRYO rewritten in **TypeScript + Babylon.js**, as a port of the original
Rust/Bevy implementation.

## Run it

```sh
npm install       # one runtime dependency: babylonjs
npm test          # 243 tests, 11 files, vitest
npm run typecheck # tsc --noEmit, strict
npm run dev       # the headless smoke harness
```

## Architecture in a few lines

```
src/sim/           the simulation, engine-free and testable      (ported from Rust)
src/ship/          the voxel hull and the interior, engine-free  (ported from Rust)
src/game/          the state machine and the frame order, engine-free
                                                               (ported from Rust)
src/presentation/  13 Babylon.js modules: camera stack, hull upload, orbit,
                   walker, materials, lights, fog, extras, HUD, input
src/title.ts       the title screen's DOM and its one-shot start button
src/app.ts         the `build(platform, initialState, views)` startup seam
src/main.ts        the browser entry: canvas, engine, two scenes, render loop
tests/             vitest, including the enforced layer-boundary test
```

**The engine is Babylon.js, not Three.js.** `src/sim/`, `src/ship/` and
`src/game/` are pure: no engine import, no clock, no filesystem, no unseeded
randomness. The boundary is enforced by `tests/layers.test.ts` over all three
directories and breaking it fails CI.

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
  `integrateMovement`'s frame-rate-independent exponential curves,
  `nearestConsoleInView`, and the geometry both the collision and (in the Rust)
  the meshes come from — `interiorSlabs`, `walkableWalls`.
- **Game layer** (`src/game/`): the four-state machine in `state.ts`, Bevy's
  request-frame semantics and the declared system order in `step.ts`, the
  `set_if_different` transition matrix in `transitions.ts`, the two read-only
  scene views and the flat boarding/inspect constants in `sceneView.ts`, and
  the session reading progress in `interiorProgress.ts`.

Tests, per file, counted from the `vitest run` output:

| file | tests |
|---|---|
| `tests/simulation.test.ts` | 41 |
| `tests/ship_voxel.test.ts` | 50 |
| `tests/interior.test.ts` | 55 |
| `tests/game.test.ts` | 30 |
| `tests/layers.test.ts` | 10 |
| `tests/app.test.ts` | 12 |
| `tests/player.test.ts` | 16 |
| `tests/frameMath.test.ts` | 12 |
| `tests/sceneData.test.ts` | 13 |
| `tests/extras.test.ts` | 3 |
| `tests/dev.harness.ts` | 1 (assertion-free) |
| **total** | **243** |

## The presentation layer, honestly

`src/presentation/` is written, not a stub. Thirteen modules, and none of them
has produced a pixel: everything below is either pure arithmetic asserted with
no renderer at all, or Babylon wiring asserted under Babylon's `NullEngine`,
which is a null engine and not a canvas. `src/main.ts` is the only file that
builds a real `Engine`, and no test runs it.

| module | what it does | what it does NOT do |
|---|---|---|
| `frameMath.ts` | the hull's plan-to-world arithmetic: `VOXEL_SCALE`/0.1 decimetre lattice, the resting pitch and bank, the model transform that centres and heels the hull over its pads, `contactPoint`, `lowestHeave`, `restingHeight`, `cameraTarget`/`cameraPosition`, `hullBoundingRadius`, `OPENING_HULL_CONFIG`. Pure functions over `HullPlan`/`ShipMesh`. | Does not create a mesh or a camera, does not touch the DOM, and is never the renderer — a consumer multiplies the transform itself. |
| `orbit.ts` | the third-person orbit as one flat value: elevation and distance clamps (`ORBIT_MIN_ELEVATION` 4°, `ORBIT_MAX_ELEVATION` 85°, `ORBIT_NEAR_HULLS` 1.3, `ORBIT_FAR_HULLS` 6.0), `orbitDragged`, `orbitZoomed`, `orbitNearestTo`, and the resting orbit a plan implies. | Does not hold a Babylon camera, does not listen for pointer or wheel events, and does not know which state the game is in. The wiring is `main.ts`. |
| `player.ts` | the interior walker: `wishDirection`, `stepPlayer` (the ship layer's own `integrateMovement` then `resolveCollision`), `playerCell`, `inspectedConsole`, `eyePosition`, `hatchInteriorCell`, and the hull-derived `boardingStation`. A port of the walk half of `interior_scene.rs`, kept Babylon-free. | Does not own the keyboard — the held-key snapshot is a parameter — and does not read a clock, so frame-rate independence is testable rather than hoped for. |
| `materials.ts` | the material and extras decisions, as data: `HULL_MATERIAL` (white base, no emissive, roughness 0.55), `GLAZING_ALPHA` 0.45, `ENGINE_GLOW_EMISSIVE_SCALE`, `BEACON_RANGE` 6.0, `BEACON_RADIUS` 0, `emissiveFor`, `placeExtras`, `beaconSites`. | Does not build a material or a mesh. The wiring is `extras.ts`. |
| `lights.ts` | both light sets, as data: `EXTERIOR_SUN`/`EXTERIOR_AMBIENT`, `BEACON_INTENSITY` 300 000, the per-room lamps (`roomLights`, `roomLightColor`, `roomLightRange`, `roomCentre`). Every light is shadow-free in both sets. | Does not create a Babylon light and does not touch the engine's ambient term; `main.ts` is where those become objects. |
| `fog.ts` | the fog band from the hull's own length (1.5 to 6 hull lengths), `FOG_COLOR_LINEAR`, `GROUND_HALF_EXTENT` 400, and the interior's exemption from the exterior's fog — `INTERIOR_MESHES_ARE_FOG_EXEMPT` true, `INTERIOR_SEES_EXTERIOR_FOG` false. | Does not set `scene.fogMode` and does not create the ground plane the fog is tuned against. |
| `extras.ts` | the Babylon wiring for the five non-voxel details: one box per detail, centred through the model transform, a `PBRMaterial` per detail, `alpha` on the glazing and an emissive term on the engine glow. | Does not prove appearance. `tests/extras.test.ts` asserts the wiring under `NullEngine`; no pixel has been produced. |
| `cameraStack.ts` | `createCameras(scene)` builds three `TargetCamera`s with distinct `layerMask` bits (title 1, exterior 2, interior 4), per-camera near/far/fov from `CAMERA_STACK_CONTRACT`, sets `scene.autoClear = false` so the title camera clears and the rest composite, and **throws if two masks collide** — the Rust `single_mut` collision, made loud instead of silent. `engineOptions`/`engineMatchesContract` carry the Rust's MSAA-off and `PixelRatio(1)` contract. | Does not create the engine, does not render, and does not wire the fog. `engineMatchesContract` is asserted by nothing — it is a self-check waiting for a real `Engine` to check against. |
| `hullUpload.ts` | flattens the mesher's positions/normals and 4-component colours into `Float32Array`s, converts indices to `Uint16Array`, refuses with the typed `TooManyVertices` error when they will not fit, and uploads via `setVerticesData`/`setIndices`. | Does not create the `Mesh` — the caller owns and disposes it — and does not build the extras, which are separate meshes. |
| `hud.ts` | the DOM overlay: `formatHudStatus` renders `t{n} · {activity} · suit {n}%`, `setHudText` and `setTitleVisible` write to elements, all no-ops when there is no `document`. | Is **not** `babylonjs-gui`. Does not show the console readout: the game layer carries the readout state and nothing displays it. |
| `title.ts` | the title screen's DOM: the start button beside the prompt, `pressStartButton`/`consumeStartClick` as a one-shot consumed edge, `mountTitle` (idempotent) and `setTitleVisible`. | Does not read or write the simulation. Every function is a no-op without a `document`, which is what keeps the game layer testable with no DOM. |
| `inputTypes.ts` | `InputState`/`InputFrame` and `InputTracker`'s edge detection: `press`, `release`, `state`, `endFrame`. A key held across two frames is in `held` on both but in `pressedThisFrame` on only the first. | Does not bind any key and does not know what a key means. |
| `input.ts` | `START_KEYS`, `frameWantsStart`, `walkFrame` — an `InputState` read into a walk frame. | Nothing imports it yet. The game layer owns its own start-key set (`src/game/transitions.ts`) and `main.ts` builds the walker's held keys itself. |

`src/main.ts` is the one file that touches a canvas. It builds the `Engine`,
composes the camera stack, uploads the hull, sets the exterior's fog and sun and
ambient from the tables above, builds the extras, builds the interior's rooms
and their lamps, wires the DOM listeners, and runs the render loop. It is
deliberately **not tested**: it needs a canvas, and none of its work is verified
by any test in this repo. What keeps it honest is that the arithmetic it calls —
`orbitFromPlan`, `stepPlayer`, `orbitDragged`, `boardingStation` — is typed
strictly and asserted against the Rust elsewhere.

## What is NOT ported yet

Two headline gaps, and the render-side specifics behind the first one. Every
item below was verified by reading the source, not by running the game.

**Rendering is unverified.** No engine has been constructed in this repo's
verification, no frame has been produced, and no pixel has been seen. Every
Babylon claim in the table above is a claim about code, not about output.

**The interior's geometry is coarser than the Rust's.** `main.ts` draws **one
box per room** from `plan.rooms`. The Rust renders `interior_slabs` — 38 slabs
for the shipped plan, which `src/ship/interior.ts` already exposes and
`walkableWalls` collapses onto their surfaces — plus per-console body and screen
boxes, the console readout panel, and the mouse-capture hint. None of those
exist here. Specifically, verified in the code:

- no console meshes: the interior is room boxes only, so no console is visible
  even though the game layer tracks which ones have been read.
- no readout panel: `flow.readout` is maintained by the game layer and nothing
  in `src/` displays it.
- no ground plane: `GROUND_HALF_EXTENT = 400` is data and is asserted in
  `tests/sceneData.test.ts`, but `main.ts` creates no ice mesh, so the exterior
  is a hull over a clear colour rather than over ice.
- no beacon lights: `beaconSites` and `BEACON_INTENSITY` are data and asserted,
  and `main.ts` builds only the sun and the per-room lamps.
- no interior ambient term: `INTERIOR_AMBIENT_BRIGHTNESS` is data and asserted;
  `main.ts` sets `ambientColor` on the exterior scene only.
- no pointer lock or cursor grab: the Rust captures the cursor in the interior
  and releases it on `Escape`. The port turns the view with a drag over a 4-pixel
  threshold, so the mouse cursor stays visible.

These are visual-fidelity and behaviour gaps, not correctness ones, and every one
of them needs a real browser to confirm — which is exactly what this repo cannot
do.

Smaller gaps, also verified:

- No save file. The snapshot round-trip is exercised in memory only
  (`simulation.test.ts`); nothing reads or writes `localStorage` or a file.
- `nearestConsoleInView`'s exact two-console equidistant tie is not tested. The
  distance-zero and behind-the-player guards are; the constructed equidistance
  fixture is not.
- `engineMatchesContract` in `cameraStack.ts` has no caller, so the MSAA and
  device-ratio contract is written but not checked at runtime.

## Headless verification

`npm run dev` is **not** a rendering smoke test. It runs
`tests/dev.harness.ts` through vitest, which drives
`build(platform, initialState)` with a `null` renderer and prints four things:
two seeded simulations advancing, the clock-overflow refusal with its
before-and-after state, and the hull-mesh tally. **It never constructs a Babylon
engine and never renders.**

`tests/extras.test.ts` goes one step further and builds real boxes and materials
under Babylon's `NullEngine`. That proves the *wiring* runs — sizes, placements,
materials, alpha — and nothing about how any of it looks: a `NullEngine` has no
GPU, no framebuffer and no pixels.

See `AGENTS.md`.

## License

MIT. See `LICENSE`.
