/**
 * Global test setup — loaded via bunfig.toml `preload`.
 *
 * Provides cross-test isolation for process-global state that several suites
 * mutate (environment variables and the working directory). Without this,
 * a test that sets e.g. CLAUDE_CONFIG_DIR / CLAUDE_MEM_* / HOME or chdir's
 * can leak into unrelated suites because Bun runs the whole suite in one
 * process.
 *
 * Note: this does NOT undo `mock.module(...)` registrations — Bun has no
 * built-in unmock and `mock.restore()` does not cover module mocks. Suites
 * that call `mock.module` must restore the real module themselves in
 * `afterAll` (see tests/hooks/context-reinjection-guard.test.ts).
 */
import { beforeEach, afterEach } from 'bun:test';
import * as realLoggerModule from '../src/utils/logger.js';

// Capture the REAL logger module once, at preload time — before any test file
// has a chance to mock.module(...) it. Test files that mock the logger (and
// would otherwise leak an incomplete stub across the shared module registry)
// can restore from this snapshot in their own afterAll.
(globalThis as any).__CMEM_REAL_LOGGER__ = { ...realLoggerModule };

let envSnapshot: Record<string, string | undefined> = {};
let cwdSnapshot = '';

beforeEach(() => {
  envSnapshot = { ...process.env };
  try {
    cwdSnapshot = process.cwd();
  } catch {
    cwdSnapshot = '';
  }
});

afterEach(() => {
  // Remove any keys the test added.
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) {
      delete process.env[key];
    }
  }
  // Restore any keys the test changed or deleted.
  for (const key of Object.keys(envSnapshot)) {
    const original = envSnapshot[key];
    if (original === undefined) {
      delete process.env[key];
    } else if (process.env[key] !== original) {
      process.env[key] = original;
    }
  }
  // Restore the working directory if a test changed it.
  if (cwdSnapshot) {
    try {
      if (process.cwd() !== cwdSnapshot) {
        process.chdir(cwdSnapshot);
      }
    } catch {
      // Best effort — ignore if the snapshot dir no longer exists.
    }
  }
});
