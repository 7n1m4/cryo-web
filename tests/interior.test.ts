/**
 * The interior port: a faithful transcription of the Rust
 * `src/ship/interior.rs` tests.
 *
 * The `validate()` suite pins all eight checks in contract order — the order is
 * part of what a designer relies on when they are told one fault at a time —
 * and the collision/movement tests pin exact numbers, because the frame-rate
 * independence of `integrateMovement` is only true if the arithmetic is exactly
 * the closed-form exponential the doc promises.
 */

import { describe, expect, it } from 'vitest';

import {
  AIRLOCK_NAME,
  COLLISION_SKIN,
  CONSOLE_ID_FIRST,
  CORRIDOR_WIDTH,
  EXTERIOR_NAME,
  INTERIOR_HEIGHT,
  MOVE_DAMPING,
  PASSAGE_CLEARANCE,
  PLAYER_HALF_EXTENTS,
  SPRINT_MULTIPLIER,
  WALK_SPEED,
  ConsoleCondition,
  crashedShip,
  consoleDamageState,
  consoleIdToString,
  findConsole,
  findRoom,
  inAirlock,
  interiorLayoutErrorMessage,
  isWalkable,
  nearestConsoleInView,
  ownerOf,
  resolveCollision,
  integrateMovement,
  roomContains,
  roomExtent,
  roomWidth,
  totalCmp,
  validate,
  type Console,
  type InteriorLayoutError,
  type InteriorPlan,
  type Portal,
  type Room,
} from '../src/ship/interior.ts';

/** The shipped floor plan. */
function plan(): InteriorPlan {
  return crashedShip();
}

/** A deep copy, so each mutation test starts from an untouched table. */
function freshPlan(): InteriorPlan {
  return crashedShip();
}

/** Replaces `plan.rooms[index]` with a copy whose fields are merged in. */
function withRoom<T extends InteriorPlan>(plan: T, index: number, patch: Partial<Room>): T {
  const rooms = plan.rooms.map((room, i) => (i === index ? { ...room, ...patch } : room));
  return { ...plan, rooms };
}

/** Replaces `plan.consoles[index]` with a copy whose fields are merged in. */
function withConsole<T extends InteriorPlan>(
  plan: T,
  index: number,
  patch: Partial<Console>,
): T {
  const consoles = plan.consoles.map((c, i) => (i === index ? { ...c, ...patch } : c));
  return { ...plan, consoles };
}

/** Replaces `plan.portals` wholesale. */
function withPortals<T extends InteriorPlan>(plan: T, portals: Portal[]): T {
  return { ...plan, portals };
}

/** Removes `plan.portals[index]`. */
function withoutPortal<T extends InteriorPlan>(plan: T, index: number): T {
  return { ...plan, portals: plan.portals.filter((_, i) => i !== index) };
}

