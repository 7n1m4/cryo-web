/**
 * The voxel hull: a deterministic, engine-free description of the player's ship.
 *
 * A faithful port of `/home/vi/cryo/src/ship/voxel.rs`. No ECS, no window, no
 * GPU, no clock, no environment. Everything it needs is passed in, so the same
 * config always produces the same geometry.
 *
 * # Axes
 *
 * Coordinates are integer cell indices, `x` / `y` / `z`, with the origin at the
 * grid's minimum corner:
 *
 * - `x` runs port to starboard (`width`);
 * - `y` runs keel to spine (`height`), so `y = 0` is the lowest row;
 * - `z` runs nose to tail (`length`), so `z = 0` is the front of the grid.
 *
 * A voxel at `(x, y, z)` fills the unit cell `[x, x+1) x [y, y+1) x [z, z+1)`.
 *
 * # Meshing strategy: face culling
 *
 * `meshHullOfGrid` emits one quad per exposed voxel face: for every occupied
 * voxel and every one of its six faces, the face is emitted only when the
 * neighbour in that direction is empty (or lies outside the grid, which counts
 * as empty). Indices are `u16`-bounded: a hull larger than `MAX_MESH_VERTICES`
 * fails to mesh with `MeshError.TooManyVertices` rather than silently growing.
 *
 * # Determinism
 *
 * The same `HullConfig` always yields the same grid and the same mesh. The only
 * "randomness" is `Rng`, a splitmix64 generator seeded from
 * `HullConfig.seed`; it jitters where a few fittings are bolted on. It never
 * decides *what* gets damaged — `DamageConfig` describes damage explicitly.
 *
 * # 64-bit values
 *
 * `Seed.value` and the Rng state are `BigInt` here, because the Rust module
 * holds them in `u64` and JS numbers are not 2^64-safe. All of the mixing
 * arithmetic is therefore `BigInt`, and every product is masked back into the
 * `u64` range explicitly. A change to any of these masks changes the seed
 * stream, and the four `Rng.below` call sites' order is part of the contract.
 */

/** The id an empty grid cell holds: index `0`, reserved for "nothing here". */
export class VoxelId {
  private constructor(private readonly index: number) {}

  /** The id stored in every empty cell. */
  static readonly EMPTY = new VoxelId(0);
  /** Primary hull: the structural fill of the ship. */
  static readonly HULL = new VoxelId(1);
  /** Ivory accent: the registration stripe along the spine. */
  static readonly IVORY_ACCENT = new VoxelId(2);
  /** Graphite trim: trim castings and landing pads. */
  static readonly GRAPHITE_TRIM = new VoxelId(3);
  /** Dark navy panel: the modular plating that covers the hull. */
  static readonly NAVY_PANEL = new VoxelId(4);
  /** Repair-access panel: a plating section distinguished from the rest. */
  static readonly REPAIR_ACCESS = new VoxelId(5);
  /** Engine housing: the special-purpose voxels of the two rear nacelles. */
  static readonly ENGINE_HOUSING = new VoxelId(6);
  /** Cockpit glazing: transparent hull sections and the canopy extra's tint. */
  static readonly GLAZING = new VoxelId(7);
  /** Landing leg. */
  static readonly LANDING_GEAR = new VoxelId(8);
  /** Radiator panel. */
  static readonly RADIATOR = new VoxelId(9);
  /** Equipment mount: a small fitting bolted to the outside of the hull. */
  static readonly EQUIPMENT_MOUNT = new VoxelId(10);
  /** Exposed internal structure: plating burnt or torn away. */
  static readonly EXPOSED_STRUCTURE = new VoxelId(11);
  /** Warning light, amber. Reads as a fault. */
  static readonly WARNING_LIGHT_AMBER = new VoxelId(12);
  /** Warning light, cool white. Reads as nominal. */
  static readonly WARNING_LIGHT_COOL = new VoxelId(13);
  /** Scuffed plating: paint worn, structure intact. */
  static readonly SCUFFED = new VoxelId(14);
  /** Landing pad: the foot of a landing leg. */
  static readonly LANDING_PAD = new VoxelId(15);

  /** An id from its raw palette index, for hand-written test code. */
  static fromIndex(index: number): VoxelId {
    return new VoxelId(index);
  }

  /** The palette index this id addresses. */
  getIndex(): number {
    return this.index;
  }

  /** Whether this id marks an empty cell. */
  isEmpty(): boolean {
    return this.index === 0;
  }

  /**
   * The palette entry for this id, or `null` for an id outside the table.
   *
   * The explicit `null` is the point: code that invents an id learns about it
   * here instead of silently getting black voxels.
   */
  paletteEntry(): PaletteEntry | null {
    return PALETTE.find((entry) => entry.id.getIndex() === this.index) ?? null;
  }

  /** The human-readable name of this id, `"unknown"` outside the table. */
  name(): string {
    return this.paletteEntry()?.name ?? 'unknown';
  }

  /** The sRGB colour triple for this id under `palette`. */
  rgb(palette: PaletteChoice): Rgb {
    return paletteColor(palette, this);
  }

  /**
   * The alpha value a consumer should pair with `color_f32_rgba`.
   *
   * Everything solid is `1.0`. Glazing is translucent.
   */
  alpha(): number {
    return this.index === VoxelId.GLAZING.getIndex() ? 0.45 : 1.0;
  }

  /**
   * The colour as `[r, g, b, a]`, each channel in 0.0..=1.0.
   *
   * Four channels, not three: an engine colour attribute is a 4-channel
   * attribute, so the vertex buffer a consumer builds from this matches the
   * engine's expected stride with no conversion and no padding surprise.
   */
  colorF32Rgba(palette: PaletteChoice): [number, number, number, number] {
    const [r, g, b] = this.rgb(palette).toF32();
    return [r, g, b, this.alpha()];
  }
}

/** An 8-bit-per-channel colour, as plain data. */
export class Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;

  constructor(r: number, g: number, b: number) {
    this.r = r;
    this.g = g;
    this.b = b;
  }

  /** Pure black, the "no such colour" answer. */
  static readonly BLACK = new Rgb(0, 0, 0);

  /** The colour as `[r, g, b]`, each channel in 0.0..=1.0. */
  toF32(): [number, number, number] {
    return [this.r / 255, this.g / 255, this.b / 255];
  }
}

/** One row of the palette: the id a grid stores and what to call it. */
export class PaletteEntry {
  constructor(readonly id: VoxelId, readonly name: string) {}
}

/** How many entries `PALETTE` holds, including the reserved empty id's slot. */
export const PALETTE_SIZE = 16;

/**
 * Every hull material the generator can assign.
 *
 * The rows are ordered by id, and the livery tables rely on that: a colour
 * table is indexed by `VoxelId.index`, so entry *i* and colour *i* must
 * describe the same material.
 */
