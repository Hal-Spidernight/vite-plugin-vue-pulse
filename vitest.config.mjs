import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests import the built ESM in `dist/` (the published artifact); `pretest`
    // builds first. DOM-dependent suites set up happy-dom themselves, so the default
    // `node` environment is used.
    include: ['test/**/*.test.mjs'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Each test file runs in its OWN isolated worker (vitest default) — critical
    // here because suites share the singleton `graph` store and install global DOM
    // stubs (window/canvas/rAF); a shared process would let files clobber each other.
    // Just run files sequentially (no parallel resource contention). Do NOT set
    // singleFork — that collapses everything into one process and reintroduces the
    // cross-file interference.
    fileParallelism: false,
    // `dist/` is prebuilt ESM — don't let Vite re-transform it; Node imports it natively.
    server: { deps: { external: [/[\\/]dist[\\/]/] } },
  },
});