describe('the shipped plan', () => {
  it('is valid as shipped', () => {
    expect(validate(plan())).toBeNull();
  });

  it('has five rooms and six consoles', () => {
    const shipped = plan();
    expect(shipped.rooms.length).toBe(5);
    expect(shipped.consoles.length).toBe(6);
    expect(shipped.rooms.map((room) => room.name)).toEqual([
      'Cockpit',
      'Cabin',
      'Corridor',
      'Engineering',
      'Airlock',
    ]);
  });

  it('reads as a walkable ship from the cockpit to the airlock', () => {
    // Spot-walkable cells through the length of the ship, and the three that
    // are not: a corner of the cockpit, an engine bay cell, and a cell outside
    // every room.
    const shipped = plan();
    for (const cell of [
      [2, 1, 1],
      [3, 1, 5],
      [7, 1, 7],
      [8, 1, 8],
      [7, 1, 31],
    ] as const) {
      expect(isWalkable(shipped, cell), `${cell} is walkable`).toBe(true);
    }
    for (const cell of [
      [0, 1, 1],
      [2, 0, 3],
      [99, 1, 1],
    ] as const) {
      expect(isWalkable(shipped, cell), `${cell} is not walkable`).toBe(false);
    }
  });

  it('every room is at least as wide as the corridor, and every room is INTERIOR_HEIGHT tall', () => {
    // The Rust asserts `room.extent(1) == INTERIOR_HEIGHT` for every room, and
    // `room.width() >= CORRIDOR_WIDTH` — the width is extent(0), across the
    // port/starboard axis. The corridor is CORRIDOR_WIDTH wide in exactly that
    // axis, which is what makes it a corridor rather than a room.
    const shipped = plan();
    for (const room of shipped.rooms) {
      expect(roomWidth(room), `${room.name} is at least a corridor wide`).toBeGreaterThanOrEqual(
        CORRIDOR_WIDTH,
      );
      expect(roomExtent(room, 1), `${room.name} is INTERIOR_HEIGHT tall`).toBe(INTERIOR_HEIGHT);
    }
    const corridor = findRoom(shipped, 'Corridor');
    expect(corridor).not.toBeNull();
    if (corridor !== null) {
      expect(roomWidth(corridor)).toBe(CORRIDOR_WIDTH);
    }
  });

  it('has exactly one ruined console, and it is the comm console', () => {
    const shipped = plan();
    const ruined = shipped.consoles.filter((c) => c.condition === ConsoleCondition.Ruined);
    expect(ruined.length).toBe(1);
    expect(ruined[0]?.name).toBe('Comm console');
  });

  it('renders every console id the way the Rust Display does', () => {
    // `CONSOLE_ID_FIRST` is the floor of the id space; the rendering is
    // `console {id}`, which is what a plan error names.
    expect(consoleIdToString(CONSOLE_ID_FIRST)).toBe('console 0');
    expect(consoleIdToString(4)).toBe('console 4');
  });
});

describe('validate: room names', () => {
  it('accepts a duplicate room name', () => {
    // rooms[1] renamed to the name rooms[0] already holds.
    const broken = withRoom(plan(), 1, { name: 'Cockpit' });
    expect(validate(broken)).toEqual({ kind: 'DuplicateRoom', name: 'Cockpit' });
  });
});

describe('validate: portal names', () => {
  it('accepts a portal naming a room that does not exist', () => {
    const broken = withPortals(
      plan(),
      plan().portals.map((portal, i) => (i === 0 ? { ...portal, to: 'Nowhere' } : portal)),
    );
    expect(validate(broken)).toEqual({
      kind: 'UnknownRoom',
      portal: 0,
      name: 'Nowhere',
    });
  });
});

describe('validate: duplicate portals', () => {
  it('accepts the same doorway listed twice, normalised to the plan order', () => {
    const shipped = plan();
    const airlockPortal = shipped.portals.find(
      (portal) =>
        (portal.from === AIRLOCK_NAME || portal.to === AIRLOCK_NAME) &&
        (portal.from === EXTERIOR_NAME || portal.to === EXTERIOR_NAME),
    );
    expect(airlockPortal).toBeDefined();
    if (airlockPortal === undefined) {
      return;
    }
    const broken = withPortals(shipped, [...shipped.portals, { ...airlockPortal }]);
    expect(validate(broken)).toEqual({
      kind: 'DuplicatePortal',
      from: airlockPortal.from,
      to: airlockPortal.to,
    });
  });

  it('treats the reversed pair as the same doorway', () => {
    // The check deduplicates on the unordered pair, so a table that lists
    // "exterior"-"Airlock" after "Airlock"-"exterior" is one doorway twice.
    const shipped = plan();
    const airlockPortal = shipped.portals.find(
      (portal) =>
        (portal.from === AIRLOCK_NAME || portal.to === AIRLOCK_NAME) &&
        (portal.from === EXTERIOR_NAME || portal.to === EXTERIOR_NAME),
    );
    if (airlockPortal === undefined) {
      return;
    }
    const reversed: Portal = { ...airlockPortal, from: airlockPortal.to, to: airlockPortal.from };
    const broken = withPortals(shipped, [...shipped.portals, reversed]);
    expect(validate(broken)?.kind).toBe('DuplicatePortal');
  });
});

describe('validate: connectivity', () => {
  it('accepts a room cut off from the first room', () => {
    // Dropping the corridor-to-engineering portal seals Engineering off.
    const broken = withoutPortal(plan(), 3);
    expect(validate(broken)).toEqual({ kind: 'UnreachableRoom', name: 'Airlock' });
  });
});