export const PALETTE: readonly PaletteEntry[] = [
  new PaletteEntry(VoxelId.EMPTY, 'empty'),
  new PaletteEntry(VoxelId.HULL, 'primary hull'),
  new PaletteEntry(VoxelId.IVORY_ACCENT, 'ivory accent'),
  new PaletteEntry(VoxelId.GRAPHITE_TRIM, 'graphite trim'),
  new PaletteEntry(VoxelId.NAVY_PANEL, 'dark navy panel'),
  new PaletteEntry(VoxelId.REPAIR_ACCESS, 'repair access panel'),
  new PaletteEntry(VoxelId.ENGINE_HOUSING, 'engine housing'),
  new PaletteEntry(VoxelId.GLAZING, 'cockpit glazing'),
  new PaletteEntry(VoxelId.LANDING_GEAR, 'landing leg'),
  new PaletteEntry(VoxelId.RADIATOR, 'radiator panel'),
  new PaletteEntry(VoxelId.EQUIPMENT_MOUNT, 'equipment mount'),
  new PaletteEntry(VoxelId.EXPOSED_STRUCTURE, 'exposed structure'),
  new PaletteEntry(VoxelId.WARNING_LIGHT_AMBER, 'warning light (amber)'),
  new PaletteEntry(VoxelId.WARNING_LIGHT_COOL, 'warning light (cool)'),
  new PaletteEntry(VoxelId.SCUFFED, 'scuffed plating'),
  new PaletteEntry(VoxelId.LANDING_PAD, 'landing pad'),
];

/** Which livery paints the hull. */
export enum PaletteChoice {
  /** Grey-and-navy long-range livery with an ivory registration stripe. */
  Explorer = 'exploration livery',
  /** Chalkier, bluer cold-weather livery with a pale-ice stripe. */
  Icebound = 'icebound livery',
}

/**
 * The sRGB colour this livery paints `id`, black for an id outside the table.
 *
 * The bounds check is what stops an invented id from indexing off the end of the
 * array, and the black it returns is the same "no such colour" everywhere else.
 */
function paletteColor(palette: PaletteChoice, id: VoxelId): Rgb {
  const index = id.getIndex();
  const table = palette === PaletteChoice.Explorer ? LIVERY_EXPLORER : LIVERY_ICEBOUND;
  if (index < PALETTE_SIZE) {
    return table[index] ?? Rgb.BLACK;
  }
  return Rgb.BLACK;
}

/** The grey-and-navy long-range exploration livery, with an ivory stripe. */
const LIVERY_EXPLORER: readonly Rgb[] = [
  Rgb.BLACK, // EMPTY
  new Rgb(112, 122, 138), // HULL
  new Rgb(230, 223, 203), // IVORY_ACCENT
  new Rgb(58, 63, 70), // GRAPHITE_TRIM
  new Rgb(35, 43, 58), // NAVY_PANEL
  new Rgb(176, 138, 84), // REPAIR_ACCESS
  new Rgb(46, 50, 60), // ENGINE_HOUSING
  new Rgb(126, 192, 212), // GLAZING
  new Rgb(78, 84, 94), // LANDING_GEAR
  new Rgb(98, 106, 120), // RADIATOR
  new Rgb(62, 68, 78), // EQUIPMENT_MOUNT
  new Rgb(124, 98, 76), // EXPOSED_STRUCTURE
  new Rgb(226, 166, 60), // WARNING_LIGHT_AMBER
  new Rgb(110, 190, 200), // WARNING_LIGHT_COOL
  new Rgb(88, 94, 104), // SCUFFED
  new Rgb(44, 49, 58), // LANDING_PAD
];

/**
 * The cold-weather livery, for a hull that has spent a winter on the ice.
 *
 * Every row of `LIVERY_EXPLORER` is present here except the two warning lights,
 * whose colours are a statement rather than a decoration — amber reads as a
 * fault and cool reads as nominal, so a livery that repainted them would make
 * the warning lights lie.
 */
const LIVERY_ICEBOUND: readonly Rgb[] = [
  Rgb.BLACK, // EMPTY
  new Rgb(84, 98, 112), // HULL
  new Rgb(186, 214, 226), // IVORY_ACCENT
  new Rgb(46, 56, 68), // GRAPHITE_TRIM
  new Rgb(30, 48, 66), // NAVY_PANEL
  new Rgb(150, 168, 158), // REPAIR_ACCESS
  new Rgb(38, 48, 62), // ENGINE_HOUSING
  new Rgb(158, 214, 228), // GLAZING
  new Rgb(66, 80, 96), // LANDING_GEAR
  new Rgb(88, 106, 122), // RADIATOR
  new Rgb(52, 66, 82), // EQUIPMENT_MOUNT
  new Rgb(104, 118, 132), // EXPOSED_STRUCTURE
  new Rgb(226, 166, 60), // WARNING_LIGHT_AMBER
  new Rgb(110, 190, 200), // WARNING_LIGHT_COOL
  new Rgb(74, 90, 104), // SCUFFED
  new Rgb(36, 46, 60), // LANDING_PAD
];

/** An occupied cell, as yielded by `VoxelGrid.iterOccupied`. */
export interface OccupiedVoxel {
  /** Port/starboard index. */
  readonly x: number;
  /** Keel/spine index. */
  readonly y: number;
  /** Nose/tail index. */
  readonly z: number;
  /** The material occupying this cell. */
  readonly id: VoxelId;
}

/**
 * The explicit voxel lattice the generator produces and the mesher consumes.
 *
 * The grid is a flat array of `VoxelId`s with `z` the outer axis, so a scan
 * front-to-back walks memory forwards. It stores the full bounding box
 * (`width` x `height` x `length`), not a tight extent.
 *
 * # Bounds semantics
 *
 * Reading outside the grid is *answered*: `occupied` returns `false` and `get`
 * returns `null`. Writing outside the grid is a documented no-op. Panicking
 * would push a bounds check into the mesher's innermost loop, and treating
 * out-of-range as occupied would seal the ship shut.
 */
export class VoxelGrid {
  private readonly cells: VoxelId[];

  private constructor(
    readonly width: number,
    readonly height: number,
    readonly length: number,
    cells: VoxelId[],
  ) {
    this.cells = cells;
  }

  /** A grid of the given dimensions with every cell empty. */
  static new(width: number, height: number, length: number): VoxelGrid {
    return VoxelGrid.filled(width, height, length, VoxelId.EMPTY);
  }

  /** A grid of the given dimensions with every cell set to `id`. */
  static filled(width: number, height: number, length: number, id: VoxelId): VoxelGrid {
    const capacity = width * height * length;
    return new VoxelGrid(width, height, length, new Array<VoxelId>(capacity).fill(id));
  }

  /** The grid's dimensions as `[width, height, length]`. */
  dimensions(): [number, number, number] {
    return [this.width, this.height, this.length];
  }

  /** Total cells, occupied or not. */
  capacity(): number {
    return this.cells.length;
  }

  /** Whether a coordinate is inside the grid's bounds. */
  contains(x: number, y: number, z: number): boolean {
    return x < this.width && y < this.height && z < this.length && x >= 0 && y >= 0 && z >= 0;
  }

  /**
   * The flat storage index of a coordinate, or `null` if out of bounds.
   *
   * `z`-major linearisation: `x + width*y + plane*z`.
   */
  indexOf(x: number, y: number, z: number): number | null {
    if (!this.contains(x, y, z)) {
      return null;
    }
    const plane = this.width * this.height;
    return x + this.width * y + plane * z;
  }

  /** The id at a coordinate, or `null` if the coordinate is out of bounds. */
  get(x: number, y: number, z: number): VoxelId | null {
    const index = this.indexOf(x, y, z);
    return index === null ? null : (this.cells[index] ?? null);
  }

  /** Whether a coordinate is occupied. Out-of-range reports `false`. */
  occupied(x: number, y: number, z: number): boolean {
    const id = this.get(x, y, z);
    return id !== null && !id.isEmpty();
  }

