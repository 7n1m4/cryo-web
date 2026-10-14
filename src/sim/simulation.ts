/**
 * Deterministic simulation core.
 *
 * A faithful port of `/home/vi/cryo/src/game/simulation.rs` and
 * `suitability.rs`. Plain TypeScript: it never allocates a window, never
 * touches the GPU and never reads the wall clock. Everything it depends on is
 * passed in explicitly, so tests can drive it deterministically (`SimTime` for
 * time, `Seed` for "randomness").
 *
 * # u64 representation
 *
 * JS has no 64-bit integer type and no 2^53-safe integer arithmetic, so every
 * quantity the Rust module holds in a `u64` is a `BigInt` here: `SimTime.ticks`,
 * `Seed.value`, `Snapshot.surveyData`, and `Snapshot.stepsCompleted`. The
 * overflow check in `SimTime.checkedAdd` is therefore an explicit
 * comparison against `TWO_POW_64` rather than a wrapping add, and it is tested.
 *
 * # Determinism contract
 *
 * `Simulation` promises determinism: two simulations constructed with the same
 * `Seed` and advanced with the same step counts produce identical observable
 * state. We keep that promise by never reading the system clock and never
 * using entropy from the environment.
 */

/** `2^64`, the first value a `u64` cannot represent. */
export const U64_LIMIT: bigint = 0x1_0000_0000_0000_0000n;

/** `2^64 - 1`, the largest value a `u64` can represent. */
export const U64_MAX: bigint = U64_LIMIT - 1n;

/**
 * A fixed, keepable simulation clock value.
 *
 * Simulation time is a plain value rather than a duration offset so that
 * tests can jump between arbitrary instants and reproduce them exactly.
 */
export class SimTime {
  private readonly ticks: bigint;

  private constructor(ticks: bigint) {
    this.ticks = ticks;
  }

  /** The simulation clock at simulation genesis. */
  static readonly ZERO: SimTime = new SimTime(0n);

  /**
   * Builds a time value from a tick count.
   *
   * One tick is one fixed simulation step, so tick counts are integers by
   * construction.
   */
  static fromTicks(ticks: bigint): SimTime {
    return new SimTime(applyU64Mask(ticks));
  }

  /** The number of fixed steps represented by this value. */
  getTicks(): bigint {
    return this.ticks;
  }

  /**
   * Returns this time advanced by `delta` ticks, or `null` on overflow.
   *
   * Overflow is an explicit error rather than a wrap: a wrapped clock would
   * silently break the determinism and transition-precondition guarantees
   * that the rest of this module relies on.
   */
  checkedAdd(delta: bigint): SimTime | null {
    if (this.ticks + delta > U64_MAX) {
      return null;
    }
    return new SimTime(this.ticks + delta);
  }

  /** The Rust `Display` rendering: `t{ticks}`. */
  toString(): string {
    return `t${this.ticks}`;
  }
}

/** Masks an arbitrary `BigInt` into the `u64` range, as Rust's `u64::from` would. */
function applyU64Mask(value: bigint): bigint {
  let masked = value & U64_MAX;
  if (masked < 0n) {
    masked += U64_LIMIT;
  }
  return masked;
}

/**
 * Deterministic seed for every pseudo-random draw the simulation makes.
 *
 * The seed is part of `Simulation`, never global state.
 */
export class Seed {
  private readonly value: bigint;

  private constructor(value: bigint) {
    this.value = value;
  }

  /** A named, fixed seed. */
  static new(value: bigint): Seed {
    return new Seed(applyU64Mask(value));
  }

  /** A stable default seed: `Seed(0)`. */
  static default(): Seed {
    return Seed.new(0n);
  }

  /** The raw seed value. */
  getValue(): bigint {
    return this.value;
  }
}

/**
 * Every way a caller can try to change the simulation and be refused.
 *
 * A discriminated union rather than an exception class, so a caller can match
 * on the kind without a `instanceof` probe and a test can assert on the
 * variant rather than on a message grammar that would rot.
 */
export type TransitionError =
  | { readonly kind: 'AlreadyActive' }
  | { readonly kind: 'PreconditionNotMet'; readonly reason: string };

/** The rendered form of a `TransitionError`, matching the Rust `Display`. */
export function transitionErrorMessage(error: TransitionError): string {
  switch (error.kind) {
    case 'AlreadyActive':
      return 'the requested transition is already active';
    case 'PreconditionNotMet':
      return `precondition not met: ${error.reason}`;
  }
}

/** The reason string the Rust code passes when advancing overflows the clock. */
export const CLOCK_OVERFLOW_REASON = 'simulation clock overflowed';

/** The reason string the Rust code passes when surveying is refused. */
export const LOW_CHARGE_REASON = 'suit charge is too low to survey safely';

/** The one activity the simulation knows how to track. */
export enum Activity {
  /** Resting inside the lander: suit recharges, no exposure, no data gained. */
  Resting = 'Resting',
  /** Surveying the surface from outside: gains data, drains suit charge. */
  Surveying = 'Surveying',
}

