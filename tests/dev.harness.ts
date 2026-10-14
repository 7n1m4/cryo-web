/**
 * The dev harness: the game, headless, with a clock the operator controls.
 *
 * It exists so `npm run dev` shows real frames advancing with no GPU, no
 * window and no browser — and so the whole vertical slice can be exercised
 * with nothing but `npx vitest`. Run it with:
 *
 * ```sh
 * npm run dev
 * ```
 *
 * It drives the same `build(platform, initialState)` seam the browser build
 * drives, with a `null` renderer, which is the proof that the seam is honest:
 * a harness that needed a canvas would be a harness that could not check
 * anything.
 */

import { it } from 'vitest';

import { build } from '../src/app.ts';
import type { Platform } from '../src/app.ts';
import { formatHudStatus } from '../src/presentation/hud.ts';
import { Activity, Seed, Simulation, SimTime, U64_MAX } from '../src/sim/simulation.ts';

/** A platform with nothing in it. Everything the app needs is pure. */
const HEADLESS: Platform = { engine: null, scene: null };

/** Advances a seeded app and reports each step, formatted for the terminal. */
function play(seed: bigint, steps: bigint): void {
  const app = build(HEADLESS, { seed });
  console.log(`seed ${seed}: start t${app.simulation.getTime().getTicks()} activity=${app.simulation.getActivity()}`);

  const error = app.advanceSimulation(steps);
  if (error !== null) {
    console.log(`  advance refused: ${error.kind}`);
    return;
  }
  console.log(
    `  advanced ${steps} steps to t${app.simulation.getTime().getTicks()} ` +
      `suit=${app.simulation.getSuitCharge()}% survey=${app.simulation.getSurveyData()}`,
  );

  const begun = app.simulation.beginActivity(Activity.Surveying);
  console.log(
    begun === null
      ? '  surveying begins'
      : `  surveying refused: ${begun.kind}${begun.kind === 'PreconditionNotMet' ? ` (${begun.reason})` : ''}`,
  );
}

/** The clock overflow, demonstrated: the refusal, and the mutation that did not happen. */
function demonstrateOverflow(): void {
  // Built from a snapshot at the clock's very top rather than by stepping
  // there: `advance` is a loop over single steps, and winding a clock to
  // u64::MAX one step at a time is a very slow way to make the same point.
  const atTop = Simulation.fromSnapshot(
    {
      time: SimTime.fromTicks(U64_MAX),
      activity: Activity.Resting,
      suitCharge: 90,
      surveyData: 0n,
      stepsCompleted: 0n,
    },
    Seed.new(0n),
  );
  const refused = atTop.advance(1n);
  console.log(
    refused === null
      ? '  one step past u64::MAX succeeded (WRONG: the clock wrapped)'
      : `  one step past u64::MAX refused: ${refused.kind} — the clock did not wrap`,
  );
  console.log(
    `  clock is still t${atTop.getTime().getTicks()}, ` +
      `suit still ${atTop.getSuitCharge()}%`,
  );
}

/** The HUD line and the mesh tally. */
function demonstrateHud(): void {
  const app = build(HEADLESS, { seed: 3n, state: 'interior' });
  app.simulation.beginActivity(Activity.Surveying);
  app.advanceSimulation(4n);
  console.log(
    formatHudStatus({
      clock: `t${app.simulation.getTime().getTicks()}`,
      activity: app.simulation.getActivity(),
      suitCharge: app.simulation.getSuitCharge(),
    }),
  );
  console.log(
    `hull mesh: ${app.hullMesh.positions.length} vertices, ` +
      `${app.hullMesh.indices.length / 6} quads, ` +
      `${app.hullMesh.extras.length} non-voxel details`,
  );
}

it('the dev harness runs the vertical slice headlessly', () => {
  play(0n, 12n);
  play(7n, 40n);
  demonstrateOverflow();
  demonstrateHud();
});