describe('validate: overlap', () => {
  it('accepts two rooms claiming the same cells', () => {
    // Nudging the cabin's min back one column puts it inside the cockpit's
    // box, which is an overlap the cockpit/cabin seam never had.
    const broken = withRoom(plan(), 1, { min: [5, 0, 0] });
    expect(validate(broken)).toEqual({
      kind: 'OverlappingRooms',
      a: 'Cockpit',
      b: 'Cabin',
    });
  });

  it('a shifted room also stops owning the cells it used to', () => {
    const broken = withRoom(plan(), 1, { min: [5, 0, 0] });
    // The cell the cockpit now overlaps is claimed by both, so it has no single
    // owner and is not walkable.
    expect(isWalkable(broken, [5, 1, 1])).toBe(false);
    expect(ownerOf(broken, [5, 1, 1])).toBeNull();
  });
});

describe('validate: console rooms', () => {
  it('accepts a console in a room that does not exist', () => {
    const broken = withConsole(plan(), 0, { room: 'Nowhere' });
    expect(validate(broken)).toEqual({
      kind: 'ConsoleInUnknownRoom',
      console: 0,
      room: 'Nowhere',
    });
  });
});

describe('validate: console placement', () => {
  it('accepts a console standing outside the room it names', () => {
    const broken = withConsole(plan(), 0, { standAt: [9, 1, 1] });
    expect(validate(broken)).toEqual({ kind: 'ConsoleOutsideItsRoom', console: 0 });
  });
});

describe('validate: console clearance', () => {
  it('accepts a console standing in a wall', () => {
    // The cockpit's own boundary cell: inside the room's box, but inside the
    // wall's thickness, so a player could not stand there.
    const broken = withConsole(plan(), 0, { standAt: [0, 1, 0] });
    expect(validate(broken)).toEqual({ kind: 'ConsoleStandsInAWall', console: 0 });
  });
});

describe('the interior geometry constants', () => {
  it('pins the module constants the port must not drift from', () => {
    expect(INTERIOR_HEIGHT).toBe(3);
    expect(CORRIDOR_WIDTH).toBe(3);
    expect(PASSAGE_CLEARANCE).toBe(1);
    expect(AIRLOCK_NAME).toBe('Airlock');
    expect(EXTERIOR_NAME).toBe('exterior');
    expect(PLAYER_HALF_EXTENTS).toEqual([0.35, 0.9, 0.35]);
    expect(WALK_SPEED).toBe(2.2);
    expect(SPRINT_MULTIPLIER).toBe(1.9);
    expect(MOVE_DAMPING).toBe(9.0);
    expect(COLLISION_SKIN).toBe(0.01);
  });
});

describe('portals and walkable seams', () => {
  it('makes the cockpit-to-cabin seam walkable on both its boundary cells', () => {
    // The doorway between Cockpit and Cabin is a hole in the shared wall at
    // x=5/6, so both cells of the seam are walkable — that is what lets a
    // player cross.
    const shipped = plan();
    for (let z = 4; z <= 6; z += 1) {
      const walkable = isWalkable(shipped, [5, 1, z]) || isWalkable(shipped, [6, 1, z]);
      expect(walkable, `seam z=${z} is open`).toBe(true);
    }
  });

  it('counts the hatch threshold from both sides for the airlock', () => {
    // `inAirlock` is the one place the exterior side of a wall counts, because
    // standing in the open hatchway is still being in the airlock.
    const shipped = plan();
    expect(inAirlock(shipped, [7, 1, 31])).toBe(true);
    const airlock = findRoom(shipped, AIRLOCK_NAME);
    expect(airlock).not.toBeNull();
    if (airlock !== null) {
      // A cell well inside the airlock is in the airlock.
      expect(inAirlock(shipped, [airlock.min[0] + 1, 1, airlock.min[2] + 1])).toBe(true);
    }
    // A cell in the cockpit is not.
    expect(inAirlock(shipped, [2, 1, 1])).toBe(false);
  });

  it('keeps vacuum outside the ship unwalkable', () => {
    const shipped = plan();
    expect(isWalkable(shipped, [99, 1, 1])).toBe(false);
  });
});