  /** Sets the voxel at a coordinate. Out-of-range writes do nothing. */
  set(x: number, y: number, z: number, id: VoxelId): void {
    const index = this.indexOf(x, y, z);
    if (index !== null) {
      this.cells[index] = id;
    }
  }

  /** Clears the voxel at a coordinate. Out-of-range writes do nothing. */
  clear(x: number, y: number, z: number): void {
    this.set(x, y, z, VoxelId.EMPTY);
  }

  /** How many cells are occupied. */
  occupiedCount(): number {
    return this.cells.reduce((count, cell) => (cell.isEmpty() ? count : count + 1), 0);
  }

  /** Whether no cell is occupied. */
  isEmpty(): boolean {
    return this.cells.every((cell) => cell.isEmpty());
  }

  /**
   * Visits only the occupied cells, in the exact `z`-major storage order.
   *
   * Vertex order and therefore indices depend on this traversal, so the order
   * is part of the contract, not an implementation detail.
   */
  *iterOccupied(): Generator<OccupiedVoxel> {
    const plane = this.width * this.height;
    const width = this.width;
    for (let index = 0; index < this.cells.length; index += 1) {
      const cell = this.cells[index];
      if (cell === undefined || cell.isEmpty()) {
        continue;
      }
      const z = Math.floor(index / plane);
      const rest = index % plane;
      yield { x: rest % width, y: Math.floor(rest / width), z, id: cell };
    }
  }
}

/** What is wrong with one engine housing. */
export class EngineDamage {
  private constructor(
    /** Which engine, port or starboard (`0` or `1`). */
    readonly index: number,
    /** Whether the housing is missing its nozzle, leaving an open end. */
    readonly missingNozzle: boolean,
  ) {}

  /** An engine housing with nothing wrong with it. */
  static intact(index: number): EngineDamage {
    return new EngineDamage(index, false);
  }

  /** An engine housing whose nozzle is gone. */
  static breached(index: number): EngineDamage {
    return new EngineDamage(index, true);
  }
}

/** How a hull panel is damaged. */
export enum PanelDamageKind {
  /** Plating missing: a hole you can see the interior through. */
  Missing = 'missing panel',
  /** Paint and surface worn, structure intact. */
  Scuffed = 'scuffed panel',
}

/** One damaged hull panel, named by its panel index rather than by coordinates. */
export class PanelDamage {
  private constructor(
    /** Panel index, counting back from the nose. */
    readonly panel: number,
    /** What is wrong with it. */
    readonly kind: PanelDamageKind,
  ) {}

  /** A panel with plating missing. */
  static missing(panel: number): PanelDamage {
    return new PanelDamage(panel, PanelDamageKind.Missing);
  }

  /** A panel with worn paint. */
  static scuffed(panel: number): PanelDamage {
    return new PanelDamage(panel, PanelDamageKind.Scuffed);
  }
}

/** The warning lights fitted to the hull. */
export interface WarningLights {
  /** How many lights to fit. */
  readonly count: number;
  /** Amber reads as a fault; not amber reads as nominal. */
  readonly amber: boolean;
}

/** The id of the voxel a fitted light uses. */
function warningLightVoxelId(lights: WarningLights): VoxelId {
  return lights.amber ? VoxelId.WARNING_LIGHT_AMBER : VoxelId.WARNING_LIGHT_COOL;
}

/**
 * A description of the ship's damage, not a decision to make it.
 *
 * Every field is data: which engine, which panel, how bad, how many warning
 * lights. The generator applies this list literally and never rolls dice for it.
 */
export class DamageConfig {
  private constructor(
    /** Per-engine damage. Engines not listed are intact. */
    readonly engines: readonly EngineDamage[],
    /** Panels with plating missing or scuffed. */
    readonly panels: readonly PanelDamage[],
    /** Panels stripped down to exposed internal structure. */
    readonly exposed: readonly number[],
    /** Warning lights, and whether they read amber. */
    readonly warningLights: WarningLights,
  ) {}

  /** No damage at all. */
  static default(): DamageConfig {
    return new DamageConfig(
      [EngineDamage.intact(0), EngineDamage.intact(1)],
      [],
      [],
      { count: 0, amber: false },
    );
  }

  /** The damage the game opens with. */
  static openingDamage(): DamageConfig {
    return new DamageConfig(
      [EngineDamage.breached(0), EngineDamage.intact(1)],
      [PanelDamage.missing(3), PanelDamage.scuffed(6), PanelDamage.missing(8)],
      [1],
      { count: 4, amber: true },
    );
  }

  /**
   * An arbitrary damage configuration, for a test or a designer's fixture.
   *
   * Named rather than a public constructor because `default` and
   * `openingDamage` are the two configurations the game ships, and everything
   * else is a fixture that should read as one.
   */
  static fixture(
    engines: readonly EngineDamage[],
    panels: readonly PanelDamage[],
    exposed: readonly number[],
    warningLights: WarningLights,
  ): DamageConfig {
    return new DamageConfig(engines, panels, exposed, warningLights);
  }

  /** Whether this configuration describes any damage at all. */
  isEmpty(): boolean {
    return (
      this.engines.every((engine) => !engine.missingNozzle) &&
      this.panels.length === 0 &&
      this.exposed.length === 0 &&
      this.warningLights.count === 0
    );
  }
}

/** Everything the generator needs to build a hull. */
export interface HullConfig {
  /** Nose-to-tail length of the hull proper, in voxels, excluding the engine housings. */
  readonly length: number;
  /** Hull width at midship, in voxels. */
  readonly hullWidth: number;
  /** Hull height at midship, in voxels. */
  readonly hullHeight: number;
  /** Seed for the generator's placement jitter. Same seed, same geometry. */
  readonly seed: bigint;
  /** What is wrong with the ship. */
  readonly damage: DamageConfig;
  /** Which livery paints the hull's colours. */
  readonly palette: PaletteChoice;
}

/** Nose-to-tail length used by `hullConfigDefault`. */
export const DEFAULT_LENGTH = 40;
/** Midship hull width used by `hullConfigDefault`. */
export const DEFAULT_WIDTH = 10;
/** Midship hull height used by `hullConfigDefault`. */
export const DEFAULT_HEIGHT = 8;
/** Seed used by `hullConfigDefault`. */
export const DEFAULT_SEED: bigint = 0x5eedc0den;

/** An undamaged hull with the default proportions and the default seed. */
export function hullConfigDefault(): HullConfig {
  return {
    length: DEFAULT_LENGTH,
    hullWidth: DEFAULT_WIDTH,
    hullHeight: DEFAULT_HEIGHT,
    seed: DEFAULT_SEED,
    damage: DamageConfig.default(),
    palette: PaletteChoice.Explorer,
  };
}

/** The hull the game opens with: default proportions, opening-scene damage. */
export function hullConfigDamagedOpening(): HullConfig {
  return { ...hullConfigDefault(), damage: DamageConfig.openingDamage() };
}

/** A copy of `config` with a different seed. */
export function withSeed(config: HullConfig, seed: bigint): HullConfig {
  return { ...config, seed };
}

// ---------------------------------------------------------------------------
// Geometry constants. A seed may move a fitting, it may never move the ship
// inside its own bounding box, which is what lets the dimension assertions be
// exact rather than approximate.
// ---------------------------------------------------------------------------

