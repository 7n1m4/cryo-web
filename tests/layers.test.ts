/**
 * The layer boundary: sim/ and ship/ are pure, presentation/ is the only
 * engine-dependent layer.
 *
 * This is the guard that makes the architecture real rather than aspirational.
 * It reads every `.ts` file under `src/sim/` and `src/ship/` and fails the build
 * if any of them imports a rendering engine or reaches across into the
 * presentation layer. A dependency-free test rather than a lint rule, so it
 * runs in CI with nothing installed beyond vitest.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = resolve(__dirname, '..', 'src');

/** The import specifiers the pure layers must never name. */
const FORBIDDEN_IMPORTS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
 { pattern: /from\s+['"]babylonjs['"]/, why: 'the Babylon.js engine' },
 { pattern: /from\s+['"]babylonjs-gui['"]/, why: 'the Babylon.js GUI kit' },
 { pattern: /from\s+['"]babylonjs-loaders['"]/, why: 'a Babylon.js loaders package' },
 { pattern: /from\s+['"]three['"]/, why: 'any rendering engine other than Babylon.js' },
 { pattern: /from\s+['"][^'"]*presentation[^'"]*['"]/, why: 'the presentation layer' },
 { pattern: /import\s*\(\s*['"](babylonjs|three)/, why: 'a dynamic engine import' },
 { pattern: /require\s*\(\s*['"](babylonjs|three)/, why: 'a CommonJS engine import' },
];

/** Every `.ts` file under `directory`, recursively. */
function typeScriptFiles(directory: string): string[] {
 const found: string[] = [];
 for (const entry of readdirSync(directory)) {
  const full = join(directory, entry);
  if (statSync(full).isDirectory()) {
   found.push(...typeScriptFiles(full));
  } else if (entry.endsWith('.ts')) {
   found.push(full);
  }
 }
 return found;
}

/** The lines of `file` that carry a forbidden import. */
function forbiddenImports(file: string): { readonly line: number; readonly why: string }[] {
 const source = readFileSync(file, 'utf8');
 const hits: { line: number; why: string }[] = [];
 const lines = source.split('\n');
 for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  if (line === undefined) {
   continue;
  }
  for (const { pattern, why } of FORBIDDEN_IMPORTS) {
   if (pattern.test(line)) {
    hits.push({ line: index + 1, why });
   }
  }
 }
 return hits;
}

describe('the layer boundary', () => {
 const simFiles = typeScriptFiles(join(SRC_ROOT, 'sim'));
 const shipFiles = typeScriptFiles(join(SRC_ROOT, 'ship'));
 const gameFiles = typeScriptFiles(join(SRC_ROOT, 'game'));

 it('finds the pure layers to check', () => {
  // If this ever fails, the test above has gone quiet and the boundary is no
  // longer being enforced at all.
  expect(simFiles.length).toBeGreaterThan(0);
  expect(shipFiles.length).toBeGreaterThan(0);
  expect(gameFiles.length).toBeGreaterThan(0);
 });

 for (const file of [...simFiles, ...shipFiles, ...gameFiles]) {
  const relative = file.slice(SRC_ROOT.length + 1);
  it(`${relative} imports no rendering engine and no presentation layer`, () => {
   expect(forbiddenImports(file)).toEqual([]);
  });
 }

 it('allows the presentation layer to import the engine', () => {
  // The rule is one-directional: the boundary is only worth having if the
  // presentation layer is actually allowed to break it in the other
  // direction. This test documents that asymmetry so a future tightening
  // has to be deliberate.
  const presentationFiles = typeScriptFiles(join(SRC_ROOT, 'presentation'));
  expect(presentationFiles.length).toBeGreaterThan(0);
 });
});