describe('consoles', () => {
  it('finds consoles by id and by name', () => {
    const shipped = plan();
    expect(findConsole(shipped, 0)?.name).toBe('Nav table');
    expect(findConsole(shipped, 99)).toBeNull();
    expect(shipped.consoles.find((c) => c.id === 5)?.name).toBe('Power distribution');
  });

  it('reports console conditions that match the damage they relate to', () => {
    // A console reporting on a breached engine reads Flickering; one reporting
    // on an intact panel reads Functional.
    const shipped = plan();
    const damage = {
      engines: [{ missingNozzle: true }, { missingNozzle: false }],
      panels: [{ panel: 3, kind: 'missing' }],
      exposed: [1],
    };
    // Console 1 reports on engine 1, which is intact here.
    expect(consoleDamageState(shipped, 1, damage)).toBe(false);
    // Console 5 reports on engine 0, which is breached here.
    expect(consoleDamageState(shipped, 5, damage)).toBe(true);
    // Console 4 reports on panel 3, which is missing here.
    expect(consoleDamageState(shipped, 4, damage)).toBe(true);
    // Console 0 relates to nothing, so it is never damaged.
    expect(consoleDamageState(shipped, 0, damage)).toBe(false);
    expect(consoleDamageState(shipped, 99, damage)).toBe(false);
  });

  it('ignores scuffed panels, which are wear and not a hole', () => {
    const shipped = plan();
    const scuffedOnly = {
      engines: [{ missingNozzle: false }, { missingNozzle: false }],
      panels: [{ panel: 3, kind: 'scuffed' }],
      exposed: [],
    };
    // Console 4 relates to panel 3; scuffed plating is not a hole, so it
    // reports as undamaged.
    expect(consoleDamageState(shipped, 4, scuffedOnly)).toBe(false);
  });
});

describe('rooms', () => {
  it('contains its own cells and none outside its box', () => {
    const shipped = plan();
    const cockpit = findRoom(shipped, 'Cockpit');
    expect(cockpit).not.toBeNull();
    if (cockpit === null) {
      return;
    }
    expect(roomContains(cockpit, [cockpit.min[0], cockpit.min[1], cockpit.min[2]])).toBe(true);
    expect(roomContains(cockpit, [cockpit.max[0], cockpit.max[1], cockpit.max[2]])).toBe(true);
    expect(roomContains(cockpit, [cockpit.min[0] - 1, cockpit.min[1], cockpit.min[2]])).toBe(false);
    expect(roomContains(cockpit, [cockpit.max[0] + 1, cockpit.max[1], cockpit.max[2]])).toBe(false);
  });

  it('reports each room extent and width', () => {
    const shipped = plan();
    const cabin = findRoom(shipped, 'Cabin');
    expect(cabin).not.toBeNull();
    if (cabin === null) {
      return;
    }
    expect(roomExtent(cabin, 0)).toBe(cabin.max[0] - cabin.min[0] + 1);
    expect(roomExtent(cabin, 1)).toBe(cabin.max[1] - cabin.min[1] + 1);
    expect(roomExtent(cabin, 2)).toBe(cabin.max[2] - cabin.min[2] + 1);
    // `width()` is the port/starboard extent, which is axis 0.
    expect(roomWidth(cabin)).toBe(roomExtent(cabin, 0));
  });

  it('has no cell claimed by two rooms', () => {
    // `ownerOf` returns null for a doubly-claimed cell, which is the property
    // `validate`'s overlap check exists to guarantee.
    const shipped = plan();
    for (const room of shipped.rooms) {
      for (let x = room.min[0]; x <= room.max[0]; x += 1) {
        for (let y = room.min[1]; y <= room.max[1]; y += 1) {
          for (let z = room.min[2]; z <= room.max[2]; z += 1) {
            const owner = ownerOf(shipped, [x, y, z]);
            expect(owner, `cell ${x},${y},${z} has one owner`).not.toBeNull();
          }
        }
      }
    }
  });
});