/** Half-width, in columns, of the nose tip before the taper runs. */
const NOSE_HALF_W = 3;
/** Half-height, in rows, of the nose tip before the taper runs. */
const NOSE_HALF_H = 2;
/** Columns over which the nose tapers out to the midship section. */
const NOSE_TAPER = 8;
/** How much higher the nose section sits than the midship section. */
const NOSE_RISE = 2;
/** Half-width the hull shrinks to before the engine housings take over. */
const TAIL_HALF_W = 4;
/** Half-height the hull shrinks to before the engine housings take over. */
const TAIL_HALF_H = 3;
/** Columns over which the hull tapers in toward the tail. */
const TAIL_TAPER = 5;
/** Extra half-width of the midship habitation bulge. */
const BULGE_W = 2;
/** Extra half-height of the midship habitation bulge. */
const BULGE_H = 1;
/** Columns the midship bulge spans. */
const BULGE_LEN = 7;

/** Columns left ahead of the nose tip inside the grid. */
const NOSE_CLEARANCE = 4;
/** Columns left behind the tail for the engine housings. */
const TAIL_CLEARANCE = 8;
/** Columns left on each side of the hull for radiators and mounts. */
const SIDE_CLEARANCE = 4;
/** Rows left below the keel for the landing gear and pads. */
const KEEL_CLEARANCE = 6;
/** Rows left above the spine for dorsal equipment. */
const DORSAL_CLEARANCE = 3;
/** Columns per modular panel section, counting back from the nose. */
const PANEL_STRIDE = 4;
/** Panel sections are repainted as repair access every fourth band. */
const REPAIR_ACCESS_PERIOD = 4;

/** Number of engine housings. */
const ENGINE_COUNT = 2;
/** Offset of each engine housing's centre from the hull centreline. */
const ENGINE_OFFSET = 3;
/** Half-width of an engine housing, so it spans three columns. */
const ENGINE_HALF_W = 1;
/** Z-layers of an engine housing that a breach chews away. */
const BREACH_DEPTH = 3;
/** Z-offset of the landing gear aft of the nose tip. */
const LEG_Z_OFFSET = 13;
/** Half-width of a landing pad. */
const PAD_HALF_W = 1;
/** Half-length of a landing pad. */
const PAD_HALF_LEN = 2;
/** Rows a landing leg spans, up to the hull underside. */
const LEG_ROWS = 3;
/** Half-height of a radiator panel. */
const RADIATOR_HALF_H = 1;
/** Half-length of a radiator panel. */
const RADIATOR_HALF_LEN = 1;
/** How far past the hull a radiator panel reaches. */
const RADIATOR_REACH = 2;

/** The hull cross-section at one z plane. */
interface Section {
  /** Half-width in columns. */
  readonly halfW: number;
  /** Half-height in rows. */
  readonly halfH: number;
  /** Centre row, raised toward the front for the cockpit wedge. */
  readonly centreY: number;
}

/** The single source of truth for the ship's proportions. */
interface Geometry {
  readonly width: number;
  readonly height: number;
  readonly length: number;
  readonly centreX: number;
  readonly centreY: number;
  readonly noseZ: number;
  readonly tailZ: number;
  readonly bulgeZ0: number;
  readonly bulgeZ1: number;
  readonly hullHalfW: number;
  readonly hullHalfH: number;
  readonly panelCount: number;
}

/**
 * An `i32` coordinate, saturating rather than wrapping.
 *
 * Saturating at `i32::MAX` is safe: no coordinate a caller can reach is
 * anywhere near that, and a saturation would mean a grid of two billion cells
 * on one axis, which the mesher would have refused long before.
 */
function fromU32(value: number): number {
  return Math.min(value, 0x7fffffff);
}

/** A `u32` coordinate, clamped into range rather than wrapping or panicking. */
function toU32(value: number): number {
  return value < 0 ? 0 : value;
}

/** Rust's `u32::saturating_add`. */
function saturatingAdd(a: number, b: number): number {
  return Math.min(a + b, 0xffffffff);
}

/** Computes the grid dimensions and landmarks for a config. */
function geometryFor(config: HullConfig): Geometry {
  const hullWidth = Math.max(config.hullWidth, 4);
  const hullHeight = Math.max(config.hullHeight, 3);
  const length = Math.max(config.length, 12);

  // Odd extents keep the centreline on an integer column, so the ship is
  // symmetric about x without a half-cell drift.
  //
  // Saturating, not wrapping: a `u32::MAX` hull would otherwise overflow the
  // sum and wrap to a nonsense grid.
  const width = saturatingAdd(saturatingAdd(hullWidth, 2 * SIDE_CLEARANCE), 1);
  const height = saturatingAdd(saturatingAdd(saturatingAdd(hullHeight, KEEL_CLEARANCE), DORSAL_CLEARANCE), 1);
  const gridLength = saturatingAdd(length, saturatingAdd(NOSE_CLEARANCE, TAIL_CLEARANCE));

  const noseZ = NOSE_CLEARANCE;
  const tailZ = length - 1 + noseZ;
  const panelCount = Math.floor((tailZ - noseZ) / PANEL_STRIDE) + 1;

  return {
    width,
    height,
    length: gridLength,
    centreX: fromU32(Math.floor(width / 2)),
    centreY: fromU32(Math.floor(height / 2)),
    noseZ,
    tailZ,
    bulgeZ0: noseZ + NOSE_TAPER + 4,
    bulgeZ1: noseZ + NOSE_TAPER + 4 + BULGE_LEN - 1,
    hullHalfW: fromU32(Math.floor(hullWidth / 2)),
    hullHalfH: fromU32(Math.floor(hullHeight / 2)),
    panelCount,
  };
}

/** Lowest row of the hull proper, above the landing gear. */
function keelY(geo: Geometry): number {
  return geo.centreY - geo.hullHalfH;
}

/** Highest row of the hull proper, below the dorsal equipment. */
function spineY(geo: Geometry): number {
  return geo.centreY + geo.hullHalfH;
}

/**
 * The z range a panel index covers, clamped to the hull.
 *
 * `null` for a panel index the hull does not have, so damage that names a
 * non-existent panel is ignored rather than applied somewhere random.
 */
function panelRange(geo: Geometry, panel: number): readonly [number, number] | null {
  if (panel >= geo.panelCount) {
    return null;
  }
  const z0 = geo.noseZ + panel * PANEL_STRIDE;
  const z1 = Math.min(z0 + PANEL_STRIDE - 1, geo.tailZ);
  return [z0, z1];
}

/** Which id the plating of a given z band uses. */
function panelId(geo: Geometry, z: number): VoxelId {
  const panel = Math.floor((z - geo.noseZ) / PANEL_STRIDE);
  return panel % REPAIR_ACCESS_PERIOD === 2 ? VoxelId.REPAIR_ACCESS : VoxelId.NAVY_PANEL;
}

/** The x centreline of engine `index`. */
function engineCentreX(geo: Geometry, index: number): number {
  return index % 2 === 0 ? geo.centreX - ENGINE_OFFSET : geo.centreX + ENGINE_OFFSET;
}

/** The z range the engine housings occupy, past the hull's tail. */
function engineZRange(geo: Geometry): readonly [number, number] {
  return [geo.tailZ + 1, geo.length - 1];
}

/** The z station the landing gear is centred on. */
function legZ(geo: Geometry): number {
  return geo.noseZ + LEG_Z_OFFSET;
}

/**
 * Integer interpolation with round-to-nearest.
 *
 * The generator does its taper maths in integers so the shape is exactly
 * reproducible: no platform-dependent float rounding can creep into a
 * coordinate that a determinism test compares byte for byte.
 */
