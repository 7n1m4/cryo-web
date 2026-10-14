# AGENTS

Working rules for `cryo-web`. Read this before editing anything.

## The engine

**The engine is Babylon.js. Do not use Three.js.** No import from `three`,
no `three` dependency, no re-export of a `three` type. If you find yourself
wanting a Three.js API, the Babylon analogue is: `Scene`/`Engine`,
`scene.activeCameras[]` for multi-camera, `camera.layerMask` for culling masks,
`VertexBuffer`/`setVerticesData` for attribute uploads,
`scene.fogMode = Scene.FOGMODE_LINEAR` with `fogStart`/`fogEnd`/`fogColor` for
linear distance fog, `Engine` constructed with `{ antialias: false }`.

## The layer rule

`src/sim/`, `src/ship/` and `src/game/` are **pure and engine-free**. They
import nothing from `babylonjs`, `babylonjs-gui`, or `src/presentation/`, and
they read no clock, no filesystem and no randomness. They are the game, they are
testable with no renderer, and they are the reason the port exists.

Only `src/presentation/` and `src/app.ts` may import Babylon, and
`src/app.ts` may import anything because it is the seam both halves meet at.

**The dependency direction is one-way.** `src/presentation/` may import
`src/game/`; `src/game/` may never import `src/presentation/`. The game layer
decides *when* a key press means something and the presentation layer decides
*where the camera and the player are*, so the whole contract between them is the
two read-only getters and the constants in `src/game/sceneView.ts`. The one
exception the port allows itself is that `main.ts` supplies the two view objects
through `build(platform, initialState, views)` — the presentation layer closes
over its own Babylon state and hands the game layer a getter, which is the
opposite direction to an import and is why it is legal.

The boundary is **enforced by `tests/layers.test.ts`**, which reads every `.ts`
file under `src/sim/`, `src/ship/` and `src/game/` and fails the build on any
forbidden import: a static, dynamic or CommonJS import of `babylonjs`,
`babylonjs-gui`, `babylonjs-loaders` or `three`, or a static import of anything
naming the presentation layer. It also fails if any of the three directories
ever goes quiet: `simFiles`, `shipFiles` and `gameFiles` must all be non-empty,
because a boundary nobody walks is a boundary nobody enforces. A fourth test
asserts the presentation layer is allowed to break the boundary in the other
direction, so a future tightening has to be deliberate.

Breaking the boundary fails CI. Verified: adding `import { Scene }
from 'three'` to any file under those three directories turns that test red.

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
- **The Bevy request-frame semantics.** A transition request written by this
  frame's systems is invisible to this frame: `stepFrame` runs the state's
  systems first and applies `flow.requested` — written by the *previous* frame —
  before them. Pinned by `a_request_takes_zero_steps_on_its_own_frame_and_one_`_
  `on_the_next`: the request frame takes **0** steps, the next frame applies the
  transition and takes **exactly 1**. `set_if_different` is the belt: a request
  for the state the game is already in is dropped, so repeated start input
  mid-game cannot re-queue a transition.
- **`advancesSimulation` is true only for `exterior`.** `GAME_STATES` in
  declaration order is `title, exterior, interior, paused` and only the second
  advances the clock, so `only_in_game_advances_the_simulation` reads
  `[false, true, false, false]`. Interior is inert deliberately: interior time is
  not exterior time, and a clock running in the dark would spend suit charge
  with no frame loop to justify it. Paused is frozen but still inspectable.
- **The title screen reads the simulation and never writes it.** Its one system
  is `start`; nothing in `src/title.ts` touches the simulation, and the state it
  hands `app.ts` is a consumed one-shot click, not simulation state.
- **`just_pressed`-style one-shot intents.** A held key must not fire every
  frame. `InputTracker.press` drops an OS repeat on a key already down,
  `endFrame` clears the edge list, and `consumeStartClick` clears the button's
  flag — so "press start" boots the survey once, not sixty times a second.
- **`GAME_STATES` is a const tuple plus a `Record<GameState, Handler>`.** The
  exhaustiveness Bevy's state enum gives at compile time is weaker in TypeScript
  (a `switch` is not checked spread across a module), so it is bought back with a
  table: `GAME_STATES` is `as const`, `GameState` is derived from it, and
  `GAME_STATE_HANDLERS` is `Readonly<Record<GameState, GameStateHandler>>`. Adding
  a variant to the tuple without a table entry is a compile error at the table
  and at every consumer of it, and nowhere else. `state_labels_every_variant,`_
  `the_way_state_label_does` and `the_state_table_answers_for_every_variant` are
  the runtime witnesses that the table is still complete and still in
  declaration order.