describe('resolveCollision', () => {
  // A single wall plane at x=2, spanning y[0..3] and z[0..3]. Every fixture
  // below is the Rust `resolve_collision` test with the same numbers.
  const walls: readonly (readonly [readonly [number, number, number], readonly [number, number, number]])[] = [
    [[2.0, 0.0, 0.0], [2.0, 3.0, 3.0]],
  ];

  it('stops a body at the wall with the skin held off it', () => {
    // 2.0 - 0.35 half-extent - 0.01 skin = 1.64, and the velocity lane is
    // zeroed: the body's leading half-extent is what stops it, not its centre.
    const result = resolveCollision([0.0, 1.5, 1.0], [2.0, 0.0, 0.0], [2.0, 0.0, 0.0], walls);
    expect(Math.abs(result.position[0] - 1.64)).toBeLessThan(1.0e-6);
    expect(result.velocity[0]).toBe(0.0);
  });

  it('slides along a free axis while the blocked one stops', () => {
    // +x into the wall and +z along it: +x is clamped, +z advances the full
    // displacement. This is the whole interior experience — a diagonal approach
    // slides rather than stopping dead.
    const result = resolveCollision([0.0, 1.5, 1.0], [2.0, 0.0, 2.0], [2.0, 0.0, 2.0], walls);
    expect(Math.abs(result.position[0] - 1.64)).toBeLessThan(1.0e-6);
    expect(Math.abs(result.position[2] - 3.0)).toBeLessThan(1.0e-6);
    expect(result.velocity).toEqual([0.0, 0.0, 2.0]);
  });

  it('does not touch a wall behind the body, and advances freely against none', () => {
    const result = resolveCollision([5.0, 1.5, 1.0], [1.0, 0.0, 0.0], [1.0, 0.0, 0.0], walls);
    expect(result.position).toEqual([6.0, 1.5, 1.0]);
    expect(result.velocity).toEqual([1.0, 0.0, 0.0]);

    for (const emptyWalls of [
      [],
      [[[20.0, 0.0, 0.0], [20.0, 3.0, 3.0]]] as readonly (readonly [
        readonly [number, number, number],
        readonly [number, number, number],
      ])[],
    ]) {
      const moved = resolveCollision([0.0, 1.5, 1.0], [3.0, 2.0, 1.0], [3.0, 2.0, 1.0], emptyWalls);
      expect(moved.position).toEqual([3.0, 3.5, 2.0]);
      expect(moved.velocity).toEqual([3.0, 2.0, 1.0]);
    }
  });

  it('holds a body already inside a wall there, never teleporting it out', () => {
    // Starting at x=2 inside the wall plane and pushing +1: the displacement
    // clamps to zero (minus the skin) instead of ejecting the body to the face.
    const result = resolveCollision([2.0, 1.5, 1.0], [1.0, 0.0, 0.0], [1.0, 0.0, 0.0], walls);
    expect(Math.abs(result.position[0] - 1.99)).toBeLessThan(1.0e-6);
    expect(result.velocity[0]).toBe(0.0);
  });

  it('changes nothing on a frame that is not a move', () => {
    // Both the sub-skin nudge and a zero displacement: no cast is issued, so a
    // resting body against a wall does not jitter, and a body standing still
    // does not have a live velocity zeroed.
    const displacements: readonly [number, number, number][] = [
      [0.005, 0.0, 0.0],
      [0.0, 0.0, 0.0],
    ];
    for (const displacement of displacements) {
      const result = resolveCollision([0.0, 1.5, 1.0], displacement, [3.0, 0.0, 0.0], walls);
      expect(result.position).toEqual([0.0, 1.5, 1.0]);
      expect(result.velocity).toEqual([3.0, 0.0, 0.0]);
    }
  });

  it('passes extreme input through unchanged, bit for bit', () => {
    // The sanity guard exists so a NaN or an unbounded value is handed straight
    // back rather than carried through arithmetic. Checked per component,
    // because NaN compares unequal to itself.
    const origins: readonly [number, number, number][] = [
      [0.0, Number.NaN, 0.0],
      [2.0e6, 0.0, 0.0],
      [0.0, Number.POSITIVE_INFINITY, 0.0],
    ];
    for (const origin of origins) {
      const result = resolveCollision(origin, [1.0, 0.0, 0.0], [1.0, 0.0, 0.0], []);
      for (let axis = 0; axis < 3; axis += 1) {
        const index = axis as 0 | 1 | 2;
        expect(Object.is(result.position[index], origin[index]), `axis ${axis} changed`).toBe(true);
      }
      expect(result.velocity).toEqual([1.0, 0.0, 0.0]);
    }
  });
});