function mixI(a: number, b: number, num: number, den: number): number {
  const scaled = (b - a) * num;
  if (scaled >= 0) {
    return a + Math.floor((scaled + Math.floor(den / 2)) / den);
  }
  return a - Math.floor((-scaled + Math.floor(den / 2)) / den);
}

/** The hull cross-section at z, or `null` ahead of the nose or behind the tail. */
function sectionAt(geo: Geometry, z: number): Section | null {
  const nose = geo.noseZ;
  const tail = geo.tailZ;
  const zz = z;
  if (zz < nose || zz > tail) {
    return null;
  }

  let halfW = geo.hullHalfW;
  let halfH = geo.hullHalfH;
  let rise = 0;

  if (zz < nose + NOSE_TAPER) {
    // Nose taper: the front converges from a small section to the midship
    // section, and sits higher, so the bow reads as a cockpit wedge rather
    // than a flat-cut cylinder.
    const t = zz - nose + 1;
    halfW = mixI(NOSE_HALF_W, geo.hullHalfW, t, NOSE_TAPER);
    halfH = mixI(NOSE_HALF_H, geo.hullHalfH, t, NOSE_TAPER);
    rise = Math.floor(((NOSE_TAPER - (zz - nose)) * NOSE_RISE) / NOSE_TAPER);
  } else if (zz > tail - TAIL_TAPER) {
    // Tail taper: the hull shrinks so the engine housings can take over the
    // stern without reading as an afterthought bolted on.
    const t = zz - (tail - TAIL_TAPER);
    halfW = mixI(geo.hullHalfW, TAIL_HALF_W, t, TAIL_TAPER);
    halfH = mixI(geo.hullHalfH, TAIL_HALF_H, t, TAIL_TAPER);
  }

  if (zz >= geo.bulgeZ0 && zz <= geo.bulgeZ1) {
    // Habitation bulge: wider *and* taller than the hull line it interrupts.
    halfW += BULGE_W;
    halfH += BULGE_H;
  }

  return { halfW, halfH, centreY: geo.centreY + rise };
}

