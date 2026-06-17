/**
 * Unit tests for the CLI event handlers (the lifecycle hook bodies).
 *
 * These handlers talk to the worker over HTTP. We mock worker-utils so
 * `workerHttpRequest` delegates to a controllable global fetch, and toggle
 * worker availability via `ensureWorkerRunning`. transcript-parser is mocked
 * for the summarize handler. project-filter is kept REAL so the exclusion
 * branch is exercised end-to-end (driven by mocked settings).
 *
 * IMPORTANT: Bun's mock.module is global and persists across files, and
 * mock.restore() does not undo it — so the real modules are snapshotted before
 * mocking and re-registered in afterAll to avoid poisoning other suites.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';

// Snapshot real exports before mocking (see header note).
import * as realWorkerUtils from '../../src/shared/worker-utils.js';
import * as realTranscriptParser from '../../src/shared/transcript-parser.js';
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realTranscriptParserSnapshot = { ...realTranscriptParser };

// Mutable test state consumed by the mocks.
let workerAvailable = true;
let extractBehavior: { value?: string; error?: Error } = {};

// Raw worker-utils call options (incl. timeoutMs) recorded for assertions.
let workerCalls: Array<{ apiPath: string; options?: any }> = [];

mock.module('../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(workerAvailable),
  getWorkerPort: () => 37777,
  workerHttpRequest: (apiPath: string, options?: any) => {
    workerCalls.push({ apiPath, options });
    return globalThis.fetch(`http://127.0.0.1:37777${apiPath}`, {
      method: options?.method ?? 'GET',
      headers: options?.headers,
      body: options?.body,
    });
  },
}));

mock.module('../../src/shared/transcript-parser.js', () => ({
  extractLastMessage: () => {
    if (extractBehavior.error) throw extractBehavior.error;
    return extractBehavior.value ?? '';
  },
}));

// Install a COMPLETE no-op logger stub. Several other suites mock the logger
// with incomplete stubs (missing e.g. dataIn) and never restore it; mocking it
// fully here makes this suite independent of cross-file leak ordering. The real
// logger (captured in tests/setup.ts before any mock) is restored in afterAll.
const noopLogger = new Proxy(
  {},
  { get: (_t, prop) => (prop === 'formatTool' ? (name: string) => String(name) : () => {}) },
);
mock.module('../../src/utils/logger.js', () => ({ logger: noopLogger }));

import { fileEditHandler } from '../../src/cli/handlers/file-edit.js';
import { sessionCompleteHandler } from '../../src/cli/handlers/session-complete.js';
import { observationHandler } from '../../src/cli/handlers/observation.js';
import { summarizeHandler } from '../../src/cli/handlers/summarize.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

// Captured outgoing HTTP requests.
interface CapturedRequest { url: string; method?: string; body?: any }
let fetchCalls: CapturedRequest[] = [];
let originalFetch: typeof globalThis.fetch;

function installFetch(status: number) {
  globalThis.fetch = mock((url: any, opts: any) => {
    fetchCalls.push({
      url: String(url),
      method: opts?.method,
      body: opts?.body ? JSON.parse(opts.body) : undefined,
    });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({}),
    } as any);
  }) as any;
}

function installFetchThatThrows() {
  globalThis.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED'))) as any;
}

let settingsSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  workerAvailable = true;
  extractBehavior = {};
  fetchCalls = [];
  workerCalls = [];
  originalFetch = globalThis.fetch;
  installFetch(200);

  // Default: no excluded projects.
  settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
  } as any);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  settingsSpy.mockRestore();
});

afterAll(() => {
  mock.module('../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../src/shared/transcript-parser.js', () => realTranscriptParserSnapshot);
  // Restore the real logger captured before any mocking (tests/setup.ts).
  const realLogger = (globalThis as any).__CMEM_REAL_LOGGER__;
  if (realLogger) {
    mock.module('../../src/utils/logger.js', () => realLogger);
  }
});

describe('fileEditHandler', () => {
  it('skips gracefully when the worker is unavailable', async () => {
    workerAvailable = false;
    const result = await fileEditHandler.execute({ sessionId: 's', cwd: '/w', filePath: '/a.ts', edits: [] });
    expect(result.continue).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  it('throws when filePath is missing', async () => {
    await expect(
      fileEditHandler.execute({ sessionId: 's', cwd: '/w' } as any),
    ).rejects.toThrow('fileEditHandler requires filePath');
  });

  it('throws when cwd is missing', async () => {
    await expect(
      fileEditHandler.execute({ sessionId: 's', cwd: '', filePath: '/a.ts' } as any),
    ).rejects.toThrow('Missing cwd');
  });

  it('posts a write_file observation on the happy path', async () => {
    const result = await fileEditHandler.execute({
      sessionId: 'sess-1',
      cwd: '/w',
      filePath: '/src/a.ts',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
    expect(result).toEqual({ continue: true, suppressOutput: true });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/api/sessions/observations');
    expect(fetchCalls[0].body).toEqual({
      contentSessionId: 'sess-1',
      tool_name: 'write_file',
      tool_input: { filePath: '/src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] },
      tool_response: { success: true },
      cwd: '/w',
    });
  });

  it('does not throw when the worker responds non-ok', async () => {
    installFetch(500);
    const result = await fileEditHandler.execute({ sessionId: 's', cwd: '/w', filePath: '/a.ts', edits: [] });
    expect(result.continue).toBe(true);
  });

  it('does not throw when fetch rejects', async () => {
    installFetchThatThrows();
    const result = await fileEditHandler.execute({ sessionId: 's', cwd: '/w', filePath: '/a.ts', edits: [] });
    expect(result.continue).toBe(true);
  });
});

describe('sessionCompleteHandler', () => {
  it('skips when the worker is unavailable', async () => {
    workerAvailable = false;
    const result = await sessionCompleteHandler.execute({ sessionId: 's', cwd: '/w' });
    expect(result).toEqual({ continue: true, suppressOutput: true });
    expect(fetchCalls).toHaveLength(0);
  });

  it('skips (no fetch) when sessionId is missing', async () => {
    const result = await sessionCompleteHandler.execute({ sessionId: '', cwd: '/w' } as any);
    expect(result).toEqual({ continue: true, suppressOutput: true });
    expect(fetchCalls).toHaveLength(0);
  });

  it('posts to the complete endpoint with the content session id', async () => {
    const result = await sessionCompleteHandler.execute({ sessionId: 'sess-1', cwd: '/w' });
    expect(result).toEqual({ continue: true, suppressOutput: true });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/api/sessions/complete');
    expect(fetchCalls[0].body).toEqual({ contentSessionId: 'sess-1' });
  });

  it('still continues when the worker responds non-ok', async () => {
    installFetch(404);
    const result = await sessionCompleteHandler.execute({ sessionId: 'sess-1', cwd: '/w' });
    expect(result).toEqual({ continue: true, suppressOutput: true });
  });

  it('still continues when fetch rejects', async () => {
    installFetchThatThrows();
    const result = await sessionCompleteHandler.execute({ sessionId: 'sess-1', cwd: '/w' });
    expect(result).toEqual({ continue: true, suppressOutput: true });
  });
});

describe('observationHandler', () => {
  it('skips when the worker is unavailable', async () => {
    workerAvailable = false;
    const result = await observationHandler.execute({ sessionId: 's', cwd: '/w', toolName: 'Bash' });
    expect(result.continue).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  it('skips (no fetch) when toolName is missing', async () => {
    const result = await observationHandler.execute({ sessionId: 's', cwd: '/w' });
    expect(result.continue).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  it('throws when cwd is missing but a tool ran', async () => {
    await expect(
      observationHandler.execute({ sessionId: 's', cwd: '', toolName: 'Bash' } as any),
    ).rejects.toThrow('Missing cwd');
  });

  it('skips when the project is excluded (real project-filter + mocked settings)', async () => {
    settingsSpy.mockReturnValue({ CLAUDE_MEM_EXCLUDED_PROJECTS: '/tmp/*' } as any);
    const result = await observationHandler.execute({ sessionId: 's', cwd: '/tmp/secret', toolName: 'Bash' });
    expect(result).toEqual({ continue: true, suppressOutput: true });
    expect(fetchCalls).toHaveLength(0);
  });

  it('posts the observation on the happy path', async () => {
    const result = await observationHandler.execute({
      sessionId: 'sess-1',
      cwd: '/w',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResponse: { output: 'a' },
    });
    expect(result).toEqual({ continue: true, suppressOutput: true });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/api/sessions/observations');
    expect(fetchCalls[0].body).toEqual({
      contentSessionId: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { output: 'a' },
      cwd: '/w',
    });
  });

  it('does not throw on non-ok or fetch failure', async () => {
    installFetch(503);
    expect((await observationHandler.execute({ sessionId: 's', cwd: '/w', toolName: 'Bash' })).continue).toBe(true);

    installFetchThatThrows();
    expect((await observationHandler.execute({ sessionId: 's', cwd: '/w', toolName: 'Bash' })).continue).toBe(true);
  });
});

describe('summarizeHandler', () => {
  it('skips when the worker is unavailable', async () => {
    workerAvailable = false;
    const result = await summarizeHandler.execute({ sessionId: 's', cwd: '/w', transcriptPath: '/t.jsonl' });
    expect(result.continue).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  it('skips (no fetch) when there is no transcript path', async () => {
    const result = await summarizeHandler.execute({ sessionId: 's', cwd: '/w' });
    expect(result.continue).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  it('skips gracefully when transcript extraction throws', async () => {
    extractBehavior = { error: new Error('ENOENT') };
    const result = await summarizeHandler.execute({ sessionId: 's', cwd: '/w', transcriptPath: '/missing.jsonl' });
    expect(result.continue).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  it('posts the extracted assistant message on the happy path', async () => {
    extractBehavior = { value: 'I did the work.' };
    const result = await summarizeHandler.execute({ sessionId: 'sess-1', cwd: '/w', transcriptPath: '/t.jsonl' });
    expect(result).toEqual({ continue: true, suppressOutput: true });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/api/sessions/summarize');
    expect(fetchCalls[0].body).toEqual({
      contentSessionId: 'sess-1',
      last_assistant_message: 'I did the work.',
    });
    // The summarize request must carry an explicit timeout.
    expect(typeof workerCalls[0].options?.timeoutMs).toBe('number');
    expect(workerCalls[0].options.timeoutMs).toBeGreaterThan(0);
  });

  it('continues when the worker responds non-ok', async () => {
    installFetch(500);
    extractBehavior = { value: 'work' };
    const result = await summarizeHandler.execute({ sessionId: 'sess-1', cwd: '/w', transcriptPath: '/t.jsonl' });
    expect(result).toEqual({ continue: true, suppressOutput: true });
  });

  // summarize.ts now wraps the worker POST in try/catch, so a fetch rejection
  // is handled gracefully like the other handlers.
  it('handles a fetch rejection gracefully', async () => {
    installFetchThatThrows();
    extractBehavior = { value: 'work' };
    const result = await summarizeHandler.execute({ sessionId: 's', cwd: '/w', transcriptPath: '/t.jsonl' });
    expect(result.continue).toBe(true);
  });
});
