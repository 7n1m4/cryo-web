# AGENTS

Working rules for `cryo-web`. Read this before editing anything.

## The engine

**The engine is Babylon.js. Do not use Three.js.** No import from `three`,
no `three` dependency, no re-export of a `three` type. If you find yourself
wanting a Three.js API, the Babylon analogue is: `Scene`/`Engine`,
`scene.activeCameras[]` for multi-camera, `camera.layerMask` for culling masks,
`VertexBuffer`/`setVerticesData` for attribute uploads, `scene.fog = new Fog()`
for linear distance fog, `Engine` constructed with `{ antialias: false }`.

## The layer rule

`src/sim/` and `src/ship/` are **pure and engine-free**. They import nothing
from `babylonjs`, `babylonjs-gui`, or `src/presentation/`, and they read no
clock, no filesystem and no randomness. They are the game, they are testable
with no renderer, and they are the reason the port exists.

Only `src/presentation/` and `src/app.ts` may import Babylon.

The boundary is **enforced by `tests/layers.test.ts`**, which reads every `.ts`
file under `src/sim/` and `src/ship/` and fails the build on any forbidden
import. Breaking the boundary fails CI. Verified: adding `import { Scene }
from 'three'` to any file under those directories turns that test red.

## Ported semantics that must not regress

- **The `<` vs `<=` asymmetry.** `beginActivity(Surveying)` allows charge **25**
  (the check is `suitCharge < 25`). `classifySuitability` calls charge **25**
  `Unsafe` immediately (the check is `charge <= 25`). Both are deliberate.
- **Clock overflow is an explicit error before mutation.** `advanceSingleStep`
  checks `checkedAdd` first and returns `PreconditionNotMet` with reason
  `simulation clock overflowed` without touching charge or survey data.
- **`saturating_sub`, `saturating_add`** in `geometryFor`: an extreme bounding
  box saturates at `u32::MAX` rather than wrapping.
- **`totalCmp` total ordering, NaN last.** Implements `f32::total_cmp`: every
  NaN sorts after every number, `-0` before `+0`. The `resolveCollision` and
  `nearestConsoleInView` tie-breaks depend on it.
- **`-Math.expm1(exponent)`, never `1 - Math.exp`.** At `dt = 1e-9` the `1 - e`
  form keeps no significant digits; `expm1` keeps all of them.
- **splitmix64 call order in `fillFittings`.** The four `rng.below` sites run in
  a fixed order (radiator z, radiator y-jitter, mount x, mount z) with the
  state advanced by `0x9E3779B97F4A7C15` and the output scrambled by the
  `0xBF58476D1CE4E5B9` / `0x94D049BB133111EB` shifts. All arithmetic is BigInt
  with explicit `& 0xFFFF_FFFF_FFFF_FFFF` masking.
- **`MAX_MESH_VERTICES = 65535`.** The cap is on *vertices*, because a `u16`
  index must still address vertex 65535. `meshHullOfGrid` refuses to exceed it.
- **`TooManyVertices` is a typed error caught at the render boundary.** It is
  not a panic and not a silent `u32` index type change. Presentation catches it.
- **Interior 1 cell = 1 metre; exterior 1 voxel = 0.1 metre.** They are separate
  scales, deliberately, and the presentation layer is where they meet.
- **`u8` → `f32` only at the GPU boundary.** The palette is integer `Rgb` all
  the way to `colorF32Rgba`, which is the only place a channel is divided by
  255.
- **Determinism is the point.** Same seed, same config, byte-identical mesh.
  Nothing in `src/sim/` or `src/ship/` may read a clock, the environment, or
  unseeded randomness.
- **`validate()` reports the first violation in table order.** The order is part
  of the contract: room names, portal names, portal pairs, connectivity, room
  overlap, console rooms, console placement, console clearance.
- **Warning lights: the config asks for 4, the shipped hull carries 2.**
  `applyDamage` runs before `placeWarningLights`, so seat 0 is already
  `EXPOSED_STRUCTURE` and seat 3 is empty. The rule is "on plating that damage
  left behind", not "the number in the config".

## The startup seam

`build(platform, initialState)` in `src/app.ts` is the only entry point a
platform calls. `platform` is the renderer. Tests pass a **null renderer**, so
`build` must construct the simulation, interior plan and hull, wire the input
state, and be fully usable without a canvas. No module-level engine singleton,
no renderer access at import time.

## Quality gates

```sh
npm run typecheck   # tsc --noEmit, strict + noUncheckedIndexedAccess
npm test            # vitest run, includes the layer-boundary test
npm run dev         # the dev harness
```

All three must pass before a change lands. The layer-boundary test is not
optional and is not a lint rule you may turn off.

## Dev loop

**Fast feedback is the entire reason this migration exists.** Never add a step
that type-checks or tests the whole project per change. Run the single test
file you are editing:

```sh
npx vitest run tests/interior.test.ts
```

Reserve `npm run typecheck` for the moment before you commit, not for every
edit. Keep the pure layers free of engine imports so a broken renderer never
blocks a simulation test.

## Test commands

| what | command |
|---|---|
| one file | `npx vitest run tests/simulation.test.ts` |
| everything | `npm test` |
| types | `npm run typecheck` |

Actual counts, from `vitest run`: `simulation.test.ts` 41,
`ship_voxel.test.ts` 50, `interior.test.ts` 49, `layers.test.ts` 5,
`app.test.ts` 12, `dev.harness.ts` 1. Total **158**.

## Headless verification

`npm run dev` (= `vitest run tests/dev.harness.ts`) is **not** a rendering smoke
test. It is an assertion-free harness that drives
`build(platform, initialState)` with a `null` renderer and prints: two seeded
simulations advancing, the clock-overflow refusal with its state before and
after, and the hull-mesh tally.

What it proves: the pure layers and the `build` seam run with no engine, no
canvas, no DOM, and no GPU; the simulation is deterministic; a hull meshes
(9864 vertices, 2466 quads, 5 extras) headlessly.

What it cannot prove: **nothing renders.** It does not construct a Babylon
engine, does not produce a frame, and does not exercise `createCameras`,
`uploadHullGeometry` or the fog. A `main.ts` change can break every pixel in the
game and `npm run dev` will still exit 0. Anything that must be verified about
rendering needs a real browser — do not claim it from this harness.

The harness lives in `tests/` and not `src/` because Node's
`--experimental-strip-types` cannot erase a TS `enum`, which the voxel palette
is full of, so it must go through vitest's transform.

