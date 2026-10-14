/**
 * The HUD: a DOM overlay.
 *
 * Chosen over `babylonjs-gui` because the interior is 36 metres of walkable
 * space at a world scale, and a GUI layer's advanced dynamic texture renders at
 * the canvas's device pixel ratio: text then scales with the canvas rather than
 * with the display, and a 13px line goes soft on a HiDPI monitor. A DOM node
 * stays crisp at any ratio, needs no post-process, and is trivially testable —
 * `setHudText` is a string assignment, so a headless test asserts on text.
 */

import type { GameState } from '../app.ts';

/** The DOM ids the HUD owns. */
export const HUD_IDS = {
  root: 'cryo-hud',
  state: 'cryo-state',
  title: 'cryo-title',
  prompt: 'cryo-prompt',
} as const;

/** The one-line status the HUD shows while playing. */
export interface HudStatus {
  /** The simulation clock. */
  readonly clock: string;
  /** The player's activity. */
  readonly activity: string;
  /** The suit charge, 0..=100. */
  readonly suitCharge: number;
}

/** Renders a HUD status line the way the Rust interior HUD does. */
export function formatHudStatus(status: HudStatus): string {
  return `${status.clock} · ${status.activity} · suit ${status.suitCharge}%`;
}

/**
 * Writes `text` into the HUD's state element.
 *
 * A no-op when the element is missing, which is the headless case: the HUD is
 * decoration, and a test that runs `build` without a DOM must not crash on
 * `querySelector` returning `null`.
 */
export function setHudText(text: string): void {
  if (typeof document === 'undefined') {
    return;
  }
  const element = document.getElementById(HUD_IDS.state);
  if (element === null) {
    return;
  }
  element.textContent = text;
}

/** Shows or hides the title block, which is the title screen's whole content. */
export function setTitleVisible(visible: boolean): void {
  if (typeof document === 'undefined') {
    return;
  }
  for (const id of [HUD_IDS.title, HUD_IDS.prompt]) {
    const element = document.getElementById(id);
    if (element !== null) {
      element.style.display = visible ? '' : 'none';
    }
  }
}

/** The title the HUD shows. */
export const PROJECT_TITLE = 'CRYO';

/** The line under the title. */
export const PROJECT_SUBTITLE = 'A working vertical slice, ported from Rust';

/** What the title screen says to press. */
export const START_PROMPT = 'Press any key to begin the survey';

/** The game states the HUD distinguishes. */
export function hudStateLabel(state: GameState): string {
  switch (state) {
    case 'title':
      return 'title';
    case 'exterior':
      return 'exterior';
    case 'interior':
      return 'interior';
  }
}