/** Whether this activity exposes the protagonist to the surface. */
export function activityIsExposed(activity: Activity): boolean {
  return activity === Activity.Surveying;
}

/**
 * Suit charge, as a percentage, above which surveying is refused.
 *
 * Precondition for `beginActivity` → `Activity.Surveying`. The battery must be
 * healthy enough that a survey cannot end in a forced emergency return.
 */
export const MIN_SURVEY_SUIT_CHARGE = 25;

/** Suit charge, as a percentage, gained per step while resting. */
export const REST_CHARGE_PER_STEP = 5;

/** Suit charge, as a percentage, lost per step while surveying. */
export const SURVEY_DRAIN_PER_STEP = 4;

/** Survey data gained per step while surveying. */
export const SURVEY_DATA_PER_STEP = 3;

/** The suit charge a full suit carries. */
export const MAX_SUIT_CHARGE = 100;

/**
 * A snapshot of everything the simulation knows, in plain data.
 *
 * The save-shaped view of the simulation: no entities, no render handles,
 * nothing transient. It round-trips by value, which is what keeps a save format
 * independent of rendering.
 */
export interface Snapshot {
  /** Current simulation clock. */
  readonly time: SimTime;
  /** Current activity. */
  readonly activity: Activity;
  /** Suit charge, in whole percentage points. */
  readonly suitCharge: number;
  /** Survey data collected, in whole units. */
  readonly surveyData: bigint;
  /** Number of fixed steps the simulation has advanced. */
  readonly stepsCompleted: bigint;
}

/** A structural, deep comparison of two snapshots, as the Rust `PartialEq` would. */
export function snapshotEquals(a: Snapshot, b: Snapshot): boolean {
  return (
    a.time.getTicks() === b.time.getTicks() &&
    a.activity === b.activity &&
    a.suitCharge === b.suitCharge &&
    a.surveyData === b.surveyData &&
    a.stepsCompleted === b.stepsCompleted
  );
}

/**
 * The authoritative gameplay state.
 *
 * Invariants (holding after every public method, and asserted by tests):
 *
 * 1. `suitCharge <= 100`.
 * 2. `time` strictly increases by the requested amount per `advance`.
 * 3. `activity` only changes through `beginActivity`, never implicitly.
 * 4. A rejected transition leaves the snapshot bit-for-bit identical.
 */
export class Simulation {
  private readonly seed: Seed;
  private time: SimTime;
  private activity: Activity;
  private suitCharge: number;
  private surveyData: bigint;
  private stepsCompleted: bigint;

  private constructor(
    seed: Seed,
    time: SimTime,
    activity: Activity,
    suitCharge: number,
    surveyData: bigint,
    stepsCompleted: bigint,
  ) {
    this.seed = seed;
    this.time = time;
    this.activity = activity;
    this.suitCharge = suitCharge;
    this.surveyData = surveyData;
    this.stepsCompleted = stepsCompleted;
  }

  /**
   * Builds a simulation at genesis for the given seed.
   *
   * Postconditions (relied upon by `snapshot`):
   * - the clock is `SimTime.ZERO`;
   * - the activity is `Activity.Resting`;
   * - the suit is fully charged;
   * - no data has been collected.
   */
  static genesis(seed: Seed): Simulation {
    return new Simulation(seed, SimTime.ZERO, Activity.Resting, 100, 0n, 0n);
  }

  /** The seed this simulation was built with. */
  getSeed(): Seed {
    return this.seed;
  }

  /** The current simulation clock. */
  getTime(): SimTime {
    return this.time;
  }

  /** The current activity. */
  getActivity(): Activity {
    return this.activity;
  }

  /** Suit charge, 0..=100. */
  getSuitCharge(): number {
    return this.suitCharge;
  }

  /** Survey data collected so far. */
  getSurveyData(): bigint {
    return this.surveyData;
  }

  /** Number of fixed steps this simulation has advanced. */
  getStepsCompleted(): bigint {
    return this.stepsCompleted;
  }

  /** A plain-data snapshot of the current state. */
  snapshot(): Snapshot {
    return {
      time: this.time,
      activity: this.activity,
      suitCharge: this.suitCharge,
      surveyData: this.surveyData,
      stepsCompleted: this.stepsCompleted,
    };
  }

  /**
   * Restores a simulation from a snapshot.
   *
   * The seed is not part of the snapshot, so it is supplied explicitly, exactly
   * as in the Rust module.
   */
  static fromSnapshot(snapshot: Snapshot, seed: Seed): Simulation {
    return new Simulation(
      seed,
      snapshot.time,
      snapshot.activity,
      snapshot.suitCharge,
      snapshot.surveyData,
      snapshot.stepsCompleted,
    );
  }

  /** A copy of this simulation. */
  clone(): Simulation {
    return new Simulation(
      this.seed,
      this.time,
      this.activity,
      this.suitCharge,
      this.surveyData,
      this.stepsCompleted,
    );
  }

