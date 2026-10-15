/**
 * The ship's interior: a deterministic, engine-free description of the rooms,
 * doorways and consoles *inside* the hull.
 *
 * A faithful port of `/home/vi/cryo/src/ship/interior.rs`. This module is the
 * inside of `../ship/voxel`: it describes what the player walks around in — five
 * rooms in a nose-to-tail chain, the portals that join them, the six consoles
 * worth standing at, and the arithmetic that decides where a body may go. No
 * ECS, no window, no GPU, no clock, no environment.
 *
 * # Axes
 *
 * Coordinates are the hull's own lattice indices, `x` / `y` / `z`, with the
 * origin at the lattice's minimum corner. A cell `(x, y, z)` fills
 * `[x, x+1) x [y, y+1) x [z, z+1)`, and a room's `max` is the **highest cell it
 * owns**, inclusive, so a room's extent along every axis is `max - min + 1`.
 *
 * # One cell is one metre, and that is deliberate
 *
 * The exterior hull mesh is drawn at a smaller scale purely so a ~40-cell hull
 * fits a camera frustum. **The interior does not inherit that scale.** One
 * interior cell is one world unit and one world unit is one metre: the interior
 * borrows the hull's lattice only for *placement* while being authoritative
 * about physical size.
 *
 * # Walls
 *
 * A room occupies a box of cells, and the cells on that box's outer layer are
 * wall material. Two rooms that meet share a wall: the boundary layer of each,
 * two cells thick across the seam. A `Portal` is the rectangular hole cut
 * through that seam, and the cells it names are the ones a player may cross.
 *
 * # Determinism
 *
 * The plan is a literal table. `InteriorPlan.crashedShip()` builds it from
 * `const` arrays, `validate()` reports every way the table could be wrong in a
 * fixed order, and nothing here rolls dice, reads a clock, or consults a global.
 * Two calls produce the same plan exactly.
 */

/** The height of every interior room, in cells. */
export const INTERIOR_HEIGHT = 3;

/** The width of the `RoomKind.Corridor`, in cells. */
export const CORRIDOR_WIDTH = 3;

/**
 * How many cells away from a room's own boundary a cell must sit to count as
 * interior space rather than wall.
 */
export const PASSAGE_CLEARANCE = 1;

/** The name of the room that opens onto the world outside. */
export const AIRLOCK_NAME = 'Airlock';

/** The name a `Portal` uses for the far side of the hull. */
export const EXTERIOR_NAME = 'exterior';

/** One interior space. Axis-aligned, in the hull's lattice, one cell to a metre. */
export interface Room {
  /** The stable name this room is referred to by. */
  readonly name: string;
  /** The lowest cell the room owns on each axis, inclusive. */
  readonly min: readonly [number, number, number];
  /** The highest cell the room owns on each axis, **inclusive**. */
  readonly max: readonly [number, number, number];
  /** What the room is for. Largely documentary: nothing branches on it. */
  readonly kind: RoomKind;
}

/** Whether `cell` is one this room owns, on any axis, walls included. */
function roomContains(room: Room, cell: readonly [number, number, number]): boolean {
  return cell.every((value, axis) => {
    const axisIndex = axis as 0 | 1 | 2;
    return room.min[axisIndex] <= value && value <= room.max[axisIndex];
  });
}

/**
 * Whether `cell` sits far enough inside this room's own boundary to be space a
 * body can stand in, rather than wall.
 *
 * `clearance` counts cells from the room's `min` and `max` on every axis at
 * once: a cell that is clear on two axes and flush against the third is still
 * in the wall, and the arithmetic that would let a camera through the deck is
 * the bug this is written to stop.
 */
function isInteriorSpace(room: Room, cell: readonly [number, number, number], clearance: number): boolean {
  if (!roomContains(room, cell)) {
    return false;
  }
  return cell.every((value, axis) => {
    const axisIndex = axis as 0 | 1 | 2;
    const low = room.min[axisIndex] + clearance;
    const high = room.max[axisIndex] - clearance;
    return low <= value && value <= high;
  });
}

/** The extent of this room along `axis`, in cells. */
function roomExtent(room: Room, axis: 0 | 1 | 2): number {
  if (room.max[axis] >= room.min[axis]) {
    return room.max[axis] - room.min[axis] + 1;
  }
  return 0;
}

/** The width of this room along the port/starboard axis, in cells. */
function roomWidth(room: Room): number {
  return roomExtent(room, 0);
}

/** What kind of space a `Room` is. The order is the nose-to-tail order. */
export enum RoomKind {
  /** The forward space: two seats, a canopy, and the navigation consoles. */
  Cockpit = 'Cockpit',
  /** The heart of the ship: bunks, a galley, and the life-support consoles. */
  Cabin = 'Cabin',
  /** The cramped spine connecting the rest. */
  Corridor = 'Corridor',
  /** The working end: power distribution and the breached panel with it. */
  Engineering = 'Engineering',
  /** The boundary: a hatch to the frozen exterior. */
  Airlock = 'Airlock',
}

/**
 * A doorway: the gap in the shared wall between two rooms, or between a room
 * and the world outside.
 *
 * The wall's normal is not stored because it is not free to disagree with the
 * rooms: deriving it keeps the table from being able to name a wall that is not
 * there.
 */
export interface Portal {
  /** The room this doorway starts in; a room name. */
  readonly from: string;
  /** Where it goes: another room's name, or `EXTERIOR_NAME`. */
  readonly to: string;
  /**
   * The opening, `(u_min, v_min, u_max, v_max)` on the two axes that are
   * **not** the wall's normal, all inclusive. For a doorway in a wall whose
   * normal is `x`, `u` is `y` and `v` is `z`.
   */
  readonly opening: readonly [number, number, number, number];
}

/**
 * The two axes a portal's `opening` is written against, given the axis the wall
 * runs along. A pure permutation of `0..3`.
 */
function openingAxes(normalAxis: 0 | 1 | 2): [0 | 1 | 2, 0 | 1 | 2] {
  switch (normalAxis) {
    case 0:
      return [1, 2];
    case 1:
      return [0, 2];
    default:
      return [0, 1];
  }
}

/** Whether a `Console` responds. */
export enum ConsoleCondition {
  /** No response at all. */
  Dead = 'Dead',
  /** Sometimes on, sometimes not. */
  Flickering = 'Flickering',
  /** Working. Rare enough in this ship to be worth noticing. */
  Functional = 'Functional',
  /** Physically destroyed. */
  Ruined = 'Ruined',
}