/** Whether a voxel's cell touches anything the culling mesher would draw. */
function hasExposedNeighbour(grid: VoxelGrid, x: number, y: number, z: number): boolean {
  const OFFSETS: readonly (readonly [number, number, number])[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  return OFFSETS.some(([dx, dy, dz]) => !grid.occupied(x + dx, y + dy, z + dz));
}

/**
 * A small, self-contained splitmix64 generator.
 *
 * Exported because the tests pin its exact stream: the generator's few jittered
 * choices are reproducible without a dependency, and the four `below` call
 * sites' order in `fillFittings` is part of the contract.
 */
export class Rng {
  /** `2^64`, the modulus the mixing arithmetic wraps at. */
  private static readonly MASK = (1n << 64n) - 1n;
  private state: bigint;

  /** Seeds the stream. */
  constructor(seed: bigint) {
    this.state = seed & Rng.MASK;
  }

  /** The next 64 bits of the stream. */
  nextU64(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & Rng.MASK;
    let z = this.state;
    z = (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n & Rng.MASK;
    z = (z ^ (z >> 27n)) * 0x94d049bb133111ebn & Rng.MASK;
    return (z ^ (z >> 31n)) & Rng.MASK;
  }

  /** A value in `0..bound`. */
  below(bound: number): number {
    if (bound <= 0) {
      throw new Error('a zero bound would divide by zero');
    }
    return Number(this.nextU64() % BigInt(bound));
  }
}

/** The generator seeds its stream with the config seed XOR this constant. */
const SEED_MIX: bigint = 0x54879c3a1e210f13n;

/** A generated hull: the voxel grid, the config it came from, and its extras. */
export class HullPlan {
  private constructor(
    readonly grid: VoxelGrid,
    readonly config: HullConfig,
    private readonly geometry: Geometry,
    readonly extras: readonly ExtraMesh[],
  ) {}

  /**
   * Builds the hull described by `config`.
   *
   * Postconditions, asserted by tests and relied upon by presentation:
   * - the grid's dimensions match the config's proportions exactly;
   * - the silhouette requirements hold;
   * - the damage in `config.damage` is applied literally, not sampled.
   */
  static generate(config: HullConfig): HullPlan {
    const geometry = geometryFor(config);
    const rng = new Rng(config.seed ^ SEED_MIX);

    const grid = VoxelGrid.new(geometry.width, geometry.height, geometry.length);
    fillHull(grid, geometry);
    fillEngines(grid, geometry);
    fillLandingGear(grid, geometry);
    fillFittings(grid, geometry, rng);
    paintLivery(grid, geometry);
    applyDamage(grid, geometry, config.damage);
    markInterior(grid, geometry);

    const extras = buildExtras(geometry);
    return new HullPlan(grid, config, geometry, extras);
  }

  /** z of the foremost hull voxel: the nose tip. */
  noseTipZ(): number {
    return this.geometry.noseZ;
  }

  /** z of the rearmost hull voxel, before the engine housings. */
  hullTailZ(): number {
    return this.geometry.tailZ;
  }

  /** Lowest row of the hull proper, above the landing gear. */
  keelY(): number {
    return toU32(keelY(this.geometry));
  }

  /** Highest row of the hull proper, below the dorsal equipment. */
  spineY(): number {
    return toU32(spineY(this.geometry));
  }

  /** The x centreline of the hull. */
  centreX(): number {
    return toU32(this.geometry.centreX);
  }

  /** How many occupied voxels the z plane at `z` holds, `0` if out of range. */
  crossSectionArea(z: number): number {
    let count = 0;
    for (const voxel of this.grid.iterOccupied()) {
      if (voxel.z === z) {
        count += 1;
      }
    }
    return count;
  }

  /** The widest z plane of the generated grid, as `[z, area]`. */
  widestSection(): [number, number] {
    let bestZ = 0;
    let bestArea = 0;
    for (let z = 0; z < this.grid.length; z += 1) {
      const area = this.crossSectionArea(z);
      if (area > bestArea) {
        bestZ = z;
        bestArea = area;
      }
    }
    return [bestZ, bestArea];
  }

  /** Number of modular panel sections the hull carries, counting from the nose. */
  panelCount(): number {
    return this.geometry.panelCount;
  }

  /** Meshes this plan (see `meshHull`). */
  mesh(): ShipMesh {
    return meshHull(this);
  }
}

/** Fills the hull body with modular plating. */
function fillHull(grid: VoxelGrid, geo: Geometry): void {
  for (let z = 0; z < geo.length; z += 1) {
    const section = sectionAt(geo, z);
    if (section === null) {
      continue;
    }
    const id = panelId(geo, z);
    for (let x = 0; x < geo.width; x += 1) {
      const dx = fromU32(x) - geo.centreX;
      if (Math.abs(dx) > section.halfW) {
        continue;
      }
      for (let y = 0; y < geo.height; y += 1) {
        const dy = fromU32(y) - section.centreY;
        if (Math.abs(dy) > section.halfH) {
          continue;
        }
        grid.set(x, y, z, id);
      }
    }
  }
}

/** Fills the two engine housings, which project past the hull's tail. */
function fillEngines(grid: VoxelGrid, geo: Geometry): void {
  const [z0, z1] = engineZRange(geo);
  for (let index = 0; index < ENGINE_COUNT; index += 1) {
    const centreX = engineCentreX(geo, index);
    for (let x = centreX - ENGINE_HALF_W; x <= centreX + ENGINE_HALF_W; x += 1) {
      for (let y = keelY(geo) + 1; y <= spineY(geo) - 1; y += 1) {
        for (let z = z0; z <= z1; z += 1) {
          grid.set(toU32(x), toU32(y), z, VoxelId.ENGINE_HOUSING);
        }
      }
    }
  }
}

/** Fills the landing gear: two legs and two pads, below the hull underside. */
function fillLandingGear(grid: VoxelGrid, geo: Geometry): void {
  const gearZ = legZ(geo);
  const keel = keelY(geo);
  const padY = keel - LEG_ROWS - 1;
  for (let index = 0; index < ENGINE_COUNT; index += 1) {
    const centreX = engineCentreX(geo, index);
    // The leg: one column wide, standing from the pad up to the hull.
    for (let x = centreX; x <= centreX; x += 1) {
      for (let y = keel - LEG_ROWS; y <= keel - 1; y += 1) {
        for (let z = gearZ - 1; z <= gearZ + 1; z += 1) {
          grid.set(toU32(x), toU32(y), toU32(z), VoxelId.LANDING_GEAR);
        }
      }
    }
    // The pad: wider and longer than the leg, standing the leg off the ground
    // so the ship reads as landed rather than impaled.
    for (let x = centreX - PAD_HALF_W; x <= centreX + PAD_HALF_W; x += 1) {
      for (let z = gearZ - PAD_HALF_LEN; z <= gearZ + PAD_HALF_LEN; z += 1) {
        grid.set(toU32(x), toU32(padY), toU32(z), VoxelId.LANDING_PAD);
      }
    }
  }
}

/**
 * Fills the small fittings that make the hull read as a working ship.
 *
 * Radiators on both flanks and a dorsal equipment mount, with their positions
 * jittered by the seed. This is the only place the seed touches the shape.
 *
 * The four `rng.below` calls below are in a fixed order — it is the contract:
 * the seed stream is consumed in exactly this sequence, so reordering them
 * changes where every fitting lands.
 */
function fillFittings(grid: VoxelGrid, geo: Geometry, rng: Rng): void {
  for (let station = 0; station < 2; station += 1) {
    const z = geo.noseZ + 20 + station * 7 + rng.below(4);
    const yJitter = rng.below(3) - 1;
    const section = sectionAt(geo, toU32(z));
    if (section === null) {
      continue;
    }
    for (const side of [-1, 1]) {
      for (let reach = 0; reach < RADIATOR_REACH; reach += 1) {
        const x = geo.centreX + side * (section.halfW + reach);
        for (let dy = -RADIATOR_HALF_H; dy <= RADIATOR_HALF_H; dy += 1) {
          const y = geo.centreY + yJitter + dy;
          for (let dz = -RADIATOR_HALF_LEN; dz <= RADIATOR_HALF_LEN; dz += 1) {
            grid.set(toU32(x), toU32(y), toU32(z + dz), VoxelId.RADIATOR);
          }
        }
      }
    }
  }

  const mountX = geo.centreX - 2 + rng.below(5);
  const mountZ = geo.noseZ + 30 + rng.below(4);
  for (let dy = 1; dy <= 2; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      grid.set(toU32(mountX + dx), toU32(spineY(geo) + dy), toU32(mountZ), VoxelId.EQUIPMENT_MOUNT);
    }
  }
}

/**
 * Applies the described damage, literally and in a fixed order.
 *
 * Nothing here samples randomness: every change is traceable to a field of
 * `DamageConfig`. Panel and exposed-structure damage is applied first, so the
 * engine breach and the warning lights sit on top of whatever the panels did.
 */
function applyDamage(grid: VoxelGrid, geo: Geometry, damage: DamageConfig): void {
  for (const panel of damage.panels) {
    const range = panelRange(geo, panel.panel);
    if (range === null) {
      continue;
    }
    const [z0, z1] = range;
    // One pass over the whole band's plating, collecting what to touch before
    // touching anything. Reading the grid while writing it would make the
    // result depend on the order cells are visited in.
    for (const [x, y, z] of bandSurface(grid, geo, z0, z1, panel.kind)) {
      if (panel.kind === PanelDamageKind.Missing) {
        grid.clear(x, y, z);
      } else {
        grid.set(x, y, z, VoxelId.SCUFFED);
      }
    }
  }

  for (const panel of damage.exposed) {
    const range = panelRange(geo, panel);
    if (range === null) {
      continue;
    }
    const [z0, z1] = range;
    for (let z = z0; z <= z1; z += 1) {
      for (let x = 0; x < geo.width; x += 1) {
        for (let y = 0; y < geo.height; y += 1) {
          const id = grid.get(x, y, z);
          if (id === null) {
            continue;
          }
          if (isPlating(id) && hasExposedNeighbour(grid, x, y, z)) {
            grid.set(x, y, z, VoxelId.EXPOSED_STRUCTURE);
          }
        }
      }
    }
  }

  for (const engine of damage.engines) {
    if (engine.missingNozzle) {
      breachEngine(grid, geo, engine.index);
    }
  }

  placeWarningLights(grid, geo, damage.warningLights);
}

/**
 * The surface cells of a band of panels, in storage order.
 *
 * Damage names panels, and a panel is a stretch of *plating* on the outside of
 * the ship — a landing leg, a radiator fin or an engine housing belongs to its
 * own fitting, and damage that reached it here would be attributable to a field
 * that never names it.
 */
function bandSurface(
  grid: VoxelGrid,
  geo: Geometry,
  z0: number,
  z1: number,
  kind: PanelDamageKind,
): [number, number, number][] {
  const cells: [number, number, number][] = [];
  for (let z = z0; z <= z1; z += 1) {
    for (let x = 0; x < geo.width; x += 1) {
      for (let y = 0; y < geo.height; y += 1) {
        const id = grid.get(x, y, z);
        if (id === null) {
          continue;
        }
        if (!isPlating(id) || !hasExposedNeighbour(grid, x, y, z)) {
          continue;
        }
        // `Missing` punches through; `Scuffed` only marks the outermost layer,
        // which already has an exposed neighbour by construction.
        if (kind === PanelDamageKind.Scuffed && z !== z1) {
          continue;
        }
        cells.push([x, y, z]);
      }
    }
  }
  return cells;
}

/** Whether an id is modular hull plating, as opposed to a fitting or structure. */
function isPlating(id: VoxelId): boolean {
  return id === VoxelId.NAVY_PANEL || id === VoxelId.REPAIR_ACCESS;
}

/**
 * Chews the nozzle off one engine housing.
 *
 * The pattern is derived from the coordinates, not from the seed, so the same
 * damaged config always leaves the same bite: incomplete rather than simply
 * short, and plainly visible from behind.
 */
function breachEngine(grid: VoxelGrid, geo: Geometry, index: number): void {
  const [, z1] = engineZRange(geo);
  const cut = z1 - (BREACH_DEPTH - 1);
  const centreX = engineCentreX(geo, index);
  for (let z = cut; z <= z1; z += 1) {
    for (let x = centreX - ENGINE_HALF_W; x <= centreX + ENGINE_HALF_W; x += 1) {
      for (let y = keelY(geo) + 1; y <= spineY(geo) - 1; y += 1) {
        // Keep a ligament here and there so the housing has ribs, not a clean
        // bite.
        const keep = (y + (z - cut)) % 3 === 0;
        if (!keep) {
          grid.clear(toU32(x), toU32(y), z);
        }
      }
    }
  }
}

/**
 * Fits the warning lights along the spine.
 *
 * A light whose seat is not plating is skipped: a warning light glued to a
 * radiator fin would read as a bug.
 */
function placeWarningLights(grid: VoxelGrid, geo: Geometry, lights: WarningLights): void {
  for (let k = 0; k < lights.count; k += 1) {
    const z = geo.noseZ + 5 + 3 * k;
    const side = k % 2 === 0 ? -2 : 2;
    const x = geo.centreX + side;
    const section = sectionAt(geo, toU32(z));
    if (section === null) {
      continue;
    }
    const y = section.centreY + section.halfH;
    const cx = toU32(x);
    const cy = toU32(y);
    const cz = toU32(z);
    const id = grid.get(cx, cy, cz);
    if (id === null) {
      continue;
    }
    if (isPlating(id)) {
      grid.set(cx, cy, cz, warningLightVoxelId(lights));
    }
  }
}

/**
 * Repaints fully enclosed plating as primary hull.
 *
 * A voxel with no exposed face can never be seen through the culled-face
 * mesher, so spending a distinct panel id on it is wasted: this pass collapses
 * the sealed interior to the primary hull colour, and means "panel" in the grid
 * really does mean "visible plating".
 */
function markInterior(grid: VoxelGrid, geo: Geometry): void {
  for (let z = 0; z < geo.length; z += 1) {
    for (let x = 0; x < geo.width; x += 1) {
      for (let y = 0; y < geo.height; y += 1) {
        const id = grid.get(x, y, z);
        if (id === null) {
          continue;
        }
        if (!isPlating(id)) {
          continue;
        }
        if (!hasExposedNeighbour(grid, x, y, z)) {
          grid.set(x, y, z, VoxelId.HULL);
        }
      }
    }
  }
}

/** Paints the ivory registration stripe along the spine. */
function paintLivery(grid: VoxelGrid, geo: Geometry): void {
  for (const band of [geo.noseZ + 10, geo.noseZ + 24]) {
    for (let dz = 0; dz < 2; dz += 1) {
      const z = band + dz;
      const section = sectionAt(geo, toU32(z));
      if (section === undefined || section === null) {
        continue;
      }
      const stripeY = section.centreY + section.halfH;
      const x = geo.centreX;
      const cy = toU32(stripeY);
      const cz = toU32(z);
      if (grid.occupied(x, cy, cz)) {
        grid.set(x, cy, cz, VoxelId.IVORY_ACCENT);
      }
    }
  }
}

/** The kind of non-voxel detail an `ExtraMesh` describes. */
export enum ExtraMeshKind {
  /** The cockpit canopy. */
  CockpitGlazing = 'cockpit glazing',
  /** The glow behind an engine. */
  EngineGlow = 'engine glow',
  /** The pad a landing leg stands on. */
  LandingPad = 'landing pad',
}

/** A non-voxel detail the presentation layer adds on top of the voxel mesh. */
export class ExtraMesh {
  constructor(
    /** Which detail this is. */
    readonly kind: ExtraMeshKind,
    /** Centre of the detail, in ship-local voxel space. */
    readonly center: readonly [number, number, number],
    /** Half-extents of the detail's box, in voxel units. */
    readonly halfExtents: readonly [number, number, number],
    /** The material this detail borrows its colour from. */
    readonly tint: VoxelId,
  ) {}

  /** The colour triple the presentation layer should paint this detail with. */
  color(palette: PaletteChoice): Rgb {
    return this.tint.rgb(palette);
  }

  /** The colour as `[r, g, b, a]`, each channel in 0.0..=1.0. */
  colorF32Rgba(palette: PaletteChoice): [number, number, number, number] {
    return this.tint.colorF32Rgba(palette);
  }
}

/** Builds the non-voxel details for a hull. */
function buildExtras(geo: Geometry): ExtraMesh[] {
  const extras: ExtraMesh[] = [];

  // The canopy sits just ahead of the nose tip, over the raised cockpit wedge,
  // so the glazing is where the taper says the crew sits.
  const canopySection = sectionAt(geo, geo.noseZ + 1);
  if (canopySection !== null) {
    extras.push(
      new ExtraMesh(
        ExtraMeshKind.CockpitGlazing,
        [geo.centreX, canopySection.centreY + canopySection.halfH, geo.noseZ - 1.5],
        [1.6, 0.9, 1.0],
        VoxelId.GLAZING,
      ),
    );
  }

  const [, z1] = engineZRange(geo);
  const engineY = (keelY(geo) + spineY(geo)) / 2;
  for (let index = 0; index < ENGINE_COUNT; index += 1) {
    extras.push(
      new ExtraMesh(
        ExtraMeshKind.EngineGlow,
        [engineCentreX(geo, index), engineY, z1 + 0.5],
        [1.3, 1.3, 0.5],
        // Port engine burns hot: amber there reads as a fault, which is exactly
        // the engine the damage config breaches.
        index % 2 === 0 ? VoxelId.WARNING_LIGHT_AMBER : VoxelId.ENGINE_HOUSING,
      ),
    );
    extras.push(
      new ExtraMesh(
        ExtraMeshKind.LandingPad,
        [engineCentreX(geo, index), keelY(geo) - LEG_ROWS - 0.75, legZ(geo)],
        [PAD_HALF_W + 0.5, 0.25, PAD_HALF_LEN + 0.5],
        VoxelId.GRAPHITE_TRIM,
      ),
    );
  }

  return extras;
}

/**
 * Explicit geometry for a hull, in plain arrays.
 *
 * The vertex attributes and their strides, which is the contract a consumer
 * builds from:
 *
 * | field | per vertex | meaning |
 * |---|---|---|
 * | `positions` | 3 x `f32` | ship-local voxel-space corner, always present |
 * | `normals` | 3 x `f32` | the exposed face's outward normal, unit length |
 * | `colors` | 4 x `f32` | RGBA in 0.0..=1.0 |
 * | `voxelIds` | 1 id | the palette id |
 * | `indices` | `u16` triangles | three indices per triangle, two per quad |
 *
 * Colour is 4-channel on purpose: that matches the engine's colour attribute
 * format, so a consumer uploads it as-is.
 */
export interface ShipMesh {
  readonly positions: readonly [number, number, number][];
  readonly normals: readonly [number, number, number][];
  readonly colors: readonly [number, number, number, number][];
  readonly voxelIds: readonly VoxelId[];
  readonly indices: readonly number[];
  /** Non-voxel details, carried through so one call produces everything. */
  readonly extras: readonly ExtraMesh[];
}

/** How many vertices this mesh holds. */
function vertexCount(mesh: ShipMesh): number {
  return mesh.positions.length;
}

/** How many triangles this mesh holds. */
function triangleCount(mesh: ShipMesh): number {
  return Math.floor(mesh.indices.length / 3);
}

/** How many quads this mesh holds, which is exactly its exposed voxel faces. */
function quadCount(mesh: ShipMesh): number {
  return Math.floor(mesh.indices.length / 6);
}

/** Whether this mesh has no geometry at all. */
function meshIsEmpty(mesh: ShipMesh): boolean {
  return mesh.positions.length === 0 && mesh.indices.length === 0;
}

/**
 * The largest vertex count a `u16` index buffer may address.
 *
 * A `u16` index holds `0..=65_535`, so the cap is 65_535 *vertices*: index
 * 65_535 must still refer to a vertex. `meshHullOfGrid` refuses to exceed this
 * rather than silently growing the index type, because a ship whose indices
 * silently became `u32` would break every consumer's stride assumption exactly
 * once, in production, at the worst moment.
 */
export const MAX_MESH_VERTICES = 65535;

/** Why a mesh could not be produced. */
export type MeshError =
  | { readonly kind: 'TooManyVertices'; readonly vertices: number; readonly limit: number };

/** The Rust `Display` rendering of a `MeshError`. */
export function meshErrorMessage(error: MeshError): string {
  switch (error.kind) {
    case 'TooManyVertices':
      return `the hull needs ${error.vertices} vertices, which exceeds the ${error.limit} a \`u16\` index can address`;
  }
}

/** One face of the unit cube: an outward normal plus four corners. */
interface FaceDef {
  readonly normal: readonly [number, number, number];
  readonly corners: readonly (readonly [number, number, number])[];
}

/**
 * The six faces of a voxel, in a fixed order.
 *
 * Corners are listed so that triangles `(0, 1, 2)` and `(0, 2, 3)` are
 * counter-clockwise when viewed from outside the cube along the normal, which
 * keeps the winding and the stated normal agreeing. This table is the mesher's
 * entire geometric knowledge; the loop around it is bookkeeping.
 */
const FACES: readonly FaceDef[] = [
  // +X
  { normal: [1, 0, 0], corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  // -X
  { normal: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  // +Y
  { normal: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  // -Y
  { normal: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  // +Z
  { normal: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  // -Z
  { normal: [0, 0, -1], corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];

/**
 * Whether the cell one step along a face's normal is occupied.
 *
 * Coordinates are widened to signed integers so a step off the front of the
 * grid becomes a negative number instead of a wrap-around, and anything outside
 * the grid counts as empty. That is the whole boundary rule: a voxel on the
 * edge of the lattice has no neighbour there, so its outward face is real
 * geometry.
 */
function neighbourIsOccupied(grid: VoxelGrid, voxel: OccupiedVoxel, face: FaceDef): boolean {
  const nx = voxel.x + (face.normal[0] ?? 0);
  const ny = voxel.y + (face.normal[1] ?? 0);
  const nz = voxel.z + (face.normal[2] ?? 0);
  // Anything outside `u32` cannot be a grid coordinate, so it counts as empty.
  if (nx < 0 || ny < 0 || nz < 0) {
    return false;
  }
  if (nx > 0xffffffff || ny > 0xffffffff || nz > 0xffffffff) {
    return false;
  }
  return grid.occupied(nx, ny, nz);
}

/**
 * Converts a voxel grid into explicit geometry, culling internal faces.
 *
 * This is the mesher proper, and it takes a grid rather than a plan so the
 * culling rule can be checked against any shape — a solid block, a single
 * voxel, a hand-built test lattice — without going through the generator.
 *
 * `palette` is required rather than defaulted. A grid carries ids and no
 * opinion about colour, so a mesher that guessed one would silently repaint
 * whatever a caller handed it. It affects only the colour attribute, never a
 * position, a normal or an index.
 *
 * For every occupied voxel and every one of its six faces, the face is emitted
 * only when the neighbour along that face's normal is not an occupied voxel.
 * Interior faces can therefore never be produced:
 *
 * ```text
 * faces = 2 * (w*h + w*l + h*l)   for a w x h x l filled box
 * ```
 *
 * An out-of-bounds neighbour counts as not occupied, so a shape that touches
 * the edge of its grid still gets the faces it would show a viewer.
 *
 * Determinism follows from the iteration order: `iterOccupied` walks storage
 * front to back and `FACES` is a fixed table, so the same grid always yields
 * the same vertex order and the same indices.
 *
 * @throws {MeshError} if the geometry would exceed `MAX_MESH_VERTICES`.
 */
export function meshHullOfGrid(grid: VoxelGrid, palette: PaletteChoice): ShipMesh {
  const positions: [number, number, number][] = [];
  const normals: [number, number, number][] = [];
  const colors: [number, number, number, number][] = [];
  const voxelIds: VoxelId[] = [];
  const indices: number[] = [];

  const error = fillMesh(grid, palette, positions, normals, colors, voxelIds, indices);
  if (error !== null) {
    throw new MeshErrorThrown(error);
  }
  return { positions, normals, colors, voxelIds, indices, extras: [] };
}

/**
 * Converts a voxel grid into explicit geometry, with the plan's non-voxel
 * details attached.
 *
 * This is `meshHullOfGrid` with the plan's details carried, and is what a
 * presentation layer should call: one call yields both the hull's own geometry
 * and the canopy, glows and pads that sit on top of it.
 *
 * @throws {MeshError} if the geometry would exceed `MAX_MESH_VERTICES`.
 */
export function meshHull(plan: HullPlan): ShipMesh {
  const grid = plan.grid;
  const positions: [number, number, number][] = [];
  const normals: [number, number, number][] = [];
  const colors: [number, number, number, number][] = [];
  const voxelIds: VoxelId[] = [];
  const indices: number[] = [];

  const error = fillMesh(grid, plan.config.palette, positions, normals, colors, voxelIds, indices);
  if (error !== null) {
    throw new MeshErrorThrown(error);
  }
  return { positions, normals, colors, voxelIds, indices, extras: plan.extras };
}

/**
 * Emits the culled faces of `grid` into `mesh`, appending to whatever is there.
 *
 * The `vertices + 4 > MAX_MESH_VERTICES` pre-check is per face, so the mesher
 * refuses before writing a vertex it could not index.
 */
function fillMesh(
  grid: VoxelGrid,
  palette: PaletteChoice,
  positions: [number, number, number][],
  normals: [number, number, number][],
  colors: [number, number, number, number][],
  voxelIds: VoxelId[],
  indices: number[],
): MeshError | null {
  for (const voxel of grid.iterOccupied()) {
    for (const face of FACES) {
      if (neighbourIsOccupied(grid, voxel, face)) {
        continue;
      }
      const vertexBase = positions.length;
      if (vertexBase + 4 > MAX_MESH_VERTICES) {
        return { kind: 'TooManyVertices', vertices: vertexBase + 4, limit: MAX_MESH_VERTICES };
      }

      // `vertexBase + 4 <= MAX_MESH_VERTICES = u16::MAX` was just checked, so
      // the base index always fits a `u16`.
      const normal: [number, number, number] = [
        face.normal[0] ?? 0,
        face.normal[1] ?? 0,
        face.normal[2] ?? 0,
      ];
      const color = voxel.id.colorF32Rgba(palette);
      for (const corner of face.corners) {
        positions.push([voxel.x + (corner[0] ?? 0), voxel.y + (corner[1] ?? 0), voxel.z + (corner[2] ?? 0)]);
        normals.push(normal);
        colors.push(color);
        voxelIds.push(voxel.id);
      }
      indices.push(vertexBase, vertexBase + 1, vertexBase + 2, vertexBase, vertexBase + 2, vertexBase + 3);
    }
  }

  return null;
}

/**
 * A thrown `MeshError`, carrying the typed error as a property.
 *
 * The Rust module returns `Result<ShipMesh, MeshError>`; a TS function cannot
 * return both, so the error is thrown and the typed union is attached to it as
 * `error` so a caller can match on it without parsing a message.
 */
export class MeshErrorThrown extends Error {
  constructor(readonly error: MeshError) {
    super(meshErrorMessage(error));
    this.name = 'MeshError';
  }
}

/** How many vertices a mesh holds. */
export { vertexCount, triangleCount, quadCount, meshIsEmpty };
