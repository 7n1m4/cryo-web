/**
 * The seam between the game layer and the scenes it drives.
 *
 * This module is the whole contract between `src/game/**` and
 * `src/presentation/**`. The game layer decides *when* a key press means
 * something; the presentation layer decides *where the camera and the player
 * are*. Neither needs the other's internals, so the boundary is two
 * read-only getters and the constants the comparisons are made against.
 *
 * Ported from `cryo/src/presentation/interior_scene.rs`.
 */

/** A point in world space, as three numbers. */
export type Vec3Like = readonly [number, number, number];

/**
 * How far the exterior camera must be from the boarding station, in world units.
 *
 * The Rust's `BOARDING_RANGE` (interior_scene.rs:1684), which `board_the_hull`
 * reads through `boarding_range()` (interior_scene.rs:1691-1694) and compares
 * against `orbit.position().distance(station)` (interior_scene.rs:1569). It is a
 * *flat* constant in the Rust too — a tolerance, not the thing that makes
 * boarding reachable.
 *
 * Reachability comes from the other side of the comparison: the Rust's
 * `boarding_station` (interior_scene.rs:1612-1618) derives the station from the
 * hull, by taking the hatch mouth's direction and applying every clamp the orbit
 * enforces through `ShipOrbit::nearest_to` (ship_scene.rs:711-723), including
 * `nearest_reachable_distance` = `ORBIT_NEAR_HULLS * radius`
 * (ship_scene.rs:676-678, `ORBIT_NEAR_HULLS` at ship_scene.rs:450). The mouth's
 * own world position sits *inside* the orbit's near clamp, so a radius around it
 * could never be satisfied — see the reasoning at interior_scene.rs:1582-1598
 * and the test at interior_scene.rs:2626-2653. That hull-derived derivation is
 * the presentation layer's, and lives in `src/presentation/player.ts` as
 * `boardingStation`; this constant is only the band around its result.
 *
 * It is the ship module's copy rather than `presentation/constants.ts`'s that
 * wins: the game layer owns the trigger, so it owns the threshold the trigger is
 * compared against, and a second definition somewhere a reader cannot find is
 * the failure mode this avoids.
 */
export const BOARDING_RANGE = 0.6;

/**
 * How far a player can stand from a console and still reach it, in cells.
 *
 * The Rust's `INSPECT_RANGE` (interior_scene.rs:278), which `inspect_console`
 * (interior_scene.rs:1412-1418) and `airlock_transition` (interior_scene.rs:1481-1488)
 * both pass to `nearest_console_in_view`. The seam is these two numbers and the
 * range-and-cone shape of the call: the Rust's own `nearest_console_in_view`
 * takes both as parameters and its module doc (interior.rs:894-899) says the
 * function has no opinion about them — the values are the caller's, and their
 * two call sites agree on this pair.
 *
 * The unit is *cells*, not world units: one cell is one interior metre, so this
 * is the reach of a standing body with an arm out — close enough that a player
 * must actually walk up to a console, and far enough that one standing in front
 * of the wall it hangs on is not turned away by a rounding difference.
 */
export const INSPECT_RANGE = 1.6;

/**
 * How wide the inspect cone is, as the cosine of the half-angle from forward.
 *
 * The Rust's `INSPECT_CONE_COS` (interior_scene.rs:287) — `cos(60°)`, about two
 * thirds of a body's width either side of the nose — passed to the same two call
 * sites as [`INSPECT_RANGE`]. It is deliberately a cosine rather than an angle
 * because the comparison it feeds is a dot product: converting back to an angle
 * at every call would be arithmetic for its own sake.
 */
export const INSPECT_CONE_COS = 0.5;

/**
 * The exterior scene, read back to the game layer.
 *
 * The exterior has no player entity in the Rust — it is an orbit camera, the
 * hull, the ice and two beacons — so "is the player at the hatch?" cannot be
 * asked of a body. It is asked of the orbit camera, which is the only thing in
 * the exterior that stands somewhere. That is why `getCameraPosition` is here
 * and `getPlayerPosition` is not.
 */
export interface ExteriorSceneView {
 /** Where the orbit camera stands, in world units. */
 getCameraPosition(): Vec3Like;
 /**
  * Where the hatch's boarding station is, in world units, or `null` when the
  * plan has no hatch and boarding is unavailable.
  *
  * The closest the orbit may legally come to the hatch's own direction from the
  * hull's centre — not the mouth's own position, which lands inside the orbit's
  * near clamp and could never be reached. The derivation is the presentation
  * layer's, because it needs the hull plan, the generated hull and the orbit's
  * reachability clamps; the game layer only ever compares against it.
  *
  * `null` rather than the origin: the Rust's `boarding_station` is an
  * `Option<Vec3>` (interior_scene.rs:1612) and `board_the_hull` returns early
  * on `None` (interior_scene.rs:1566-1568), because a scene with no hatch is
  * one the player cannot enter through this path and there is nothing useful
  * to panic about. A default of `(0,0,0)` would turn that early return into a
  * distance test against the hull's centre, which is a trigger the player can
  * only pull by accident.
  */
 getBoardingStation(): Vec3Like | null;
}

/**
 * The interior scene, read back to the game layer.
 *
 * Both answers are about the body: what cell it occupies, and where it is
 * looking. `getPlayerForward` carries the pitch, because the inspect cone does
 * too — a console low on a wall is looked down at, and a cone that ignored the
 * tilt would insist the player look at the horizon to read something at chest
 * height.
 */
export interface InteriorSceneView {
 /** The lattice cell the player's body occupies. */
 getPlayerCell(): Vec3Like;
 /** The unit-length direction the player is looking, pitch included. */
 getPlayerForward(): Vec3Like;
}

/** The two scenes, or `null` for the one that is not mounted. */
export interface SceneViews {
 /** The exterior scene, or `null` on the title screen. */
 readonly exterior: ExteriorSceneView | null;
 /** The interior scene, or `null` outside the hull. */
 readonly interior: InteriorSceneView | null;
}

/** The no-renderer case: no scene is mounted, so no scene query can answer. */
export const NO_VIEWS: SceneViews = { exterior: null, interior: null };

/** The Euclidean distance between two points. */
export function distance(a: Vec3Like, b: Vec3Like): number {
 return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
