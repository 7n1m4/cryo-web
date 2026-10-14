/**
 * The raw input state: what is held, what went down this frame.
 *
 * Kept as plain arrays of key codes rather than a `Map`, because the set of keys
 * a CRYO frame cares about is small and fixed, and the walking code only ever
 * asks "is this key held" and "which keys went down this frame" — both of which
 * are a scan.
 */

/** The input state one frame reads. */
export interface InputState {
  /** The keys currently held down. */
  readonly held: readonly string[];
  /** The keys that went down since the previous frame. */
  readonly pressedThisFrame: readonly string[];
}

/** A frame of edge-detected input. */
export interface InputFrame {
  /** The keys that went down this frame. */
  readonly pressed: readonly string[];
}

/**
 * The edge detector.
 *
 * `beginFrame` records what was already down, `endFrame` clears the edge list.
 * A key held across two frames appears in `held` on both but in
 * `pressedThisFrame` on only the first — which is the whole one-shot behaviour.
 */
export class InputTracker {
  private readonly down: Record<string, true> = {};
  private readonly pressed: Record<string, true> = {};
  private readonly heldKeys: string[] = [];

  /** Records a key going down, and edges it. */
  press(code: string): void {
    if (this.down[code] === true) {
      // A repeat event from the OS, not a second press.
      return;
    }
    this.down[code] = true;
    this.pressed[code] = true;
    this.rebuildHeld();
  }

  /** Records a key going up. */
  release(code: string): void {
    delete this.down[code];
    this.rebuildHeld();
  }

  /** The keys that went down this frame. */
  frame(): InputFrame {
    return { pressed: Object.keys(this.pressed) };
  }

  /** The current input state. */
  state(): InputState {
    return { held: [...this.heldKeys], pressedThisFrame: Object.keys(this.pressed) };
  }

  /** Ends the frame, clearing every edge. */
  endFrame(): void {
    for (const code of Object.keys(this.pressed)) {
      delete this.pressed[code];
    }
  }

  private rebuildHeld(): void {
    this.heldKeys.length = 0;
    for (const code of Object.keys(this.down)) {
      this.heldKeys.push(code);
    }
  }
}
