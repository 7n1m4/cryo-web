/**
 * The simulation port: a faithful transcription of the Rust
 * `src/game/simulation.rs` and `src/game/suitability.rs` tests.
 *
 * Every test below corresponds to one Rust test in those files. The invariants
 * they pin are the ones the Rust doc comments promise, so a regression here is a
 * regression against the port, not a regression against an idea.
 */

import { describe, expect, it } from 'vitest';

import {
  Activity,
  MAX_SUIT_CHARGE,
  MIN_SURVEY_SUIT_CHARGE,
  REST_CHARGE_PER_STEP,
  Seed,
  SimTime,
  Simulation,
  Suitability,
  SuitabilityClass,
  U64_MAX,
  classifySuitability,
  snapshotEquals,
  suitabilityIsOperational,
  suitabilityReason,
  activityIsExposed,
  transitionErrorMessage,
  CLOCK_OVERFLOW_REASON,
  LOW_CHARGE_REASON,
  type Snapshot,
} from '../src/sim/simulation.ts';

/** A built simulation at genesis for a given seed. */
function genesis(seed = 0n): Simulation {
  return Simulation.genesis(Seed.new(seed));
}

describe('SimTime', () => {
  it('starts at genesis as zero', () => {
    expect(SimTime.ZERO.getTicks()).toBe(0n);
  });

  it('builds from and reports ticks', () => {
    expect(SimTime.fromTicks(9n).getTicks()).toBe(9n);
  });

  it('renders as t{n}, matching the Rust Display', () => {
    expect(SimTime.ZERO.toString()).toBe('t0');
    expect(SimTime.fromTicks(12n).toString()).toBe('t12');
  });

  it('reports overflow instead of wrapping', () => {
    // The Rust: `SimTime::from_ticks(u64::MAX).checked_add(1).is_none()`.
    const max = SimTime.fromTicks(U64_MAX);
    expect(max.checkedAdd(1n)).toBeNull();
  });

  it('adds within range', () => {
    expect(SimTime.fromTicks(3n).checkedAdd(4n)).not.toBeNull();
    expect(SimTime.fromTicks(3n).checkedAdd(4n)?.getTicks()).toBe(7n);
  });

  it('is exact at the boundary: max into max-1 succeeds exactly', () => {
    // The whole reason `ticks` is a BigInt: 2^64 - 1 is not representable as a
    // JS number, and a wrapped clock would silently break determinism.
    expect(SimTime.fromTicks(U64_MAX - 1n).checkedAdd(1n)?.getTicks()).toBe(U64_MAX);
    expect(SimTime.fromTicks(U64_MAX).checkedAdd(1n)).toBeNull();
    expect(SimTime.fromTicks(0n).checkedAdd(U64_MAX)?.getTicks()).toBe(U64_MAX);
  });
});

describe('Seed', () => {
  it('defaults to a stable zero, never fresh entropy', () => {
    expect(Seed.default().getValue()).toBe(0n);
    expect(genesis(Seed.default().getValue()).getSeed().getValue()).toBe(0n);
  });

  it('reports its raw value and keeps different values separate', () => {
    expect(Seed.new(1n).getValue()).toBe(1n);
    expect(Seed.new(1n)).not.toBe(Seed.new(2n));
  });
});

describe('TransitionError', () => {
  it('renders the same wording the Rust Display does', () => {
    expect(transitionErrorMessage({ kind: 'AlreadyActive' })).toBe(
      'the requested transition is already active',
    );
    expect(transitionErrorMessage({ kind: 'PreconditionNotMet', reason: 'because' })).toBe(
      'precondition not met: because',
    );
  });

  it('uses the Rust reason strings verbatim', () => {
    expect(CLOCK_OVERFLOW_REASON).toBe('simulation clock overflowed');
    expect(LOW_CHARGE_REASON).toBe('suit charge is too low to survey safely');
  });
});

describe('Simulation::genesis', () => {
  it('starts in the documented state', () => {
    const sim = genesis(7n);
    expect(sim.getTime().getTicks()).toBe(0n);
    expect(sim.getActivity()).toBe(Activity.Resting);
    expect(sim.getSuitCharge()).toBe(MAX_SUIT_CHARGE);
    expect(sim.getSurveyData()).toBe(0n);
    expect(sim.getStepsCompleted()).toBe(0n);
  });
});