- **`FRAME_PHASES` and `SYSTEM_ORDER` are a declared order that tests assert
  against.** The four phases are `input, transitions, systems, render-sync` —
  Bevy's `PreUpdate`-ish input edging, `StateTransition`, `Update` in the Rust's
  own registration order, and `PostUpdate`. `declares_four_phases_and_six_`_
  `systems_in_registration_order` pins both literals: `advance-simulation`,
  `inspect-console`, `close-readout`, `airlock-transition`, `board-the-hull`,
  `start`. A port that runs them in a different order is a port that can behave
  differently, which is why the order is a value and not an accident of the
  call sites.
- **The boarding and inspect constants are flat, and they are genuine Rust
  ports.** `BOARDING_RANGE = 0.6` is the Rust's own `BOARDING_RANGE`
  (`interior_scene.rs:1684`), a tolerance around a boarding station the
  presentation layer derives from the hull and the orbit's reachability clamps —
  never a substitute for standing on it. `INSPECT_RANGE = 1.6` cells and
  `INSPECT_CONE_COS = 0.5` (`cos 60°`) are the Rust's
  (`interior_scene.rs:278` and `:287`), and the unit is *cells*: one interior
  cell is one metre, which is the reach of a standing body with an arm out. None
  of these is an invented value, and `BOARDING_RANGE` deliberately lives in
  `src/game/sceneView.ts` rather than in `presentation/constants.ts`, because the
  game layer owns the trigger and therefore the threshold the trigger is
  compared against.

## The startup seam

`build(platform, initialState, views = NO_VIEWS)` in `src/app.ts` is the only
entry point a platform calls. `platform` is the renderer. Tests pass a **null
renderer**, so `build` must construct the simulation, interior plan and hull, wire
the input state, and be fully usable without a canvas. No module-level engine
singleton, no renderer access at import time.

`views` is the seam to the scenes the game drives: the exterior's orbit camera
and the interior's player body. It defaults to `NO_VIEWS` so a headless build
passes nothing, and a build with no views still runs every system — the boarding
and inspect triggers simply find no scene to ask. `src/main.ts` supplies the real
one, built from the Babylon state that only it owns.

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

Actual counts, measured per file from `vitest run`:

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
| **total, 11 files** | **243** |

Re-measure from the vitest output rather than from this table; do not copy a
number from here into a test's name or into a doc that will be checked again.

## Headless verification

`npm run dev` (= `vitest run tests/dev.harness.ts`) is **not** a rendering smoke
test. It is an assertion-free harness that drives
`build(platform, initialState)` with a `null` renderer and prints: two seeded
simulations advancing, the clock-overflow refusal with its state before and
after, the HUD line, and the hull-mesh tally.

**`npm run dev` constructs no Babylon engine and renders nothing.** It cannot
verify a single thing about rendering: not the engine options, not `createCameras`,
not `uploadHullGeometry`, not the fog, not the extras. A `main.ts` change can
break every pixel in the game and `npm run dev` will still exit 0.

`tests/extras.test.ts` is the closest the repo gets, and it is not far: it builds
real boxes and real `PBRMaterial`s under Babylon's `NullEngine`, which proves the
*wiring* runs — sizes, placements, materials, alpha, emissive terms — and nothing
about appearance. A `NullEngine` has no GPU, no framebuffer and no pixels.

What the headless run does prove: the pure layers and the `build` seam run with
no engine, no canvas, no DOM, and no GPU; the simulation is deterministic; a hull
meshes headlessly (9864 vertices, 2466 quads, 5 non-voxel details); and the game
layer's transitions, systems and frame semantics are driven by hand.

Anything that must be verified about how the game *looks* needs a real browser,
which this environment does not have. Do not claim it from any harness here.

The harness lives in `tests/` and not `src/` because Node's
`--experimental-strip-types` cannot erase a TS `enum`, which the voxel palette
is full of, so it must go through vitest's transform. The 1 test it reports is
the harness itself running; the assertions, such as they are, are the printed
lines.

## License

Everything here is MIT (see `LICENSE`). Do not add a file that carries a
different license header: a new file is MIT by default.