describe('integrateMovement', () => {
  it('is frame-rate independent on both the approach and the release', () => {
    // The `*= 0.9`-per-frame form this module exists to avoid: one frame of a
    // second and a hundred frames of a hundredth must land in the same place,
    // accelerating and stopping.
    const one = integrateMovement([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], false, 1.0);
    let hundred: [number, number, number] = [0.0, 0.0, 0.0];
    for (let i = 0; i < 100; i += 1) {
      hundred = integrateMovement(hundred, [1.0, 0.0, 0.0], false, 0.01);
    }
    expect(Math.abs(one[0] - hundred[0])).toBeLessThan(1.0e-5);

    const stoppedOne = integrateMovement([WALK_SPEED, 0.0, 0.0], [0.0, 0.0, 0.0], false, 1.0);
    let stoppedHundred: [number, number, number] = [WALK_SPEED, 0.0, 0.0];
    for (let i = 0; i < 100; i += 1) {
      stoppedHundred = integrateMovement(stoppedHundred, [0.0, 0.0, 0.0], false, 0.01);
    }
    expect(Math.abs(stoppedOne[0] - stoppedHundred[0])).toBeLessThan(1.0e-5);
  });

  it('leaves a few percent on release at 200 ms, and stops by 600 ms', () => {
    // The exact numbers MOVE_DAMPING's doc promises: 2.73% at 200 ms, and
    // effectively zero at 600 ms — but not zero at 200 ms, which the lower
    // bound pins.
    let fine: [number, number, number] = [WALK_SPEED, 0.0, 0.0];
    for (let i = 0; i < 200; i += 1) {
      fine = integrateMovement(fine, [0.0, 0.0, 0.0], false, 0.001);
    }
    const released = fine[0] / WALK_SPEED;
    expect(released).toBeLessThan(0.03);
    expect(released).toBeGreaterThan(1.0e-5);

    let coarse: [number, number, number] = [WALK_SPEED, 0.0, 0.0];
    for (let i = 0; i < 100; i += 1) {
      coarse = integrateMovement(coarse, [0.0, 0.0, 0.0], false, 0.006);
    }
    expect(coarse[0] / WALK_SPEED).toBeLessThan(1.0e-4);
  });

  it('approaches the wish target exponentially, never overshooting', () => {
    let v: [number, number, number] = [0.0, 0.0, 0.0];
    for (let i = 0; i < 200; i += 1) {
      v = integrateMovement(v, [1.0, 0.0, 0.0], false, 0.001);
    }
    // The gap closes exponentially: 1 - e^{-k dt} applied to the remaining gap,
    // so the target is approached from below and never exceeded.
    expect(v[0]).toBeGreaterThan(0);
    expect(v[0]).toBeLessThanOrEqual(WALK_SPEED);
    // One step of one second reaches the closed form exactly.
    const one = integrateMovement([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], false, 1.0);
    expect(one[0]).toBeCloseTo(WALK_SPEED * -Math.expm1(-MOVE_DAMPING * 1.0), 10);
  });

  it('sprints to exactly the multiplier of walk speed', () => {
    let walk: [number, number, number] = [0.0, 0.0, 0.0];
    let sprint: [number, number, number] = [0.0, 0.0, 0.0];
    for (let i = 0; i < 120; i += 1) {
      walk = integrateMovement(walk, [1.0, 0.0, 0.0], false, 1.0 / 60.0);
      sprint = integrateMovement(sprint, [1.0, 0.0, 0.0], true, 1.0 / 60.0);
    }
    expect(Math.abs(walk[0] - WALK_SPEED)).toBeLessThan(1.0e-3);
    expect(Math.abs(sprint[0] - WALK_SPEED * SPRINT_MULTIPLIER)).toBeLessThan(1.0e-3);
  });

  it('refuses a bad dt and treats a non-finite wish as no input', () => {
    expect(integrateMovement([1, 2, 3], [1, 1, 1], false, Number.NaN)).toEqual([1, 2, 3]);
    expect(integrateMovement([1, 2, 3], [1, 1, 1], false, -1)).toEqual([1, 2, 3]);
    const nanWish = [Number.NaN, 0, 0] as [number, number, number];
    const result = integrateMovement([1, 0, 0], nanWish, false, 0.01);
    // A non-finite wish is no input, so the axis decays rather than poisoning
    // the whole vector with NaN.
    expect(Number.isFinite(result[0])).toBe(true);
  });

  it('never produces a non-finite output from finite input', () => {
    const result = integrateMovement([1, 2, 3], [1, 1, 1], true, 1e9);
    for (const component of result) {
      expect(Number.isFinite(component)).toBe(true);
    }
  });
});

