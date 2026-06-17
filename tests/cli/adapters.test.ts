/**
 * Unit tests for the CLI platform adapters.
 *
 * Adapters are pure transformations of untrusted stdin (from Claude Code,
 * Cursor, Gemini CLI, Codex, ...) into the internal NormalizedHookInput, and
 * back into each platform's expected output shape. They have no side effects,
 * so these tests need no mocks.
 */
import { describe, it, expect } from 'bun:test';
import {
  getPlatformAdapter,
  claudeCodeAdapter,
  cursorAdapter,
  geminiCliAdapter,
  rawAdapter,
} from '../../src/cli/adapters/index.js';

describe('getPlatformAdapter', () => {
  it('routes known platforms to their adapters', () => {
    expect(getPlatformAdapter('claude-code')).toBe(claudeCodeAdapter);
    expect(getPlatformAdapter('cursor')).toBe(cursorAdapter);
    expect(getPlatformAdapter('gemini')).toBe(geminiCliAdapter);
    expect(getPlatformAdapter('gemini-cli')).toBe(geminiCliAdapter);
    expect(getPlatformAdapter('raw')).toBe(rawAdapter);
  });

  it('falls back to the raw adapter for unknown platforms (e.g. Codex)', () => {
    expect(getPlatformAdapter('codex')).toBe(rawAdapter);
    expect(getPlatformAdapter('')).toBe(rawAdapter);
    expect(getPlatformAdapter('something-new')).toBe(rawAdapter);
  });
});

describe('claudeCodeAdapter.normalizeInput', () => {
  it('maps snake_case fields to the normalized shape', () => {
    const result = claudeCodeAdapter.normalizeInput({
      session_id: 'sess-1',
      cwd: '/work/proj',
      prompt: 'hi',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { output: 'a' },
      transcript_path: '/t.jsonl',
    });

    expect(result).toEqual({
      sessionId: 'sess-1',
      cwd: '/work/proj',
      prompt: 'hi',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResponse: { output: 'a' },
      transcriptPath: '/t.jsonl',
    });
  });

  it('prefers session_id, then id, then sessionId for the session id', () => {
    expect(claudeCodeAdapter.normalizeInput({ session_id: 'a', id: 'b', sessionId: 'c' }).sessionId).toBe('a');
    expect(claudeCodeAdapter.normalizeInput({ id: 'b', sessionId: 'c' }).sessionId).toBe('b');
    expect(claudeCodeAdapter.normalizeInput({ sessionId: 'c' }).sessionId).toBe('c');
  });

  it('defaults cwd to process.cwd() and tolerates missing/empty input (SessionStart)', () => {
    expect(claudeCodeAdapter.normalizeInput({}).cwd).toBe(process.cwd());
    expect(claudeCodeAdapter.normalizeInput(undefined).cwd).toBe(process.cwd());
    expect(claudeCodeAdapter.normalizeInput(null).sessionId).toBeUndefined();
  });
});

describe('claudeCodeAdapter.formatOutput', () => {
  it('emits hookSpecificOutput and systemMessage when both present', () => {
    const out = claudeCodeAdapter.formatOutput({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' },
      systemMessage: 'msg',
    });
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' },
      systemMessage: 'msg',
    });
  });

  it('omits systemMessage when empty alongside hookSpecificOutput', () => {
    const out = claudeCodeAdapter.formatOutput({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' },
      systemMessage: '',
    }) as Record<string, unknown>;
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' } });
    expect('systemMessage' in out).toBe(false);
  });

  it('emits only systemMessage when there is no hookSpecificOutput', () => {
    expect(claudeCodeAdapter.formatOutput({ systemMessage: 'msg' })).toEqual({ systemMessage: 'msg' });
  });

  it('drops fields outside the Claude Code hook contract (continue/suppressOutput/exitCode)', () => {
    const out = claudeCodeAdapter.formatOutput({
      continue: true,
      suppressOutput: true,
      exitCode: 0,
    }) as Record<string, unknown>;
    expect(out).toEqual({});
  });

  it('returns an empty object for a null result', () => {
    expect(claudeCodeAdapter.formatOutput(null as any)).toEqual({});
  });
});