/**
 * What a console's reading agrees with on the outside of the hull.
 *
 * A cross-reference, not a state: the console does not hold a boolean, it names
 * a thing in the hull's `DamageConfig` and `consoleDamageState` asks that config
 * whether the thing is broken. The damage lives in one place — the hull's — and
 * a console pointing at it can never disagree with it.
 */
export type DamageRef =
  | { readonly kind: 'None' }
  | { readonly kind: 'Engine'; readonly index: number }
  | { readonly kind: 'Panel'; readonly panel: number }
  | { readonly kind: 'ExposedStructure'; readonly panel: number };

/** One thing to stand at and read. */
export interface Console {
  /** The stable index of this console, dense from zero in table order. */
  readonly id: number;
  /** The room this console is in; a room name. */
  readonly room: string;
  /**
   * The lattice cell a player occupies to read this console.
   *
   * It must be a cell the player can actually stand in — inside the room and
   * clear of the walls — and on the room's side of the console's nearest wall.
   */
  readonly standAt: readonly [number, number, number];
  /** The short name a prompt shows. */
  readonly name: string;
  /** What this piece of hardware is and what state it is in. */
  readonly description: string;
  /** What works and what does not. */
  readonly condition: ConsoleCondition;
  /** What this console's reading agrees with on the outside of the hull. */
  readonly relatesTo: DamageRef;
}

/** Everything the interior is, as data. */
export interface InteriorPlan {
  /** The rooms, in nose-to-tail order. Index zero is the reachability root. */
  readonly rooms: readonly Room[];
  /** The doorways, in the order they join the rooms. */
  readonly portals: readonly Portal[];
  /** The consoles, with dense ids in table order. */
  readonly consoles: readonly Console[];
}

/** The room with this name, or `null`. */
function findRoom(plan: InteriorPlan, name: string): Room | null {
  return plan.rooms.find((room) => room.name === name) ?? null;
}

/** The console with this id, or `null`. */
function findConsole(plan: InteriorPlan, id: number): Console | null {
  return plan.consoles.find((console) => console.id === id) ?? null;
}

/** The room the console with this id stands in, or `null`. */
function roomOfConsole(plan: InteriorPlan, id: number): Room | null {
  const console_ = findConsole(plan, id);
  return console_ === null ? null : findRoom(plan, console_.room);
}

/**
 * The rescued introvert's ship: small, cramped, half-broken.
 *
 * Five rooms in a nose-to-tail chain, four doorways between them and a hatch at
 * the tail, six consoles of which one is dead, one flickers, one is functional
 * and one is destroyed. The tables below are the layout's source of truth in
 * one place: change a number and `validate()` will say whether the ship still
 * stands up.
 */
export function crashedShip(): InteriorPlan {
  // The hull height is shared, so it is written once; every room's deck is the
  // keel and every room's overhead is the spine.
  const KEEL = 0;
  const SPINE = INTERIOR_HEIGHT - 1;

  const ROOMS: readonly Room[] = [
    { name: 'Cockpit', min: [0, KEEL, 0], max: [5, SPINE, 8], kind: RoomKind.Cockpit },
    { name: 'Cabin', min: [6, KEEL, 0], max: [10, SPINE, 9], kind: RoomKind.Cabin },
    { name: 'Corridor', min: [6, KEEL, 10], max: [8, SPINE, 22], kind: RoomKind.Corridor },
    { name: 'Engineering', min: [6, KEEL, 23], max: [9, SPINE, 29], kind: RoomKind.Engineering },
    { name: 'Airlock', min: [6, KEEL, 30], max: [9, SPINE, 35], kind: RoomKind.Airlock },
  ];

  // Every pair of neighbouring rooms shares a boundary layer: the cockpit runs
  // to x = 5 where the cabin starts at x = 6, and the rest meet on consecutive
  // z ranges. Each opening is written against the two axes that are not that
  // seam, so a doorway spans floor to overhead and leaves a hole wide enough to
  // walk through.
  const PORTALS: readonly Portal[] = [
    // Cockpit to cabin, through the bulkhead at x = 6.
    { from: 'Cockpit', to: 'Cabin', opening: [0, 4, 2, 6] },
    // Cabin to corridor: one metre wide, floor to overhead, the spine where the
    // whole ship narrows.
    { from: 'Cabin', to: 'Corridor', opening: [7, 0, 7, 2] },
    // Corridor to engineering, same one-metre gap.
    { from: 'Corridor', to: 'Engineering', opening: [7, 0, 7, 2] },
    // Engineering to airlock: an airlock side does not cramp, so the door is two
    // cells wide.
    { from: 'Engineering', to: 'Airlock', opening: [7, 0, 8, 2] },
    // The hatch itself: the interior's boundary with the frozen exterior.
    { from: AIRLOCK_NAME, to: EXTERIOR_NAME, opening: [7, 0, 8, 2] },
  ];

  const CONSOLES: readonly Console[] = [
    {
      id: 0,
      room: 'Cockpit',
      standAt: [2, 1, 1],
      name: 'Nav table',
      description:
        'A slanted plotting surface with a star catalogue dialled in and a course line left where the last hand put it. The screen is dim but readable, and the surface responds to touch.',
      condition: ConsoleCondition.Functional,
      relatesTo: { kind: 'None' },
    },
    {
      id: 1,
      room: 'Cockpit',
      standAt: [4, 1, 1],
      name: 'Throttle quadrant',
      description:
        'Two levers on a jointed base, both seized at the stops with the paint gone off the grips. Nothing lights, nothing moves, and nothing answers when either lever is pushed.',
      condition: ConsoleCondition.Dead,
      relatesTo: { kind: 'Engine', index: 1 },
    },
    {
      id: 2,
      room: 'Cockpit',
      standAt: [3, 1, 7],
      name: 'Flight recorder',
      description:
        'A shock-mounted box bolted to the aft bulkhead, recording through an intermittent power feed. It half-wakes every few seconds and drops again, and its lamp gutters rather than holding.',
      condition: ConsoleCondition.Flickering,
      relatesTo: { kind: 'ExposedStructure', panel: 1 },
    },
    {
      id: 3,
      room: 'Cabin',
      standAt: [7, 1, 1],
      name: 'Life support',
      description:
        'A scrubbing rack behind a ribbed panel, with a water reclamation loop under the galley floor. It ticks quietly and the readouts hold where they should, which is the only good news on this ship.',
      condition: ConsoleCondition.Functional,
      relatesTo: { kind: 'Panel', panel: 6 },
    },
    {
      id: 4,
      room: 'Cabin',
      standAt: [9, 1, 8],
      name: 'Comm console',
      description:
        'A smashed casing with the scorched jack still sparked at the rim, the antenna relay behind it dark. The casing is dented inward wherever something heavy was swung at it, and the panel will not seat.',
      condition: ConsoleCondition.Ruined,
      relatesTo: { kind: 'Panel', panel: 3 },
    },
    {
      id: 5,
      room: 'Engineering',
      standAt: [8, 1, 28],
      name: 'Power distribution',
      description:
        'A bus cabinet with breakers in a row and a thermal readout that will not settle, fed from a run that leaves the ship through a torn panel. The whole aft end is on it, and it says so.',
      condition: ConsoleCondition.Flickering,
      relatesTo: { kind: 'Engine', index: 0 },
    },
  ];

  return { rooms: ROOMS, portals: PORTALS, consoles: CONSOLES };
}

