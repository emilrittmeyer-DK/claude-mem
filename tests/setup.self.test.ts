/**
 * Self-test for the global env/cwd isolation harness (tests/setup.ts).
 *
 * These two tests run in declaration order within the same file. The first
 * mutates process.env; the second proves the global afterEach restored it,
 * which exercises both the "delete keys added by a test" and "restore changed
 * keys" branches of the harness.
 */
import { describe, it, expect } from 'bun:test';

const ADDED_KEY = '__CMEM_SETUP_SELFTEST_ADDED__';
const EXISTING_KEY = '__CMEM_SETUP_SELFTEST_EXISTING__';

// Seed a baseline value that exists in every test's snapshot.
process.env[EXISTING_KEY] = 'baseline';

describe('test isolation harness (tests/setup.ts)', () => {
  it('mutates process.env within a test', () => {
    process.env[ADDED_KEY] = 'leaked';
    process.env[EXISTING_KEY] = 'changed';

    expect(process.env[ADDED_KEY]).toBe('leaked');
    expect(process.env[EXISTING_KEY]).toBe('changed');
  });

  it('sees a clean process.env in the next test', () => {
    // The added key was removed entirely...
    expect(process.env[ADDED_KEY]).toBeUndefined();
    // ...and the pre-existing key was restored to its snapshot value.
    expect(process.env[EXISTING_KEY]).toBe('baseline');
  });
});
