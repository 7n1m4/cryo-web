import { defineConfig } from 'vitest/config';

/**
 * The vitest configuration.
 *
 * `*.harness.ts` is included alongside the `*.test.ts` files so the dev harness
 * runs through the same TypeScript pipeline the tests do — Node's
 * `--experimental-strip-types` cannot erase a TS `enum`, which the voxel palette
 * is full of, so a harness must be a test.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.{test,harness}.ts'],
    // The harness prints rather than asserts, so a stray console line is not a
    // failure the way it would be in a real test file.
    disableConsoleIntercept: true,
  },
});
