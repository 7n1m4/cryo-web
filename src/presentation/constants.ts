/**
 * The presentation-layer constants, transcribed from the Rust
 * `src/presentation/` module.
 *
 * These are the only numbers the render layer owns. Everything a camera, a fog
 * volume or a mesh upload does with a scale or an angle is written here once, so
 * the Rust contract and this port can be compared number by number.
 */

/** z index of the title screen. Renders first, clears the frame. */
export const TITLE_CAMERA_Z = 0;

/** z index of the exterior (hull) camera. */
export const EXTERIOR_CAMERA_Z = 1;

/** z index of the interior (walking) camera. */
export const INTERIOR_CAMERA_Z = 2;

/**
 * The interior and the exterior use different scales on purpose: the interior
 * grid is authored one cell per metre, and the exterior voxel grid is authored
 * one voxel per decimetre. This is where the two meet, and it is the one place
 * the factor is allowed to appear.
 */
export const VOXEL_SCALE = 0.1;

/** The exterior fog. Interior is clean. */
export const FOG_COLOR_LINEAR: readonly [number, number, number] = [0.03, 0.05, 0.09];

/** Fog starts at 1.5 hull lengths from the camera. */
export const FOG_START_HULLS = 1.5;

/** Fog is fully opaque at 6.0 hull lengths from the camera. */
export const FOG_END_HULLS = 6.0;

/**
 * The fog's `(start, end)` pair for a hull, in world units.
 *
 * Both ends are multiples of the hull's length, so a longer ship fogs further
 * out and the fog never eats a short hull. The denominator is the same for
 * both, which is what keeps the band a band rather than two unrelated numbers.
 */
export function fogBand(hullLength: number): [number, number] {
 return [FOG_START_HULLS * hullLength, FOG_END_HULLS * hullLength];
}

/** Vertical field of view of the exterior camera, in radians. */
export const EXTERIOR_CAMERA_FOV = Math.PI / 4.5;

/** Vertical field of view of the interior camera, in radians. */
export const INTERIOR_CAMERA_FOV = Math.PI / 2.6;

/** Near plane of both cameras, in world units. */
export const CAMERA_NEAR = 0.05;

/** Far plane of the exterior camera, in world units. */
export const CAMERA_FAR_EXTERIOR = 200.0;

/** Far plane of the interior camera, in world units. */
export const CAMERA_FAR_INTERIOR = 100.0;

/**
 * How many hull lengths the standing exterior camera sits back from the hull's
 * centre. The Rust divides the ground distance by `cos(CAMERA_AZIMUTH)`, which
 * a naive `1.9 * hullLength` misses by about 44%.
 */
export const CAMERA_DISTANCE_HULLS = 1.9;

/** How many grid heights the standing exterior camera rises, in grid units. */
export const CAMERA_RISE_GRID_HEIGHTS = 1.35;

/** The standing exterior camera's azimuth, in radians. */
export const CAMERA_AZIMUTH = Math.PI / 4;

/** Orbit drag sensitivity, radians per pixel. */
export const ORBIT_RADIANS_PER_PIXEL = 0.005;

/** Orbit zoom factor per wheel line. */
export const ORBIT_ZOOM_PER_LINE = 0.88;

/** Lowest orbit elevation, in radians. */
export const ORBIT_MIN_ELEVATION = (4 * Math.PI) / 180;

/** Highest orbit elevation, in radians. */
export const ORBIT_MAX_ELEVATION = (85 * Math.PI) / 180;

/** Orbit zoom, at the closest hull lengths. */
export const ORBIT_NEAR_HULLS = 1.3;

/** Orbit zoom, at the furthest hull lengths. */
export const ORBIT_FAR_HULLS = 6.0;

/** Look sensitivity when walking, in radians per pixel. */
export const LOOK_RADIANS_PER_PIXEL = 0.005;

/** Pitch clamp when walking, in radians. */
export const MAX_PITCH = (85 * Math.PI) / 180;

/** The player's eye height above the deck, in world units. */
export const EYE_HEIGHT = 0.65;

/** The interior cell the player starts in. */
export const PLAYER_SPAWN_CELL: readonly [number, number, number] = [2, 1, 3];

/**
 * The longest a single frame may claim to be, in seconds.
 *
 * This is Bevy's `Time<Virtual>::max_delta` default, which is 250 ms and not a
 * number this port invented. Bevy does not clamp because a frame never takes
 * that long; it clamps because it does. Alt-tabbing away leaves the render loop
 * stopped with nothing to reset it, and when the window comes back the engine
 * hands the frame loop a real `performance.now()` gap of however long the
 * player was gone.
 *
 * Clamping beats resetting the clock. A reset — remembering the last frame's
 * time and skipping the gap — throws the elapsed time away and makes the
 * walker's own integration forget the part of the gap it had already consumed,
 * which is a second source of truth for time. A clamp keeps one monotone
 * accumulator behind the scenes: virtual time falls permanently behind the
 * wall clock, the frames keep coming at their real rate, and the next real
 * frames catch up at their own pace. That is the whole of Bevy's `max_delta`,
 * and it is the only thing a raw `performance.now()` delta needs.
 */
export const MAX_FRAME_SECONDS = 0.25;

/**
 * `BOARDING_RANGE` is deliberately absent here: it is the game layer's, because
 * the game layer owns the boarding trigger — `src/game/sceneView.ts` holds it,
 * and its doc carries the Rust reference. `constants.ts` holds the numbers a
 * *renderer* needs, and this one is not one.
 */