/** The console id of the first console in a plan. */
export const CONSOLE_ID_FIRST = 0;

/** The rendered form of a `ConsoleId`, matching the Rust `Display`. */
export function consoleIdToString(id: number): string {
  return `console ${id}`;
}

/**
 * Whether the hull's own damage touches what this console reports on.
 *
 * Takes a `DamageConfig` rather than reaching for a default: a console asked
 * about a config the caller did not name could answer about a ship that was
 * never built. An unknown id reports `false` — it has nothing to agree with.
 */
function consoleDamageState(
  plan: InteriorPlan,
  consoleId: number,
  damage: DamageConfigLike,
): boolean {
  const console_ = findConsole(plan, consoleId);
  if (console_ === null) {
    return false;
  }
  const ref = console_.relatesTo;
  switch (ref.kind) {
    case 'None':
      return false;
    case 'Engine':
      return damage.engines.some((engine, index) => index === ref.index && engine.missingNozzle);
    // Scuffed plating is wear, not a hole: a console reporting on a panel
    // agrees with damage only when the plating is gone.
    case 'Panel': {
      const panels = damage.panels ?? [];
      return panels.some((entry) => entry.panel === ref.panel && entry.kind === 'missing');
    }
    case 'ExposedStructure':
      return damage.exposed.includes(ref.panel);
  }
}

/**
 * The shape of the hull's damage config this module needs to read.
 *
 * Declared structurally rather than imported so the interior module has no
 * dependency on `voxel`'s classes — the Rust module imports them for their
 * plain-data fields only, and keeping the boundary one-way matters more than
 * the type identity.
 */
export interface DamageConfigLike {
  readonly engines: readonly { readonly missingNozzle: boolean }[];
  readonly panels?: readonly { readonly panel: number; readonly kind: string }[];
  readonly exposed: readonly number[];
}

/** The single room that owns `position`, or `null`.
 *
 * `null` for a cell no room owns and `null` for a cell two rooms both claim,
 * because a cell two rooms claim is a cell whose walls cannot be resolved.
 */
function ownerOf(plan: InteriorPlan, position: readonly [number, number, number]): Room | null {
  let owner: Room | null = null;
  for (const room of plan.rooms) {
    if (roomContains(room, position)) {
      if (owner !== null) {
        return null;
      }
      owner = room;
    }
  }
  return owner;
}

/**
 * True when `position` is a cell a player can stand in: inside exactly one
 * room's box, and not within any wall's thickness.
 *
 * A cell is walkable when its room owns it outright (clear of the room's own
 * boundary by `PASSAGE_CLEARANCE` on every axis) or when it is one of the cells
 * a portal cuts through a shared wall. The second case is the whole reason a
 * doorway works: without it, a player could reach both rooms on either side of
 * a seam and never cross it.
 */
function isWalkable(plan: InteriorPlan, position: readonly [number, number, number]): boolean {
  const room = ownerOf(plan, position);
  if (room === null) {
    return false;
  }
  if (isInteriorSpace(room, position, PASSAGE_CLEARANCE)) {
    return true;
  }
  return plan.portals.some((portal) => portalContains(plan, portal, position, false));
}

/**
 * True when `position` is in the airlock room or on the hatch threshold.
 *
 * The hatch threshold is the doorway of the airlock's exterior portal counted
 * from *both* sides of the wall: standing in the open hatchway is still being
 * in the airlock, and a caller cycling the hatch needs that to be true of the
 * sill and of the cell beyond it. That is the one place the exterior side of a
 * wall counts, which is why `isWalkable` passes `false` for it — a cell in
 * vacuum is not interior space.
 */
function inAirlock(plan: InteriorPlan, position: readonly [number, number, number]): boolean {
  const airlock = findRoom(plan, AIRLOCK_NAME);
  if (airlock !== null && roomContains(airlock, position)) {
    return true;
  }
  return plan.portals.some(
    (portal) =>
      (portal.from === AIRLOCK_NAME || portal.to === AIRLOCK_NAME) &&
      (portal.from === EXTERIOR_NAME || portal.to === EXTERIOR_NAME) &&
      portalContains(plan, portal, position, true),
  );
}

/** The wall a `Portal` cuts through: the axis and both boundary cells. */
interface PortalWall {
  /** The axis the wall's normal runs along. */
  readonly axis: 0 | 1 | 2;
  /** The boundary cell on the `from` side of the wall. */
  readonly lo: number;
  /** The boundary cell on the `to` side of the wall. */
  readonly hi: number;
}

function portalWall(plan: InteriorPlan, portal: Portal): PortalWall | null {
  // A wall has two sides, so the exterior may be named at either end. The
  // interior side is whichever one names a room.
  const fromName = findRoom(plan, portal.from) !== null ? portal.from : portal.to;
  const toName = findRoom(plan, portal.from) !== null ? portal.to : portal.from;
  const from = findRoom(plan, fromName);
  if (from === null) {
    return null;
  }
  const to = findRoom(plan, toName);
  if (to === null) {
    // The exterior has no box: the wall is the room's own face on the axis
    // where it stands clear of every other room.
    for (let axis = 0; axis < 3; axis += 1) {
      const index = axis as 0 | 1 | 2;
      const beyondMax = plan.rooms
        .filter((room) => room.name !== from.name)
        .every((room) => from.max[index] > room.max[index]);
      if (beyondMax) {
        return { axis: index, lo: from.max[index], hi: from.max[index] + 1 };
      }
      const beyondMin = plan.rooms
        .filter((room) => room.name !== from.name)
        .every((room) => from.min[index] < room.min[index]);
      if (beyondMin) {
        return { axis: index, lo: from.min[index] - 1, hi: from.min[index] };
      }
    }
    return null;
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const index = axis as 0 | 1 | 2;
    if (from.max[index] + 1 === to.min[index]) {
      return { axis: index, lo: from.max[index], hi: to.min[index] };
    }
    if (to.max[index] + 1 === from.min[index]) {
      return { axis: index, lo: to.max[index], hi: from.min[index] };
    }
  }
  return null;
}

