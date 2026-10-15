/**
 * Which consoles the player has read, and whether the readout is up.
 *
 * Both are session progress, not rendering state, which is why they live in the
 * game layer and not beside the DOM. The Rust holds them as a Bevy resource and
 * a `Visibility` component; the reason for the resource half is the whole
 * design — see the doc comment on `InteriorProgress` below.
 *
 * Ported from `cryo/src/presentation/interior_scene.rs`.
 */

import { crashedShip } from '../ship/interior.ts';

/**
 * The number of consoles the shipped plan carries.
 *
 * The Rust writes this as a `const` because `InteriorPlan::crashed_ship` is not
 * a `const fn`; TypeScript has no such restriction, so it is read from the plan
 * itself. That is strictly better than the Rust's literal: `console_count_`_
 * `matches_the_bit_set` is the test that fails if the two ever disagree, and
 * here they cannot.
 */
export const CONSOLE_COUNT = crashedShip().consoles.length;

/** The console id of the first console in a plan, re-exported for callers. */
export { CONSOLE_ID_FIRST } from '../ship/interior.ts';

/** Whether `id` names a console the shipped plan actually has. */
export function isConsoleId(id: number): boolean {
 return Number.isInteger(id) && id >= 0 && id < CONSOLE_COUNT;
}

/**
 * Which consoles the player has read, as a per-console flag set.
 *
 * A resource in the Rust rather than a component, for one reason: the interior
 * scene's `despawn_interior` removes every interior entity on the boundary, so
 * anything held on a console, on the camera or on the player would be deleted
 * with them and "I read that" would silently become "I did not". In TypeScript
 * there are no entities to despawn, but the shape is kept because the ownership
 * is the same: reading progress belongs to the session, not to whatever scene is
 * currently mounted, and re-creating it on entry to the interior would clear a
 * session's reading on the way through the airlock.
 *
 * An array of flags rather than a `Set<number>`: the console set is fixed by the
 * plan and known before any of them is read, so the cheapest correct container
 * is one that allocates nothing, hashes nothing and occupies a cache line or
 * two. A `Set` would make "have I read these?" a question about hashing, and
 * would let the two containers describe different sets.
 */
export class InteriorProgress {
 private readonly inspected: boolean[];

 constructor(length: number = CONSOLE_COUNT) {
  this.inspected = new Array<boolean>(length).fill(false);
 }

 /**
  * Records `id` as read.
  *
  * An id the plan does not have is dropped rather than clamped: the flags are
  * the plan's consoles and nothing else, and a caller inventing an id is a bug
  * worth being loud about in the ship module rather than silent here.
  */
 inspect(id: number): void {
  const flag = this.inspected[id];
  if (flag !== undefined) {
   this.inspected[id] = true;
  }
 }

 /** Whether `id` has been read. An out-of-range id reads as unread. */
 isInspected(id: number): boolean {
  return this.inspected[id] === true;
 }

 /** How many consoles have been read. */
 inspectedCount(): number {
  let count = 0;
  for (const flag of this.inspected) {
   if (flag) {
    count += 1;
   }
  }
  return count;
 }

 /**
  * The whole flag set, in console order.
  *
  * A slice rather than `inspectedCount` because a count cannot tell *which*
  * consoles are read: a player who read the nav table and then, after coming
  * back, read a different one would show a count of two, and a resource that
  * somehow reset and re-read the wrong console would show a count of one. The
  * only comparison that distinguishes those is the position of every flag, so
  * the tests that care compare this rather than the count.
  *
  * A copy rather than a borrow, because a caller that can hand back the
  * resource's own array is a caller that can mutate it after the fact.
  */
 inspectedFlags(): readonly boolean[] {
  return [...this.inspected];
 }

 /** Clears every flag, as though the session had just begun. */
 reset(): void {
  this.inspected.fill(false);
 }
}

/**
 * Whether the readout is up, and what it is showing.
 *
 * The Rust writes a `Visibility` and keeps the *last* console's text in a
 * `String` component. The game layer owns the visibility and the identity of the
 * console, both of which are decisions; the text itself is a rendering concern
 * and stays in `presentation/`, where it can name the console's description and
 * condition.
 */
export interface ReadoutState {
 /** Whether the readout panel is on screen. */
 readonly visible: boolean;
 /** The console being read, or `null` when nothing is up. */
 readonly consoleId: number | null;
}

/** A closed readout, the state the session and every `Escape` leaves behind. */
export const HIDDEN_READOUT: ReadoutState = { visible: false, consoleId: null };

/** An open readout on the console `consoleId`. */
export function visibleReadout(consoleId: number): ReadoutState {
 return { visible: true, consoleId };
}
