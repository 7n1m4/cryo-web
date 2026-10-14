/**
 * The dev harness: the game, headless, with a clock the operator controls.
 *
 * It exists so `npm run dev` shows real frames advancing without a GPU, a
 * window, or an installed browser — and so the whole vertical slice can be
 * exercised with nothing but `node`. Run with:
 *
 * ```sh
 * npm run dev
 * ```
 *
 * It drives the same `build(platform, initialState)` seam the browser build
 * drives, with a `null` renderer, which is proof the seam is honest.
 */

import { build } from './app.ts';
import type { Platform } from './app.ts';
import { formatHudStatus } from './presentation/hud.ts';
import { Activity, U64_MAX } from './sim/simulation.ts';

/** A platform with nothing in it. Everything the app needs is pure. */
const HEADLESS: Platform = { engine: null, scene: null };

/** Advances the app and reports each step, formatted for the terminal. */
function play(seed: bigint, steps: bigint): void {
  const app = build(HEADLESS, { seed });
  const clock = (): string => `t${app.simulation.getTime().getTicks()}`;
  console.log(`seed ${seed}: start ${clock()} activity=${app.simulation.getActivity()}`);

  const error = app.advanceSimulation(steps);
  if (error !== null) {
    console.log(`  advance refused: ${error.kind}`);
    return;
  }
  console.log(
    `  advanced ${steps} steps to ${clock()} activity=${app.simulation.getActivity()} ` +
      `suit=${app.simulation.getSuitCharge()}% survey=${app.simulation.getSurveyData()}`,
  );

  const begun = app.simulation.beginActivity(Activity.Surveying);
  console.log(
    begun === null
      ? `  surveying begins`
      : `  surveying refused: ${begun.kind}${begun.kind === 'PreconditionNotMet' ? ` (${begun.reason})` : ''}`,
  );
}

/** The clock overflow, demonstrated. */
function demonstrateOverflow(): void {
  const app = build(HEADLESS, { seed: 0n });
  // Wind the clock to the very top, then try to step past it.
  const error = app.advanceSimulation(U64_MAX);
  console.log(`wind to u64::MAX: ${error === null ? 'ok' : error.kind}`);
  const refused = app.advanceSimulation(1n);
  console.log(
    refused === null
      ? '  one more step succeeded (WRONG: the clock wrapped)'
      : `  one more step refused: ${refused.kind} — the clock did not wrap, and nothing mutated`,
  );
  console.log(`  clock is still t${app.simulation.getTime().getTicks()}`);
}

/** The HUD line, formatted exactly as the DOM overlay formats it. */
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
  console.log(`hull mesh: ${app.hullMesh.positions.length} vertices, ${app.hullMesh.indices.length / 6} quads`);
}

play(0n, 12n);
play(7n, 40n);
demonstrateOverflow();
demonstrateHud();