/** Whether `cell` is one of the cells a portal opens up. */
function portalContains(
  plan: InteriorPlan,
  portal: Portal,
  cell: readonly [number, number, number],
  exteriorSide: boolean,
): boolean {
  const wall = portalWall(plan, portal);
  if (wall === null) {
    return false;
  }
  const axisIndex = wall.axis;
  const lo = wall.lo;
  const hi = wall.hi;
  const axis = axisIndex;
  const [u, v] = openingAxes(axisIndex);
  const uMin = portal.opening[0];
  const vMin = portal.opening[1];
  const uMax = portal.opening[2];
  const vMax = portal.opening[3];
  if (cell[u] < uMin || cell[u] > uMax || cell[v] < vMin || cell[v] > vMax) {
    return false;
  }
  // Either side counts on its own boundary cell: a doorway is a hole with a
  // room on each side, and a player inside it is standing on the room's last
  // cell.
  const interiorSide = findRoom(plan, portal.from) ?? findRoom(plan, portal.to);
  if (interiorSide !== null && roomContains(interiorSide, cell) && cell[axis] === lo) {
    return true;
  }
  const named = (name: string): Room | null => (name !== EXTERIOR_NAME ? findRoom(plan, name) : null);
  // ...and on the far side, but only through a named room: the exterior has no
  // box, and every cell on the far face of a hatch would read as interior if it
  // did not.
  const farRoom = named(portal.to) ?? named(portal.from);
  if (farRoom !== null && roomContains(farRoom, cell)) {
    return cell[axis] === hi;
  }
  if (farRoom !== null && cell[axis] === hi) {
    return true;
  }
  return exteriorSide && cell[axis] === hi;
}

/**
 * Everything that can be wrong with the interior table, as data.
 *
 * Reported by `validate()` in table order — one violation at a time, always the
 * first, so a plan with several faults always names the same one and fixing
 * them is a sequence rather than a shuffle.
 */
export type InteriorLayoutError =
  | { readonly kind: 'DuplicateRoom'; readonly name: string }
  | { readonly kind: 'UnknownRoom'; readonly portal: number; readonly name: string }
  | { readonly kind: 'DuplicatePortal'; readonly from: string; readonly to: string }
  | { readonly kind: 'UnreachableRoom'; readonly name: string }
  | { readonly kind: 'OverlappingRooms'; readonly a: string; readonly b: string }
  | { readonly kind: 'ConsoleInUnknownRoom'; readonly console: number; readonly room: string }
  | { readonly kind: 'ConsoleOutsideItsRoom'; readonly console: number }
  | { readonly kind: 'ConsoleStandsInAWall'; readonly console: number };

/** The Rust `Display` rendering of an `InteriorLayoutError`. */
export function interiorLayoutErrorMessage(error: InteriorLayoutError): string {
  switch (error.kind) {
    case 'DuplicateRoom':
      return `room "${error.name}" appears more than once`;
    case 'UnknownRoom':
      return `portal ${error.portal} names unknown room "${error.name}"`;
    case 'DuplicatePortal':
      return `portal "${error.from}" - "${error.to}" appears more than once`;
    case 'UnreachableRoom':
      return `room "${error.name}" is not reachable from the first room`;
    case 'OverlappingRooms':
      return `rooms "${error.a}" and "${error.b}" claim the same cells`;
    case 'ConsoleInUnknownRoom':
      return `${consoleIdToString(error.console)} names unknown room "${error.room}"`;
    case 'ConsoleOutsideItsRoom':
      return `${consoleIdToString(error.console)} stands outside the room it names`;
    case 'ConsoleStandsInAWall':
      return `${consoleIdToString(error.console)} stands inside its room's wall`;
  }
}

/** Whether two rooms' boxes claim any of the same cells. */
function boxesOverlap(a: Room, b: Room): boolean {
  return [0, 1, 2].every((axis) => {
    const i = axis as 0 | 1 | 2;
    return a.min[i] <= b.max[i] && b.min[i] <= a.max[i];
  });
}

/**
 * Whether this plan describes an interior a player could actually walk around
 * in.
 *
 * Every check walks the tables in index order and returns the first violation,
 * so a plan with several faults always reports the same one and fixing them one
 * at a time is a sequence rather than a shuffle. Reported, never thrown: a
 * designer editing the table learns what is wrong from the message rather than
 * from a crash in a test.
 *
 * The order is deliberate and part of the contract, not an artefact of how the
 * tables happen to be held: room names, then portal names, then portal pairs,
 * then connectivity, then room overlap, then console rooms, then console
 * placement, then console clearance.
 */