describe('cursorAdapter.normalizeInput', () => {
  it('derives session id from conversation_id, then generation_id, then id', () => {
    expect(cursorAdapter.normalizeInput({ conversation_id: 'c', generation_id: 'g', id: 'i' }).sessionId).toBe('c');
    expect(cursorAdapter.normalizeInput({ generation_id: 'g', id: 'i' }).sessionId).toBe('g');
    expect(cursorAdapter.normalizeInput({ id: 'i' }).sessionId).toBe('i');
  });

  it('resolves cwd from workspace_roots[0], then cwd, then process.cwd()', () => {
    expect(cursorAdapter.normalizeInput({ workspace_roots: ['/a', '/b'] }).cwd).toBe('/a');
    expect(cursorAdapter.normalizeInput({ cwd: '/c' }).cwd).toBe('/c');
    expect(cursorAdapter.normalizeInput({}).cwd).toBe(process.cwd());
  });

  it('does not crash on empty or null workspace_roots (optional chaining)', () => {
    expect(cursorAdapter.normalizeInput({ workspace_roots: [], cwd: '/c' }).cwd).toBe('/c');
    expect(cursorAdapter.normalizeInput({ workspace_roots: null, cwd: '/c' }).cwd).toBe('/c');
    expect(cursorAdapter.normalizeInput({ workspace_roots: null }).cwd).toBe(process.cwd());
  });

  it('resolves prompt from prompt, then query, then input, then message', () => {
    expect(cursorAdapter.normalizeInput({ prompt: 'p', query: 'q', input: 'i', message: 'm' }).prompt).toBe('p');
    expect(cursorAdapter.normalizeInput({ query: 'q', input: 'i', message: 'm' }).prompt).toBe('q');
    expect(cursorAdapter.normalizeInput({ input: 'i', message: 'm' }).prompt).toBe('i');
    expect(cursorAdapter.normalizeInput({ message: 'm' }).prompt).toBe('m');
  });

  it('maps shell command/output into a Bash tool observation', () => {
    const result = cursorAdapter.normalizeInput({ command: 'ls -la', output: 'file1\nfile2' });
    expect(result.toolName).toBe('Bash');
    expect(result.toolInput).toEqual({ command: 'ls -la' });
    expect(result.toolResponse).toEqual({ output: 'file1\nfile2' });
  });

  it('treats it as a normal tool (not shell) when tool_name is present, reading result_json', () => {
    const result = cursorAdapter.normalizeInput({
      command: 'ls',
      tool_name: 'Read',
      tool_input: { path: '/x' },
      result_json: { ok: true },
    });
    expect(result.toolName).toBe('Read');
    expect(result.toolInput).toEqual({ path: '/x' });
    expect(result.toolResponse).toEqual({ ok: true });
  });

  it('passes through file edit fields and never sets a transcript path', () => {
    const result = cursorAdapter.normalizeInput({
      file_path: '/src/a.ts',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
    expect(result.filePath).toBe('/src/a.ts');
    expect(result.edits).toEqual([{ oldText: 'a', newText: 'b' }]);
    expect(result.transcriptPath).toBeUndefined();
  });
});

describe('cursorAdapter.formatOutput', () => {
  it('defaults continue to true and respects an explicit false', () => {
    expect(cursorAdapter.formatOutput({})).toEqual({ continue: true });
    expect(cursorAdapter.formatOutput({ continue: false })).toEqual({ continue: false });
    expect(cursorAdapter.formatOutput({ continue: true })).toEqual({ continue: true });
  });
});

describe('geminiCliAdapter.normalizeInput', () => {
  it('resolves cwd from the JSON field, then GEMINI/CLAUDE env vars, then process.cwd()', () => {
    expect(geminiCliAdapter.normalizeInput({ cwd: '/json' }).cwd).toBe('/json');

    process.env.GEMINI_CWD = '/gemini-cwd';
    expect(geminiCliAdapter.normalizeInput({}).cwd).toBe('/gemini-cwd');
    delete process.env.GEMINI_CWD;

    process.env.GEMINI_PROJECT_DIR = '/gemini-proj';
    expect(geminiCliAdapter.normalizeInput({}).cwd).toBe('/gemini-proj');
    delete process.env.GEMINI_PROJECT_DIR;

    process.env.CLAUDE_PROJECT_DIR = '/claude-proj';
    expect(geminiCliAdapter.normalizeInput({}).cwd).toBe('/claude-proj');
    delete process.env.CLAUDE_PROJECT_DIR;

    expect(geminiCliAdapter.normalizeInput({}).cwd).toBe(process.cwd());
  });

  it('resolves session id from session_id, then GEMINI_SESSION_ID, else undefined', () => {
    expect(geminiCliAdapter.normalizeInput({ session_id: 's' }).sessionId).toBe('s');

    process.env.GEMINI_SESSION_ID = 'env-s';
    expect(geminiCliAdapter.normalizeInput({}).sessionId).toBe('env-s');
    delete process.env.GEMINI_SESSION_ID;

    expect(geminiCliAdapter.normalizeInput({}).sessionId).toBeUndefined();
  });

  it('synthesizes an observation from AfterAgent prompt_response', () => {
    const result = geminiCliAdapter.normalizeInput({
      hook_event_name: 'AfterAgent',
      prompt: 'do x',
      prompt_response: 'did x',
    });
    expect(result.toolName).toBe('GeminiAgent');
    expect(result.toolInput).toEqual({ prompt: 'do x' });
    expect(result.toolResponse).toEqual({ response: 'did x' });
  });

  it('marks BeforeTool as pre-execution when no tool_response is present', () => {
    const result = geminiCliAdapter.normalizeInput({
      hook_event_name: 'BeforeTool',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(result.toolResponse).toEqual({ _preExecution: true });
  });

  it('captures a Notification as an observation', () => {
    const result = geminiCliAdapter.normalizeInput({
      hook_event_name: 'Notification',
      notification_type: 'ToolPermission',
      message: 'allow?',
      details: { tool: 'Bash' },
    });
    expect(result.toolName).toBe('GeminiNotification');
    expect(result.toolInput).toEqual({ notification_type: 'ToolPermission', message: 'allow?' });
    expect(result.toolResponse).toEqual({ details: { tool: 'Bash' } });
  });

  it('collects platform metadata and omits it entirely when empty', () => {
    const withMeta = geminiCliAdapter.normalizeInput({
      hook_event_name: 'SessionStart',
      source: 'startup',
      stop_hook_active: false,
    }) as any;
    expect(withMeta.metadata).toEqual({
      source: 'startup',
      stop_hook_active: false,
      hook_event_name: 'SessionStart',
    });

    const noMeta = geminiCliAdapter.normalizeInput({ prompt: 'hi' }) as any;
    expect(noMeta.metadata).toBeUndefined();
  });
});

describe('geminiCliAdapter.formatOutput', () => {
  it('always includes continue (default true) and only includes suppressOutput when set', () => {
    expect(geminiCliAdapter.formatOutput({})).toEqual({ continue: true });
    expect(geminiCliAdapter.formatOutput({ continue: false })).toEqual({ continue: false });

    const out = geminiCliAdapter.formatOutput({ suppressOutput: true }) as Record<string, unknown>;
    expect(out).toEqual({ continue: true, suppressOutput: true });
  });

  it('strips ANSI escape codes from systemMessage', () => {
    const out = geminiCliAdapter.formatOutput({
      systemMessage: '[31mred[0m text',
    }) as Record<string, unknown>;
    expect(out.systemMessage).toBe('red text');
  });

  it('passes hookSpecificOutput through as additionalContext only', () => {
    const out = geminiCliAdapter.formatOutput({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' },
    }) as any;
    expect(out.hookSpecificOutput).toEqual({ additionalContext: 'ctx' });
  });
});

describe('rawAdapter', () => {
  it('accepts both camelCase and snake_case, preferring camelCase', () => {
    const result = rawAdapter.normalizeInput({
      sessionId: 'camel',
      session_id: 'snake',
      toolName: 'A',
      tool_name: 'B',
      transcriptPath: '/c',
      transcript_path: '/s',
      filePath: '/f',
    });
    expect(result.sessionId).toBe('camel');
    expect(result.toolName).toBe('A');
    expect(result.transcriptPath).toBe('/c');
    expect(result.filePath).toBe('/f');
  });

  it('falls back to snake_case and defaults sessionId to "unknown"', () => {
    expect(rawAdapter.normalizeInput({ session_id: 'snake' }).sessionId).toBe('snake');
    expect(rawAdapter.normalizeInput({ cwd: '/x' }).sessionId).toBe('unknown');
  });

  it('returns the HookResult unchanged from formatOutput', () => {
    const result = { continue: true, suppressOutput: false, systemMessage: 'm', exitCode: 2 };
    expect(rawAdapter.formatOutput(result)).toBe(result);
  });

  // CHARACTERIZATION TEST (documents a known gap, not desired behavior):
  // Unlike the other adapters, rawAdapter does not guard against null/undefined
  // input (`const r = raw as any`). Since unknown platforms (e.g. Codex) route
  // to rawAdapter and SessionStart hooks receive no stdin, this can throw.
  // Flagged for a one-line hardening fix (`raw ?? {}`) pending approval.
  it('currently throws on null/undefined input (KNOWN GAP — see comment)', () => {
    expect(() => rawAdapter.normalizeInput(undefined)).toThrow();
    expect(() => rawAdapter.normalizeInput(null)).toThrow();
  });
});