describe('nearestConsoleInView', () => {
  it('reports nothing past the range', () => {
    // From the cockpit, no console is within 3 units of [2, 1, 1].
    const shipped = plan();
    expect(nearestConsoleInView(shipped, [2, 1, 1], [0.0, 0.0, 1.0], 3.0, 0.9)).toBeNull();
  });

  it('reports nothing behind the player', () => {
    // Looking -z from the cabin's far end, nothing at all is in front of the
    // body: the cone is a cone, not a sphere.
    const shipped = plan();
    expect(nearestConsoleInView(shipped, [9, 1, 5], [0.0, 0.0, -1.0], 8.0, 0.9)).toBeNull();
  });

  it('reports nothing with a zero-length or non-finite direction', () => {
    // A zero-length direction divides by zero and builds a NaN cone, which
    // would admit whichever console the NaN comparison happened to pass.
    const shipped = plan();
    expect(nearestConsoleInView(shipped, [2, 1, 1], [0.0, 0.0, 0.0], 10.0, 0.9)).toBeNull();
    const nan = [Number.NaN, 0.0, 0.0] as [number, number, number];
    expect(nearestConsoleInView(shipped, [2, 1, 1], nan, 10.0, 0.9)).toBeNull();
  });

  it('does not report the console the player is standing in', () => {
    // The distance-zero guard: standing in a console's own cell, there is no
    // direction to be inside the cone of, so it is not the nearest.
    const shipped = plan();
    const nav = findConsole(shipped, 0);
    expect(nav).not.toBeNull();
    if (nav === null) {
      return;
    }
    const found = nearestConsoleInView(shipped, nav.standAt, [0.0, 0.0, 1.0], 30.0, -1.0);
    expect(found).not.toBe(0);
  });

  it('finds a console in front of the player inside the cone and range', () => {
    // Standing in the cockpit looking down the ship: the consoles at the far
    // end of the cockpit are inside the cone. The exact id is not what matters
    // here — the range and cone guards that reject every case above are.
    const shipped = plan();
    const found = nearestConsoleInView(shipped, [3, 1, 5], [0.0, 0.0, 1.0], 30.0, 0.9);
    expect(found).not.toBeNull();
  });
});

describe('totalCmp', () => {
  it('orders numbers the way f32::total_cmp does', () => {
    expect(totalCmp(1, 2)).toBeLessThan(0);
    expect(totalCmp(2, 1)).toBeGreaterThan(0);
    expect(totalCmp(1, 1)).toBe(0);
    // `-0.0` carries a sign bit, so it sorts ahead of `+0.0`.
    expect(totalCmp(-0, 0)).toBeLessThan(0);
    expect(totalCmp(0, -0)).toBeGreaterThan(0);
    expect(totalCmp(-0, -0)).toBe(0);
  });

  it('sorts every NaN after every number, including infinity', () => {
    // The Rust's `f32::total_cmp` puts all NaNs last, so a NaN hit never wins a
    // "nearest" comparison against a real number.
    expect(totalCmp(1e9, Number.NaN)).toBeLessThan(0);
    expect(totalCmp(Number.NaN, 1e9)).toBeGreaterThan(0);
    expect(totalCmp(Number.POSITIVE_INFINITY, Number.NaN)).toBeLessThan(0);
    expect(totalCmp(Number.NEGATIVE_INFINITY, Number.NaN)).toBeLessThan(0);
    expect(totalCmp(Number.NaN, Number.NaN)).toBe(0);
  });

  it('is antisymmetric across the whole range', () => {
    const values = [
      Number.NEGATIVE_INFINITY,
      -1.5,
      -1,
      0,
      1,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.NaN,
    ];
    for (const a of values) {
      for (const b of values) {
        // `+0` and `-0` both mean "equal" here, so normalise before comparing.
        expect(totalCmp(a, b)).toBe(-totalCmp(b, a) || 0);
      }
    }
  });
});