function validate(plan: InteriorPlan): InteriorLayoutError | null {
  // 1. Room names are unique.
  for (let index = 0; index < plan.rooms.length; index += 1) {
    const room = plan.rooms[index];
    if (room === undefined) {
      continue;
    }
    const duplicate = plan.rooms
      .slice(0, index)
      .some((earlier) => earlier.name === room.name);
    if (duplicate) {
      return { kind: 'DuplicateRoom', name: room.name };
    }
  }

  // 2. Every portal names rooms that exist. The exterior is not a room, and a
  //    wall has two sides, so it may be named at either end.
  for (let index = 0; index < plan.portals.length; index += 1) {
    const portal = plan.portals[index];
    if (portal === undefined) {
      continue;
    }
    if (portal.from !== EXTERIOR_NAME && findRoom(plan, portal.from) === null) {
      return { kind: 'UnknownRoom', portal: index, name: portal.from };
    }
    if (portal.to !== EXTERIOR_NAME && findRoom(plan, portal.to) === null) {
      return { kind: 'UnknownRoom', portal: index, name: portal.to };
    }
  }

  // 3. No doorway listed twice. Deduplicated on the unordered pair, so
  //    "Airlock"-"exterior" and "exterior"-"Airlock" are one doorway.
  for (let index = 0; index < plan.portals.length; index += 1) {
    const portal = plan.portals[index];
    if (portal === undefined) {
      continue;
    }
    const duplicate = plan.portals.slice(0, index).some((earlier) => {
      return (
        (earlier.from === portal.from && earlier.to === portal.to) ||
        (earlier.from === portal.to && earlier.to === portal.from)
      );
    });
    if (duplicate) {
      return { kind: 'DuplicatePortal', from: portal.from, to: portal.to };
    }
  }

  // 4. The room graph is one connected component, counted from rooms[0]. A room
  //    sealed off from the first is unreachable however many doorways the rest
  //    of the ship has.
  const first = plan.rooms[0];
  if (first !== undefined) {
    const reached: string[] = [first.name];
    for (;;) {
      let grown = false;
      for (const portal of plan.portals) {
        const from = findRoom(plan, portal.from);
        const to = findRoom(plan, portal.to);
        if (from === null || to === null) {
          continue;
        }
        for (const pair of [
          [from.name, to.name],
          [to.name, from.name],
        ] as const) {
          const [here, there] = pair;
          if (reached.includes(here) && !reached.includes(there)) {
            reached.push(there);
            grown = true;
          }
        }
      }
      if (!grown) {
        break;
      }
    }
    for (const room of plan.rooms) {
      if (!reached.includes(room.name)) {
        return { kind: 'UnreachableRoom', name: room.name };
      }
    }
  }

  // 5. No two rooms claim the same cells.
  for (let index = 0; index < plan.rooms.length; index += 1) {
    const room = plan.rooms[index];
    if (room === undefined) {
      continue;
    }
    for (const earlier of plan.rooms.slice(0, index)) {
      if (boxesOverlap(earlier, room)) {
        return { kind: 'OverlappingRooms', a: earlier.name, b: room.name };
      }
    }
  }

  // 6. Every console is in a room that exists.
  for (const console_ of plan.consoles) {
    if (findRoom(plan, console_.room) === null) {
      return { kind: 'ConsoleInUnknownRoom', console: console_.id, room: console_.room };
    }
  }

  // 7. Every console stands inside its own room.
  for (const console_ of plan.consoles) {
    const room = findRoom(plan, console_.room);
    if (room === null) {
      continue;
    }
    if (!roomContains(room, console_.standAt)) {
      return { kind: 'ConsoleOutsideItsRoom', console: console_.id };
    }
  }

  // 8. Every console stands in a cell a player can occupy, not in a wall.
  //    Rooms share walls, so a stand cell one cell clear of its own room's
  //    boundary is one cell clear of the shared wall too.
  for (const console_ of plan.consoles) {
    const room = findRoom(plan, console_.room);
    if (room === null) {
      continue;
    }
    if (!isInteriorSpace(room, console_.standAt, PASSAGE_CLEARANCE)) {
      return { kind: 'ConsoleStandsInAWall', console: console_.id };
    }
  }

  return null;
}

/**
 * A total order over numbers where every NaN sorts *after* every number.
 *
 * The Rust module uses `f32::total_cmp`, which gives a total order over the
 * whole float range including NaN (all NaNs sort last, ordered by payload
 * bits). JS has no equivalent, so the comparison the mesher-adjacent tie-breaks
 * rely on is spelled out here.
 */