describe('Simulation::begin_activity', () => {
  it('allows surveying with a full suit', () => {
    const sim = genesis();
    expect(sim.beginActivity(Activity.Surveying)).toBeNull();
    expect(sim.getActivity()).toBe(Activity.Surveying);
  });

  it('refuses surveying below the floor, reporting why, changing nothing', () => {
    // The Rust test builds this state from a snapshot rather than by draining
    // the suit, so the clock is not an accident of the drain arithmetic.
    const low: Snapshot = {
      time: SimTime.fromTicks(4n),
      activity: Activity.Resting,
      suitCharge: MIN_SURVEY_SUIT_CHARGE - 1,
      surveyData: 0n,
      stepsCompleted: 4n,
    };
    const sim = Simulation.fromSnapshot(low, Seed.default());
    const before = sim.snapshot();
    const error = sim.beginActivity(Activity.Surveying);
    expect(error).toEqual({ kind: 'PreconditionNotMet', reason: LOW_CHARGE_REASON });
    // The refused transition must not have moved anything, not even the clock.
    expect(snapshotEquals(sim.snapshot(), before)).toBe(true);
  });

  it('allows surveying at exactly the floor, because the Rust check is `<`', () => {
    const boundary: Snapshot = {
      time: SimTime.ZERO,
      activity: Activity.Resting,
      suitCharge: MIN_SURVEY_SUIT_CHARGE,
      surveyData: 0n,
      stepsCompleted: 0n,
    };
    const sim = Simulation.fromSnapshot(boundary, Seed.default());
    expect(sim.beginActivity(Activity.Surveying)).toBeNull();
    expect(sim.getActivity()).toBe(Activity.Surveying);
  });

  it('refuses an already-active request, leaving the state bit-for-bit identical', () => {
    const sim = genesis();
    sim.beginActivity(Activity.Surveying);
    sim.advance(30n);
    // 100 - 30*4 clamps to 0.
    expect(sim.getSuitCharge()).toBe(0);

    const before = sim.snapshot();
    expect(sim.beginActivity(Activity.Surveying)).toEqual({ kind: 'AlreadyActive' });
    expect(snapshotEquals(sim.snapshot(), before)).toBe(true);
  });

  it('always allows returning to rest, including in an emergency', () => {
    const sim = genesis();
    sim.beginActivity(Activity.Surveying);
    sim.advance(30n);
    expect(sim.getSuitCharge()).toBe(0);
    expect(sim.beginActivity(Activity.Resting)).toBeNull();
    expect(sim.getActivity()).toBe(Activity.Resting);
  });

  it('moves only the activity on success: a decision, not a step', () => {
    const sim = genesis();
    sim.beginActivity(Activity.Surveying);
    sim.advance(3n);
    const before = sim.snapshot();
    expect(sim.beginActivity(Activity.Resting)).toBeNull();
    const after = sim.snapshot();
    expect(after.suitCharge).toBe(before.suitCharge);
    expect(after.surveyData).toBe(before.surveyData);
    expect(after.stepsCompleted).toBe(before.stepsCompleted);
    expect(after.time.getTicks()).toBe(before.time.getTicks());
  });
});