describe('the interior layout errors', () => {
  it('renders each variant with the Rust wording', () => {
    const cases: readonly [InteriorLayoutError, string][] = [
      [{ kind: 'DuplicateRoom', name: 'Cockpit' }, 'room "Cockpit" appears more than once'],
      [
        { kind: 'UnknownRoom', portal: 0, name: 'Nowhere' },
        'portal 0 names unknown room "Nowhere"',
      ],
      [
        { kind: 'DuplicatePortal', from: 'Airlock', to: 'exterior' },
        'portal "Airlock" - "exterior" appears more than once',
      ],
      [
        { kind: 'UnreachableRoom', name: 'Engineering' },
        'room "Engineering" is not reachable from the first room',
      ],
      [
        { kind: 'OverlappingRooms', a: 'Cockpit', b: 'Cabin' },
        'rooms "Cockpit" and "Cabin" claim the same cells',
      ],
      [
        { kind: 'ConsoleInUnknownRoom', console: 0, room: 'Nowhere' },
        'console 0 names unknown room "Nowhere"',
      ],
      [
        { kind: 'ConsoleOutsideItsRoom', console: 0 },
        'console 0 stands outside the room it names',
      ],
      [
        { kind: 'ConsoleStandsInAWall', console: 0 },
        'console 0 stands inside its room\'s wall',
      ],
    ];
    for (const [error, message] of cases) {
      expect(interiorLayoutErrorMessage(error)).toBe(message);
    }
  });
});

describe('validate: check order is part of the contract', () => {
  it('reports the first failing check, always the same one', () => {
    // A plan with several faults always names the same one: the checks run in
    // table order, so a designer fixing them one at a time gets a sequence
    // rather than a shuffle.
    const broken = withRoom(withRoom(freshPlan(), 1, { name: 'Cockpit' }), 1, {
      min: [5, 0, 0],
    });
    // DuplicateRoom is check 1, OverlappingRooms is check 5: the first wins.
    expect(validate(broken)).toEqual({ kind: 'DuplicateRoom', name: 'Cockpit' });
  });

  it('each mutation triggers exactly its own check on an otherwise valid plan', () => {
    // One violating plan per check, and nothing else broken: a table with
    // exactly one fault per row is what makes the order testable at all.
    const shipped = freshPlan();
    const mutations: readonly [string, () => InteriorPlan, string][] = [
      [
        'DuplicateRoom',
        () => withRoom(shipped, 1, { name: 'Cockpit' }),
        'DuplicateRoom',
      ],
      [
        'UnknownRoom',
        () =>
          withPortals(
            shipped,
            shipped.portals.map((p, i) => (i === 0 ? { ...p, to: 'Nowhere' } : p)),
          ),
        'UnknownRoom',
      ],
      [
        'DuplicatePortal',
        () => {
          const airlock = shipped.portals.find(
            (p) =>
              (p.from === AIRLOCK_NAME || p.to === AIRLOCK_NAME) &&
              (p.from === EXTERIOR_NAME || p.to === EXTERIOR_NAME),
          );
          return airlock === undefined
            ? shipped
            : withPortals(shipped, [...shipped.portals, { ...airlock }]);
        },
        'DuplicatePortal',
      ],
      ['UnreachableRoom', () => withoutPortal(shipped, 3), 'UnreachableRoom'],
      [
        'OverlappingRooms',
        () => withRoom(shipped, 1, { min: [5, 0, 0] }),
        'OverlappingRooms',
      ],
      [
        'ConsoleInUnknownRoom',
        () => withConsole(shipped, 0, { room: 'Nowhere' }),
        'ConsoleInUnknownRoom',
      ],
      [
        'ConsoleOutsideItsRoom',
        () => withConsole(shipped, 0, { standAt: [9, 1, 1] }),
        'ConsoleOutsideItsRoom',
      ],
      [
        'ConsoleStandsInAWall',
        () => withConsole(shipped, 0, { standAt: [0, 1, 0] }),
        'ConsoleStandsInAWall',
      ],
    ];
    for (const [name, mutate, expected] of mutations) {
      const error = validate(mutate());
      expect(error?.kind, `${name} check fires`).toBe(expected);
    }
  });
});
