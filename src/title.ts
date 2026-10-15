/**
 * The title screen: a DOM block, owned here.
 *
 * The Rust's title screen is `Camera2d`, `TitleText`, `StatusText`, `StartPrompt`
 * and a real Bevy `Button`, and `start_game_system` reads both the keyboard and
 * the button in one system so "was a start requested?" never depends on system
 * ordering. The keyboard half arrives as a key edge; the button half arrives as
 * this module's own edge, recorded by the click listener and consumed by
 * `app.ts` exactly once per press.
 *
 * Every function here is a no-op when there is no `document`, which is what
 * makes the module importable under vitest: the tests run with no DOM, and a
 * title screen that touched the DOM at import time would make every game-layer
 * test a browser test.
 */

/** The DOM ids the title screen owns. */
export const TITLE_IDS = {
 title: 'cryo-title',
 prompt: 'cryo-prompt',
 button: 'cryo-start',
} as const;

/** What the start button says. */
export const START_BUTTON_LABEL = 'Begin the survey';

/**
 * Whether a click has been recorded and not yet consumed.
 *
 * A single flag rather than a queue: two clicks between two frames are one start
 * request either way, and `consumeStartClick` clears it, which is the one-shot
 * behaviour the Rust gets from `bevy_ui`'s `Pressed` marker being removed by the
 * engine's button system once per frame.
 */
let startClicked = false;

/**
 * Records a start click.
 *
 * Both the DOM listener and a test call this: it is the button's whole effect,
 * so the seam is honest — a test asserting `the_button_click_also_takes_the_`
 * `player_into_the_game` drives the same function the browser does.
 */
export function pressStartButton(): void {
 startClicked = true;
}

/** Reads and clears the recorded start click. */
export function consumeStartClick(): boolean {
 const clicked = startClicked;
 startClicked = false;
 return clicked;
}

/** The elements of the title screen, or `null` before it is mounted. */
let blocks: readonly HTMLElement[] | null = null;

/** Creates the start button, wired to `pressStartButton`, beside the prompt. */
function createButton(): HTMLButtonElement | null {
 const prompt = document.getElementById(TITLE_IDS.prompt);
 if (prompt === null || prompt.parentElement === null) {
  return null;
 }
 const existing = document.getElementById(TITLE_IDS.button);
 if (existing instanceof HTMLButtonElement) {
  return existing;
 }
 const button = document.createElement('button');
 button.id = TITLE_IDS.button;
 button.type = 'button';
 button.textContent = START_BUTTON_LABEL;
 // The HUD root is `pointer-events: none`, so a button inside it would never
 // receive a pointer event at all. The button is the one thing in the overlay
 // the player is meant to click, so it opts back in.
 button.style.pointerEvents = 'auto';
 button.addEventListener('click', () => {
  pressStartButton();
 });
 prompt.parentElement.appendChild(button);
 return button;
}

/**
 * Mounts the title screen's DOM, wiring the start button.
 *
 * Idempotent: the blocks are adopted once and reused, so a second call is a
 * no-op rather than a second button. Called from `app.ts` when a renderer is
 * present, because that is the only place a DOM is guaranteed.
 */
export function mountTitle(): void {
 if (typeof document === 'undefined' || blocks !== null) {
  return;
 }
 const button = createButton();
 blocks = [TITLE_IDS.title, TITLE_IDS.prompt, TITLE_IDS.button]
  .map((id) => document.getElementById(id) ?? (button !== null && id === TITLE_IDS.button ? button : null))
  .filter((element): element is HTMLElement => element !== null);
}

/** Shows or hides every block of the title screen. */
export function setTitleVisible(visible: boolean): void {
 if (typeof document === 'undefined') {
  return;
 }
 if (blocks === null) {
  mountTitle();
 }
 if (blocks === null) {
  return;
 }
 for (const element of blocks) {
  element.style.display = visible ? '' : 'none';
 }
}