describe('Simulation::advance_single_step and advance', () => {
  it('recharges while resting and caps at one hundred', () => {
    const sim = genesis();
    sim.beginActivity(Activity.Surveying);
    sim.advance(20n);
    expect(sim.getSuitCharge()).toBe(20);

    sim.beginActivity(Activity.Resting);
    sim.advance(10n);
    expect(sim.getSuitCharge()).toBe(70);

    // A further long rest must clamp, not wrap.
    sim.advance(50n);
    expect(sim.getSuitCharge()).toBe(MAX_SUIT_CHARGE);
  });

  it('resting from a full suit never exceeds one hundred', () => {
    const sim = genesis();
    sim.advance(50n);
    expect(sim.getSuitCharge()).toBe(MAX_SUIT_CHARGE);
  });

  it('drains while surveying without going negative', () => {
    const sim = genesis();
    sim.beginActivity(Activity.Surveying);
    sim.advance(25n);
    expect(sim.getSuitCharge()).toBe(0);
    expect(sim.getSurveyData()).toBe(75n);
    expect(sim.getStepsCompleted()).toBe(25n);
  });

  it('advances the clock by exactly the requested amount', () => {
    const sim = genesis();
    sim.advance(9n);
    expect(sim.getTime().getTicks()).toBe(9n);
    expect(sim.snapshot().stepsCompleted).toBe(9n);
  });

  it('checks the clock overflow BEFORE mutating any field', () => {
    // The Rust returns `PreconditionNotMet` and mutates nothing. The check is
    // first in the body, so a refused step must leave charge and data alone as
    // well as the clock.
    const atOverflow: Snapshot = {
      time: SimTime.fromTicks(U64_MAX),
      activity: Activity.Surveying,
      suitCharge: 42,
      surveyData: 11n,
      stepsCompleted: 7n,
    };
    const sim = Simulation.fromSnapshot(atOverflow, Seed.default());
    const before = sim.snapshot();
    const error = sim.advanceSingleStep();
    expect(error).toEqual({ kind: 'PreconditionNotMet', reason: CLOCK_OVERFLOW_REASON });
    expect(snapshotEquals(sim.snapshot(), before)).toBe(true);
    expect(sim.getSuitCharge()).toBe(42);
    expect(sim.getSurveyData()).toBe(11n);
    expect(sim.getStepsCompleted()).toBe(7n);
  });

  it('advancing past the overflow keeps the steps that did succeed', () => {
    // The Rust: a multi-step advance stops at the first error, having applied
    // the earlier steps. Callers needing all-or-nothing reset from a snapshot.
    const almostAtOverflow: Snapshot = {
      time: SimTime.fromTicks(U64_MAX - 2n),
      activity: Activity.Resting,
      suitCharge: 90,
      surveyData: 0n,
      stepsCompleted: 0n,
    };
    const sim = Simulation.fromSnapshot(almostAtOverflow, Seed.default());
    const error = sim.advance(5n);
    expect(error).toEqual({ kind: 'PreconditionNotMet', reason: CLOCK_OVERFLOW_REASON });
    expect(sim.getTime().getTicks()).toBe(U64_MAX);
    expect(sim.getStepsCompleted()).toBe(2n);
  });

  it('the suit invariant holds after every public method', () => {
    const sim = genesis();
    const scripts: (() => void)[] = [
      () => sim.beginActivity(Activity.Surveying),
      () => sim.advance(1001n),
      () => sim.beginActivity(Activity.Resting),
      () => sim.advance(1001n),
      () => sim.beginActivity(Activity.Surveying),
      () => sim.advance(1n),
    ];
    for (const script of scripts) {
      script();
      expect(sim.getSuitCharge()).toBeLessThanOrEqual(MAX_SUIT_CHARGE);
      expect(sim.getSuitCharge()).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('Simulation snapshots', () => {
  it('round-trips through save data and continues exactly', () => {
    const sim = genesis(11n);
    sim.beginActivity(Activity.Surveying);
    sim.advance(7n);

    const snapshot = sim.snapshot();
    const restored = Simulation.fromSnapshot(snapshot, Seed.new(11n));
    expect(snapshotEquals(restored.snapshot(), snapshot)).toBe(true);

    const continued = restored.clone();
    continued.advance(5n);
    sim.advance(5n);
    expect(snapshotEquals(continued.snapshot(), sim.snapshot())).toBe(true);
  });

  it('a snapshot carries BigInt surveyData and stepsCompleted, not numbers', () => {
    // 2^53-safe: survey_data is a u64 in the Rust module and must not be
    // truncated through a JS number on the way to a save.
    const big: Snapshot = {
      time: SimTime.fromTicks(1n),
      activity: Activity.Surveying,
      suitCharge: 100,
      surveyData: 9007199254740993n,
      stepsCompleted: 9007199254740993n,
    };
    const restored = Simulation.fromSnapshot(big, Seed.default());
    expect(restored.getSurveyData()).toBe(9007199254740993n);
    expect(restored.getStepsCompleted()).toBe(9007199254740993n);
  });

  it('cloning is an independent copy', () => {
    const sim = genesis(3n);
    const copy = sim.clone();
    sim.advance(5n);
    expect(copy.getTime().getTicks()).toBe(0n);
    expect(sim.getTime().getTicks()).toBe(5n);
  });
});

describe('determinism', () => {
  it('identical seeds and inputs produce identical outcomes', () => {
    const run = (): Snapshot => {
      const sim = genesis(42n);
      sim.beginActivity(Activity.Surveying);
      sim.advance(12n);
      sim.beginActivity(Activity.Resting);
      sim.advance(6n);
      return sim.snapshot();
    };
    expect(snapshotEquals(run(), run())).toBe(true);
  });

  it('different seeds are tracked separately', () => {
    expect(genesis(1n).getSeed().getValue()).not.toBe(genesis(2n).getSeed().getValue());
  });

  it('no method reads a clock or the environment', () => {
    // Two simulations built and advanced the same way over a wall-clock delay
    // are still identical, because nothing in the module reads the clock.
    const first = genesis(9n);
    const start = Date.now();
    while (Date.now() - start < 1) {
      // busy-wait one millisecond
    }
    const second = genesis(9n);
    first.advance(20n);
    second.advance(20n);
    expect(snapshotEquals(first.snapshot(), second.snapshot())).toBe(true);
  });
});

describe('Activity::is_exposed', () => {
  it('matches the variant', () => {
    expect(activityIsExposed(Activity.Resting)).toBe(false);
    expect(activityIsExposed(Activity.Surveying)).toBe(true);
  });
});

describe('Suitability::classify', () => {
  it('resting is never operational, at any charge', () => {
    for (const charge of [0, 1, 25, 26, 100]) {
      expect(classifySuitability(charge, Activity.Resting)).toBe(Suitability.NotSurveying);
    }
  });

  it('the charge floor is the boundary: at the floor unsafe, one above operational', () => {
    // The `<=` in `classify` against the `<` in `begin_activity` is
    // INTENTIONAL and must be preserved exactly.
    expect(classifySuitability(MIN_SURVEY_SUIT_CHARGE, Activity.Surveying)).toBe(Suitability.Unsafe);
    expect(classifySuitability(MIN_SURVEY_SUIT_CHARGE + 1, Activity.Surveying)).toBe(
      Suitability.Operational,
    );
  });

  it('covers the whole charge range, swept rather than spot-checked', () => {
    for (let charge = 0; charge <= 100; charge += 1) {
      const expected =
        charge <= MIN_SURVEY_SUIT_CHARGE ? Suitability.Unsafe : Suitability.Operational;
      expect(classifySuitability(charge, Activity.Surveying), `charge ${charge}`).toBe(expected);
    }
  });

  it('reasons match classifications', () => {
    expect(suitabilityReason(Suitability.NotSurveying)).toBe(SuitabilityClass.NotSurveying);
    expect(suitabilityReason(Suitability.Unsafe)).toBe(SuitabilityClass.LowCharge);
    expect(suitabilityReason(Suitability.Operational)).toBe(SuitabilityClass.Healthy);
    expect(suitabilityIsOperational(Suitability.Operational)).toBe(true);
    expect(suitabilityIsOperational(Suitability.Unsafe)).toBe(false);
    expect(suitabilityIsOperational(Suitability.NotSurveying)).toBe(false);
  });

  it('classification is a function of its inputs', () => {
    expect(classifySuitability(80, Activity.Surveying)).toBe(
      classifySuitability(80, Activity.Surveying),
    );
  });

  it('is a pure function of its inputs, with no clock', () => {
    const first = classifySuitability(62, Activity.Surveying);
    const start = Date.now();
    while (Date.now() - start < 1) {
      // busy-wait one millisecond
    }
    expect(classifySuitability(62, Activity.Surveying)).toBe(first);
  });
});

describe('the charge-boundary asymmetry', () => {
  it('charge 25 may begin surveying AND is immediately Unsafe', () => {
    const boundary: Snapshot = {
      time: SimTime.ZERO,
      activity: Activity.Resting,
      suitCharge: 25,
      surveyData: 0n,
      stepsCompleted: 0n,
    };
    const sim = Simulation.fromSnapshot(boundary, Seed.default());

    // `begin_activity` uses `<`, so 25 is ALLOWED.
    expect(sim.beginActivity(Activity.Surveying)).toBeNull();

    // `classify` uses `<=`, so 25 is immediately UNSAFE.
    expect(sim.siteSuitability()).toBe(Suitability.Unsafe);
  });

  it('charge 26 begins surveying and is Operational', () => {
    const above: Snapshot = {
      time: SimTime.ZERO,
      activity: Activity.Resting,
      suitCharge: 26,
      surveyData: 0n,
      stepsCompleted: 0n,
    };
    const sim = Simulation.fromSnapshot(above, Seed.default());
    expect(sim.beginActivity(Activity.Surveying)).toBeNull();
    expect(sim.siteSuitability()).toBe(Suitability.Operational);
  });

  it('charge 24 may not begin surveying and would also be Unsafe', () => {
    const below: Snapshot = {
      time: SimTime.ZERO,
      activity: Activity.Resting,
      suitCharge: 24,
      surveyData: 0n,
      stepsCompleted: 0n,
    };
    const sim = Simulation.fromSnapshot(below, Seed.default());
    expect(sim.beginActivity(Activity.Surveying)).toEqual({
      kind: 'PreconditionNotMet',
      reason: LOW_CHARGE_REASON,
    });
    expect(sim.getActivity()).toBe(Activity.Resting);
    expect(sim.siteSuitability()).toBe(Suitability.NotSurveying);
  });

  it('the resting constants are the ones the Rust module states', () => {
    expect(MIN_SURVEY_SUIT_CHARGE).toBe(25);
    expect(REST_CHARGE_PER_STEP).toBe(5);
    expect(MAX_SUIT_CHARGE).toBe(100);
  });
});
