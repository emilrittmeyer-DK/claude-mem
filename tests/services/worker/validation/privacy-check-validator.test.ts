/**
 * Unit tests for PrivacyCheckValidator.
 *
 * This validator is the safety gate that skips observation/summarize work when
 * the originating user prompt was entirely private (stripped to empty). It is
 * pure aside from a SessionStore lookup, so a tiny fake store suffices.
 *
 * NOTE: this file also documents (via a skipped spec) a CONFIRMED privacy gap:
 * the summarize path does NOT strip privacy tags from `last_assistant_message`.
 * The source is intentionally left unchanged pending a decision.
 */
import { describe, it, expect } from 'bun:test';
import { PrivacyCheckValidator } from '../../../../src/services/worker/validation/PrivacyCheckValidator.js';

function fakeStore(prompt: string | null | undefined) {
  return { getUserPrompt: () => prompt } as any;
}

describe('PrivacyCheckValidator.checkUserPromptPrivacy', () => {
  it('returns the prompt text when it is public', () => {
    const result = PrivacyCheckValidator.checkUserPromptPrivacy(
      fakeStore('do the thing'),
      'content-1',
      1,
      'observation',
      42,
    );
    expect(result).toBe('do the thing');
  });

  it('returns null when the prompt is missing', () => {
    expect(
      PrivacyCheckValidator.checkUserPromptPrivacy(fakeStore(null), 'c', 1, 'observation', 1),
    ).toBeNull();
    expect(
      PrivacyCheckValidator.checkUserPromptPrivacy(fakeStore(undefined), 'c', 1, 'summarize', 1),
    ).toBeNull();
  });

  it('returns null when the prompt is empty or whitespace (entirely private)', () => {
    expect(
      PrivacyCheckValidator.checkUserPromptPrivacy(fakeStore(''), 'c', 1, 'observation', 1),
    ).toBeNull();
    expect(
      PrivacyCheckValidator.checkUserPromptPrivacy(fakeStore('   \n\t '), 'c', 1, 'summarize', 1),
    ).toBeNull();
  });

  it('preserves a prompt that merely has surrounding whitespace but real content', () => {
    const result = PrivacyCheckValidator.checkUserPromptPrivacy(
      fakeStore('  real content  '),
      'c',
      2,
      'observation',
      7,
    );
    // Returned verbatim (not trimmed) when non-empty.
    expect(result).toBe('  real content  ');
  });
});

describe('privacy gap: summarize last_assistant_message is not stripped (CONFIRMED)', () => {
  // SessionRoutes.handleSummarize / handleSummarizeByClaudeId pass
  // `last_assistant_message` straight into queueSummarize without calling
  // stripMemoryTagsFromPrompt/Json, and the hook-layer summarize handler does
  // not strip it either. So <private>...</private> content inside an assistant
  // message can reach the summarizer LLM and stored summaries.
  //
  // This spec encodes the DESIRED behavior; it is skipped until the source is
  // hardened (decision pending). It is not asserting current (buggy) behavior.
  it.skip('SHOULD strip <private> content from last_assistant_message before summarizing', () => {
    // Intentionally empty — see comment. Flip to active once stripping is added
    // at the summarize seam (hook handler and/or SessionRoutes summarize handler).
    expect(true).toBe(true);
  });
});