  /**
   * Switches to a different activity.
   *
   * Preconditions:
   * - `Resting` requires nothing. Returning to the shelter is always allowed,
   *   including in an emergency; that is what makes it safe.
   * - `Surveying` requires `suitCharge >= MIN_SURVEY_SUIT_CHARGE`.
   *
   * Postconditions (on success): the activity becomes `target`. Nothing else
   * changes.
   *
   * On error the simulation is unchanged — including its clock.
   */
  beginActivity(target: Activity): TransitionError | null {
    if (target === this.activity) {
      return { kind: 'AlreadyActive' };
    }

    switch (target) {
      case Activity.Resting:
        // Precondition: none. Emergency return must always be possible.
        break;
      case Activity.Surveying:
        if (this.suitCharge < MIN_SURVEY_SUIT_CHARGE) {
          return { kind: 'PreconditionNotMet', reason: LOW_CHARGE_REASON };
        }
        break;
    }

    this.activity = target;
    return null;
  }

  /**
   * Advances the simulation by one fixed step.
   *
   * Effects per step:
   * - while `Activity.Resting`, suit charge rises by `REST_CHARGE_PER_STEP`,
   *   capped at 100;
   * - while `Activity.Surveying`, suit charge falls by
   *   `SURVEY_DRAIN_PER_STEP` and survey data rises by `SURVEY_DATA_PER_STEP`;
   * - the clock advances by one tick and `stepsCompleted` increments.
   *
   * Charge is clamped, never wrapped. The clock overflow check runs **first**,
   * before any field is mutated, so a refused step leaves every field — not
   * just the clock — untouched.
   */
  advanceSingleStep(): TransitionError | null {
    const next = this.time.checkedAdd(1n);
    if (next === null) {
      return { kind: 'PreconditionNotMet', reason: CLOCK_OVERFLOW_REASON };
    }

    switch (this.activity) {
      case Activity.Resting:
        this.suitCharge = Math.min(this.suitCharge + REST_CHARGE_PER_STEP, MAX_SUIT_CHARGE);
        break;
      case Activity.Surveying:
        this.surveyData += BigInt(SURVEY_DATA_PER_STEP);
        this.suitCharge = Math.max(this.suitCharge - SURVEY_DRAIN_PER_STEP, 0);
        break;
    }

    this.time = next;
    this.stepsCompleted += 1n;
    return null;
  }

  /**
   * Advances the simulation by `steps` fixed steps.
   *
   * Convenience wrapper over `advanceSingleStep`. If any step fails, the
   * simulation keeps the steps that did succeed and returns the error.
   */
  advance(steps: bigint): TransitionError | null {
    for (let i = 0n; i < steps; i += 1n) {
      const error = this.advanceSingleStep();
      if (error !== null) {
        return error;
      }
    }
    return null;
  }

  /** How suitable the current field site is for surveying. */
  siteSuitability(): Suitability {
    return classifySuitability(this.suitCharge, this.activity);
  }
}

/** How good a field site is for surveying right now. */
export enum Suitability {
  /** Surveying is not currently happening. */
  NotSurveying = 'NotSurveying',
  /** Surveying is happening, but the suit charge cannot support it. */
  Unsafe = 'Unsafe',
  /** Surveying is happening and the suit charge supports it. */
  Operational = 'Operational',
}

/** Why a site was classified as it was. */
export enum SuitabilityClass {
  /** The protagonist is not outside. */
  NotSurveying = 'NotSurveying',
  /** The suit charge is at or below the safe-survey floor. */
  LowCharge = 'LowCharge',
  /** Surveying with a healthy suit. */
  Healthy = 'Healthy',
}

/**
 * Classifies a site from its inputs.
 *
 * This is a pure function of its inputs: the same `(charge, activity)` always
 * yields the same classification. No clock, no randomness, no world.
 *
 * The `<=` here against `MIN_SURVEY_SUIT_CHARGE` is deliberately the opposite
 * of the `<` in `Simulation.beginActivity`: a charge of exactly 25 may *begin*
 * surveying but is immediately `Unsafe` to survey in, and that asymmetry is
 * part of the contract.
 */
export function classifySuitability(suitCharge: number, activity: Activity): Suitability {
  switch (activity) {
    case Activity.Resting:
      return Suitability.NotSurveying;
    case Activity.Surveying:
      return suitCharge <= MIN_SURVEY_SUIT_CHARGE ? Suitability.Unsafe : Suitability.Operational;
  }
}

/** The reason behind a classification. */
export function suitabilityReason(suitability: Suitability): SuitabilityClass {
  switch (suitability) {
    case Suitability.NotSurveying:
      return SuitabilityClass.NotSurveying;
    case Suitability.Unsafe:
      return SuitabilityClass.LowCharge;
    case Suitability.Operational:
      return SuitabilityClass.Healthy;
  }
}

/** Whether a classification is safe to act on. */
export function suitabilityIsOperational(suitability: Suitability): boolean {
  return suitability === Suitability.Operational;
}