export function totalCmp(a: number, b: number): number {
  const aNaN = Number.isNaN(a);
  const bNaN = Number.isNaN(b);
  if (aNaN && bNaN) {
    return 0;
  }
  if (aNaN) {
    return 1;
  }
  if (bNaN) {
    return -1;
  }
  // -0.0 sorts before +0.0 under `total_cmp`: its sign bit is set, which makes
  // it the smaller of the two zero bit patterns.
  if (a === 0 && b === 0) {
    const aSign = Object.is(a, -0) ? -1 : 0;
    const bSign = Object.is(b, -0) ? -1 : 0;
    return aSign - bSign;
  }
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Which console an inspect press reaches.
 *
 * The nearest one within `range` cells **and** within `coneCos` of the player's
 * forward direction. The cone is checked before any distance is considered, so
 * a console the player is standing on top of — at distance zero, where
 * "nearest" would otherwise have no direction to prefer — is not returned: a
 * body occupies the cell it stands in, and the console across the room is not
 * what a backward-facing player is reading.
 *
 * Distance is Euclidean in cell units between `position` and the console's
 * `standAt`. Ties break to the lower console id, compared with `totalCmp` so
 * exactly one console wins, no NaN decides anything and nothing depends on
 * iteration order. `coneCos` and `range` are the caller's.
 */
function nearestConsoleInView(
  plan: InteriorPlan,
  position: readonly [number, number, number],
  forward: readonly [number, number, number],
  range: number,
  coneCos: number,
): number | null {
  if (!forward.every((component) => Number.isFinite(component))) {
    return null;
  }
  const forwardLen = Math.hypot(forward[0] ?? 0, forward[1] ?? 0, forward[2] ?? 0);
  if (forwardLen <= 0) {
    // No direction, no cone: nothing is in view.
    return null;
  }

  let bestDistance = Number.POSITIVE_INFINITY;
  let bestId: number | null = null;
  for (const console_ of plan.consoles) {
    const offset: [number, number, number] = [
      console_.standAt[0] - position[0],
      console_.standAt[1] - position[1],
      console_.standAt[2] - position[2],
    ];
    const distance = Math.hypot(offset[0], offset[1], offset[2]);
    if (!Number.isFinite(distance) || distance > range) {
      continue;
    }
    if (distance <= 0) {
      // Already standing in it: there is no direction to be inside the cone of.
      continue;
    }
    const cosine =
      (offset[0] * (forward[0] ?? 0) + offset[1] * (forward[1] ?? 0) + offset[2] * (forward[2] ?? 0)) /
      (distance * forwardLen);
    if (!Number.isFinite(cosine) || cosine < coneCos) {
      continue;
    }
    const replace =
      bestId === null ||
      totalCmp(distance, bestDistance) < 0 ||
      (distance === bestDistance && console_.id < bestId);
    if (replace) {
      bestDistance = distance;
      bestId = console_.id;
    }
  }
  return bestId;
}

/** Half the player's extent along each axis, in world units.
 *
 * Shoulder width, floor to sternum, and shoulder depth: a body 0.7 m across,
 * 1.8 m tall and 0.7 m deep, standing on the deck. Collision treats the player
 * as this box and never as a point, so a corner that catches a shoulder stops
 * the shoulder.
 */
export const PLAYER_HALF_EXTENTS: readonly [number, number, number] = [0.35, 0.9, 0.35];

/**
 * How far a body is kept off a wall after a contact, in world units.
 *
 * Small enough to be invisible, large enough that floating-point comparison
 * against the same wall next frame does not read as a fresh hit and buzz.
 */
export const COLLISION_SKIN = 0.01;

/**
 * A sanity bound on the magnitude of any position, displacement or velocity
 * component.
 *
 * Not a clamp and not a limit on gameplay. It exists so that an input at a
 * magnitude where f32 precision has stopped meaning anything (`1e30`, a NaN, a
 * value from a crashed save) is refused instead of being carried through
 * arithmetic whose result would be meaningless.
 */
export const MAX_ABS_COMPONENT = 1.0e6;

/** The result of one frame of collision resolution. */
export interface CollisionResult {
  /** The resolved position, always finite if the inputs were. */
  readonly position: [number, number, number];
  /** The resolved velocity, with the blocked axis zeroed. */
  readonly velocity: [number, number, number];
}

/** Whether every component of `v` is finite and inside `MAX_ABS_COMPONENT`. */
function isSane(v: readonly [number, number, number]): boolean {
  return v.every(
    (component) => Number.isFinite(component) && Math.abs(component) <= MAX_ABS_COMPONENT,
  );
}

/**
 * Resolves one frame of movement against the wall boxes.
 *
 * Axis-separated, **not** swept as a 3-D capsule: separating the axes is what
 * makes sliding along a wall possible, which a single swept volume defeats.
 * Walking diagonally into a bulkhead must slide along it, not stop dead.
 *
 * For each axis independently, the body's swept extent along that axis is
 * tested against every wall that also overlaps it on the *other* two axes; the
 * nearest such contact clamps the motion, and only that axis of the velocity is
 * zeroed, so running into a wall head-on stops forward motion without killing
 * the sideways slide.
 *
 * The returned position is always finite. If any component of `origin`,
 * `displacement` or `velocity` is non-finite or beyond `MAX_ABS_COMPONENT`,
 * both are returned unchanged.
 *
 * A displacement component smaller than `COLLISION_SKIN` issues no wall test at
 * all. It is a rounding artefact, not a move, and casting it would jitter the
 * body against a wall it is already resting on.
 */
function resolveCollision(
  origin: readonly [number, number, number],
  displacement: readonly [number, number, number],
  velocity: readonly [number, number, number],
  walls: readonly (readonly [readonly [number, number, number], readonly [number, number, number]])[],
): CollisionResult {
  if (!isSane(origin) || !isSane(displacement) || !isSane(velocity)) {
    return { position: [...origin] as [number, number, number], velocity: [...velocity] as [number, number, number] };
  }

  const position: [number, number, number] = [...origin];
  const resolved: [number, number, number] = [...velocity];

  for (let axisIndex = 0; axisIndex < 3; axisIndex += 1) {
    const axis = axisIndex as 0 | 1 | 2;
    const step = displacement[axis];
    if (Math.abs(step) < COLLISION_SKIN) {
      // No move, no cast: the body stays exactly where it was.
      continue;
    }
    const half = PLAYER_HALF_EXTENTS[axis];
    const low = origin[axis] + Math.min(step, 0) - half;
    const high = origin[axis] + Math.max(step, 0) + half;

    let limit: number | null = null;
    for (const wall of walls) {
      // Overlap along this axis is only a candidate; overlapping on the other
      // two is what makes this wall *ours*.
      if (high <= wall[0][axis] || low >= wall[1][axis]) {
        continue;
      }
      let touches = true;
      for (let otherIndex = 0; otherIndex < 3; otherIndex += 1) {
        const other = otherIndex as 0 | 1 | 2;
        if (other === axis) {
          continue;
        }
        const halfOther = PLAYER_HALF_EXTENTS[other];
        const playerLow = origin[other] - halfOther;
        const playerHigh = origin[other] + halfOther;
        if (playerHigh <= wall[0][other] || wall[1][other] <= playerLow) {
          touches = false;
          break;
        }
      }
      if (!touches) {
        continue;
      }
      const contact = step > 0 ? wall[0][axis] - half : wall[1][axis] + half;
      const candidate = contact - origin[axis];
      limit = limit === null ? candidate : totalCmp(candidate, limit) < 0 ? candidate : limit;
    }

    if (limit === null) {
      position[axis] = origin[axis] + step;
      continue;
    }
    if (limit < Math.abs(step)) {
      // Contact. `max(limit, 0)` is what stops a body already inside a wall
      // being pushed back out of it: the displacement clamps to zero rather
      // than teleporting, and the skin keeps it off the surface.
      const direction = step > 0 ? 1 : -1;
      position[axis] = origin[axis] + direction * Math.max(limit, 0) - direction * COLLISION_SKIN;
      resolved[axis] = 0;
    } else {
      position[axis] = origin[axis] + step;
    }
  }

  return { position, velocity: resolved };
}

/** Walking speed with no input modifier, in world units per second. */
export const WALK_SPEED = 2.2;

/** How much faster a sprinting player goes than a walking one. */
export const SPRINT_MULTIPLIER = 1.9;

/**
 * How hard the player's movement is damped, per second.
 *
 * The time constant is `1 / MOVE_DAMPING`, so the player's speed falls by a
 * fixed fraction per unit time — never by a fixed amount per frame, which is
 * what would make the feel depend on the frame rate.
 */
export const MOVE_DAMPING = 9.0;

/**
 * One frame of walk integration. `dt` is a parameter, never read from a clock:
 * this is what makes the closed-form exponential decay identical at any frame
 * rate, and what makes the function testable without a game running.
 *
 * Acceleration and stopping are deliberately **not** the same curve.
 *
 * - With input on an axis, the velocity approaches the wish target by a fixed
 *   *fraction of the remaining gap* per unit time:
 *   `v += (target - v) * (1 - e^{-k dt})`. The gap closes exponentially, so the
 *   player reaches 95% of walk speed in about a third of a second and never
 *   overshoots it.
 * - With no input on an axis, the velocity is damped on top of the approach:
 *   `v *= e^{-k dt}`. Stopping therefore decays by a fixed *fraction of the
 *   current speed*, which is faster than the gap-closing form at the same
 *   magnitude.
 *
 * `1 - e^{-x}` is written `-expm1(-x)`. It is the same number, but computed so
 * that a small `dt` does not lose it to cancellation: at `dt = 1e-9` the
 * `1.0 - e` form keeps no significant digits, while `-expm1` keeps all of them.
 *
 * A `dt` that is not finite or is negative returns `velocity` unchanged. A
 * `wish` that is not finite is treated as no input. Every non-finite input
 * produces a finite output.
 */
export function integrateMovement(
  velocity: readonly [number, number, number],
  wish: readonly [number, number, number],
  sprinting: boolean,
  dt: number,
): [number, number, number] {
  if (!Number.isFinite(dt) || dt < 0) {
    return [...velocity];
  }
  const maxSpeed = WALK_SPEED * (sprinting ? SPRINT_MULTIPLIER : 1);
  const exponent = -MOVE_DAMPING * dt;
  const approach = -Math.expm1(exponent);
  const attenuation = Math.exp(exponent);

  const result: [number, number, number] = [...velocity];
  for (let axisIndex = 0; axisIndex < 3; axisIndex += 1) {
    const axis = axisIndex as 0 | 1 | 2;
    const raw = wish[axis];
    const pressed = Number.isFinite(raw) ? raw : 0;
    const target = pressed * maxSpeed;
    // Approach the target, then decay on top when nothing is being asked for
    // on this axis.
    let v = velocity[axis] + (target - velocity[axis]) * approach;
    if (pressed === 0) {
      v *= attenuation;
    }
    result[axis] = v;
  }
  return result;
}

/**
 * Which surface of the hull's shell a [`Slab`] is part of.
 *
 * Port of `SlabKind` (interior_scene.rs:2085-2097).
 */
export type SlabKind = 'floor' | 'ceiling' | 'wall';

/**
 * One face of one room, as a slab: zero-thickness on its normal axis for
 * collision, one cell thick for rendering.
 *
 * Port of `Slab` (interior_scene.rs:2038-2078). The two derivations — the mesh
 * and the collision plane — come from one list, because two functions
 * computing "where the walls are" can disagree about where a doorway is.
 */
export interface Slab {
 /** The axis this slab's surface is normal to. */
 readonly axis: 0 | 1 | 2;
 /** The coordinate the slab's surface sits at, on `axis`. */
 readonly plane: number;
 /** The first in-face axis, the one the rect's `[0]`/`[2]` run on. */
 readonly u: 0 | 1 | 2;
 /** The second in-face axis, the one the rect's `[1]`/`[3]` run on. */
 readonly v: 0 | 1 | 2;
 /** `(u_min, v_min, u_max, v_max)`, in cells, the surface's full extent. */
 readonly rect: readonly [number, number, number, number];
 /** How far the rendered slab runs from the plane, and which way. */
 readonly thickness: number;
 /** Which surface of the hull's shell this slab is part of. */
 readonly kind: SlabKind;
}

/** Every cell a slab is thick, so a rendered wall is one lattice cell deep. */
const SLAB_THICKNESS = 1;

/** One opening cut out of a wall, as `(room, low_side, axis, rect)`. */
type PortalHole = {
 readonly room: string;
 readonly lowSide: boolean;
 readonly axis: 0 | 1 | 2;
 readonly rect: readonly [number, number, number, number];
};

/** A box, as the `[low, high]` corner pair the collision code takes. */
type Box = readonly [readonly [number, number, number], readonly [number, number, number]];

/**
 * The interior's slabs: every face of every room, carved by the doorways in it.
 *
 * This is the single derivation the geometry and the collision both come from.
 * The spawned meshes are `interiorSlabs` rendered, and [`walkableWalls`] is the
 * same list with each slab's thickness collapsed onto its own surface.
 *
 * For the shipped `crashedShip` it returns 38 slabs: the cockpit contributes 7,
 * the cabin 8, the corridor 8, engineering 8 and the airlock 7. The airlock is
 * one short because its hatch is left sealed. A face carved by one doorway
 * yields four slabs at most, so a count that is not `38 = 5 × 6 + 8` means a
 * carve has stopped cutting what it should.
 *
 * Port of `interior_slabs` (interior_scene.rs:2178-2213).
 */
export function interiorSlabs(plan: InteriorPlan): readonly Slab[] {
 const holes = portalHoles(plan);
 const pieces: Slab[] = [];

 for (const room of plan.rooms) {
  for (const face of FACES) {
   const rect = face.rect(room);
   const holesHere = holesOn(holes, room.name, face.lowSide, face.axis);
   let carved = [rect];
   for (const hole of holesHere) {
    // Each hole cuts every surviving piece, so a face with more than one
    // doorway in it comes out as more than four pieces.
    carved = carved.flatMap((piece) => carveRect(piece, hole));
   }
   const [u, v] = openingAxes(face.axis);
   for (const piece of carved) {
    pieces.push({
     kind: face.axis === 1 ? (face.lowSide ? 'floor' : 'ceiling') : 'wall',
     axis: face.axis,
     plane: face.plane(room),
     u,
     v,
     rect: piece,
     thickness: face.thickness(),
    });
   }
  }
 }

 return pieces;
}

/**
 * The interior's wall planes, as `(min, max)` boxes collapsed onto their own
 * surface.
 *
 * Port of `walkable_walls` (interior_scene.rs:772-778). Each box is
 * zero-thickness on exactly one axis — the normal of the slab it came from —
 * which is what turns the renderable geometry into the planes the walker's
 * sweep test collides against.
 */
export function walkableWalls(plan: InteriorPlan): readonly Box[] {
 return interiorSlabs(plan).map((slab) => slabBounds(slab, true));
}

/**
 * A slab's box.
 *
 * `collapse` zeroes the thickness, which turns the rendered slab into the
 * collision plane it is derived from.
 *
 * Port of `Slab::bounds` (interior_scene.rs:2066-2078).
 */
function slabBounds(slab: Slab, collapse: boolean): Box {
 const min: [number, number, number] = [0, 0, 0];
 const max: [number, number, number] = [0, 0, 0];
 min[slab.u] = slab.rect[0];
 max[slab.u] = slab.rect[2];
 min[slab.v] = slab.rect[1];
 max[slab.v] = slab.rect[3];
 if (collapse) {
  min[slab.axis] = slab.plane;
  max[slab.axis] = slab.plane;
 } else {
  const far = slab.plane + slab.thickness;
  min[slab.axis] = Math.min(slab.plane, far);
  max[slab.axis] = Math.max(slab.plane, far);
 }
 return [min, max];
}

/** One of a room's six faces: which axis, and which side of it. */
type RoomFace = {
 readonly axis: 0 | 1 | 2;
 readonly lowSide: boolean;
 /** Where this face's collision plane sits, in world units. */
 readonly plane: (room: Room) => number;
 /** The face's full extent, as `(u_lo, v_lo, u_hi, v_hi)` in world units. */
 readonly rect: (room: Room) => readonly [number, number, number, number];
 /** How far the rendered slab runs from the plane, and which way. */
 readonly thickness: () => number;
};

/**
 * The interior's six faces, in a fixed order: port, starboard, deck, overhead,
 * forward, aft.
 *
 * The order a room's own wall boxes are written in, so the piece list this
 * produces can be read against that one.
 *
 * The x and z faces differ from the y faces, and the difference is the whole
 * reason the planes are not simply the room's own box:
 *
 * - On x and z the boundary cell is solid material *inside* the room's own box,
 *   so the plane is that cell's inner face: `min + 1` on the low side and `max`
 *   on the high side. A player's centre is then kept between the two, which is
 *   exactly the band the plan calls walkable.
 * - On y the hull's skin is the boundary, and the player walks *between* the
 *   skin's outer faces, so the plane is the room's own face: `min[1]` and
 *   `max[1]`.
 *
 * Port of `FACES` and `RoomFace` (interior_scene.rs:2099-2162).
 */
const FACES: readonly RoomFace[] = [
 roomFace(0, true),
 roomFace(0, false),
 roomFace(1, true),
 roomFace(1, false),
 roomFace(2, true),
 roomFace(2, false),
];

/** Builds the one face at `axis`/`lowSide` with the Rust's own three formulas. */
function roomFace(axis: 0 | 1 | 2, lowSide: boolean): RoomFace {
 return {
  axis,
  lowSide,
  plane: (room: Room): number => {
   if (lowSide) {
    if (axis === 1) {
     return room.min[1];
    }
    return room.min[axis] + 1;
   }
   return room.max[axis];
  },
  rect: (room: Room): readonly [number, number, number, number] => {
   const [u, v] = openingAxes(axis);
   return [room.min[u], room.min[v], room.max[u] + 1, room.max[v] + 1];
  },
  thickness: (): number => (lowSide ? -SLAB_THICKNESS : SLAB_THICKNESS),
 };
}

/**
 * The openings the plan's interior doorways cut.
 *
 * Both faces that share the seam are carved, so the doorway is a hole rather
 * than a half-doorway. The seam is the one axis on which one room's boundary
 * meets the other's; only x and z can form one, because rooms in this plan
 * never stack vertically.
 *
 * Port of `portal_holes` (interior_scene.rs:2226-2261).
 */
function portalHoles(plan: InteriorPlan): readonly PortalHole[] {
 const holes: PortalHole[] = [];

 for (const portal of plan.portals) {
  if (portal.from === EXTERIOR_NAME || portal.to === EXTERIOR_NAME) {
   continue;
  }
  const a = plan.rooms.find((room) => room.name === portal.from);
  const b = plan.rooms.find((room) => room.name === portal.to);
  if (a === undefined || b === undefined) {
   continue;
  }
  const hole = portal.opening;
  const rect: readonly [number, number, number, number] = [
   hole[0],
   hole[1],
   hole[2] + 1,
   hole[3] + 1,
  ];

  // The Rust pushes `(room, low_side = false, ...)` then `(room, low_side =
  // true, ...)`: the seam is the *high* face of the room on the low side, and
  // the *low* face of the room on the high side — which is where the two
  // rooms' own wall planes actually meet.
  const seam = (high: Room, low: Room, axis: 0 | 2): void => {
   holes.push({ room: high.name, lowSide: false, axis, rect });
   holes.push({ room: low.name, lowSide: true, axis, rect });
  };

  if (a.max[0] + 1 === b.min[0]) {
   seam(a, b, 0);
  }
  if (b.max[0] + 1 === a.min[0]) {
   seam(b, a, 0);
  }
  if (a.max[2] + 1 === b.min[2]) {
   seam(a, b, 2);
  }
  if (b.max[2] + 1 === a.min[2]) {
   seam(b, a, 2);
  }
 }

 return holes;
}

/** Which of the openings cut this room's this face. */
function holesOn(
 holes: readonly PortalHole[],
 room: string,
 lowSide: boolean,
 axis: 0 | 1 | 2,
): readonly (readonly [number, number, number, number])[] {
 return holes
  .filter((hole) => hole.room === room && hole.lowSide === lowSide && hole.axis === axis)
  .map((hole) => hole.rect);
}

/**
 * Cuts `hole` out of `face`, returning the surviving sub-rectangles.
 *
 * A rectangular hole in a rectangular face leaves at most four pieces: a strip
 * on either side of it, and a strip above and below it. Fewer when the hole
 * reaches an edge.
 *
 * The hole is clamped into the face before it is cut, so a doorway that runs
 * past the edge of the wall it is named in cannot produce a rectangle reaching
 * outside it. Every strip is emitted only when it is non-empty on *both* axes:
 * a zero-area box would be a collision plane that blocks nothing and a
 * rendering slab nobody can see.
 *
 * Port of `carve` (interior_scene.rs:2295-2330).
 */
function carveRect(
 face: readonly [number, number, number, number],
 hole: readonly [number, number, number, number],
): readonly (readonly [number, number, number, number])[] {
 const [fu0, fv0, fu1, fv1] = face;
 const [hu0, hv0, hu1, hv1] = hole;

 const cu0 = Math.max(hu0, fu0);
 const cu1 = Math.min(hu1, fu1);
 const cv0 = Math.max(hv0, fv0);
 const cv1 = Math.min(hv1, fv1);

 if (cu1 <= cu0 || cv1 <= cv0) {
  // The doorway does not reach this face, so the face survives whole.
  return [face];
 }

 const pieces: (readonly [number, number, number, number])[] = [];
 for (const [u0, u1] of [
  [fu0, cu0],
  [cu1, fu1],
 ] as const) {
  if (u1 > u0) {
   pieces.push([u0, fv0, u1, fv1]);
  }
 }
 for (const [v0, v1] of [
  [fv0, cv0],
  [cv1, fv1],
 ] as const) {
  if (v1 > v0) {
   pieces.push([cu0, v0, cu1, v1]);
  }
 }
 return pieces;
}

export {
  roomContains,
  isInteriorSpace,
  roomExtent,
  roomWidth,
  findRoom,
  findConsole,
  roomOfConsole,
  consoleDamageState,
  ownerOf,
  isWalkable,
  inAirlock,
  portalWall,
  portalContains,
  validate,
  nearestConsoleInView,
  resolveCollision,
};
