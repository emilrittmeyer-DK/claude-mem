/**
 * Unit tests for OpenRouterAgent.
 *
 * Mirrors tests/gemini_agent.test.ts: dependencies are stubbed with spyOn
 * (which auto-restores, unlike mock.module) and the OpenRouter REST API is
 * driven through a mocked global.fetch. No mock.module is used, so this suite
 * cannot leak into others.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import {
  OpenRouterAgent,
  isOpenRouterAvailable,
  isOpenRouterSelected,
} from '../../src/services/worker/OpenRouterAgent.js';
import { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

const mockMode = {
  name: 'code',
  prompts: { init: 'init prompt', observation: 'obs prompt', summary: 'summary prompt' },
  observation_types: [{ id: 'discovery' }, { id: 'bugfix' }],
  observation_concepts: [],
};

function makeSession(overrides: Record<string, any> = {}) {
  return {
    sessionDbId: 1,
    contentSessionId: 'content-1',
    memorySessionId: 'mem-1',
    project: 'test-project',
    userPrompt: 'do the thing',
    conversationHistory: [],
    lastPromptNumber: 1,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    pendingMessages: [],
    abortController: new AbortController(),
    generatorPromise: null,
    earliestPendingTimestamp: null,
    currentProvider: null,
    startTime: Date.now(),
    processingMessageIds: [],
    ...overrides,
  } as any;
}

function openRouterResponse(content: string, totalTokens = 100) {
  return Promise.resolve(
    new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content } }],
        usage: { total_tokens: totalTokens, prompt_tokens: 70, completion_tokens: 30 },
      }),
    ),
  );
}

let settingsSpy: ReturnType<typeof spyOn>;
let modeSpy: ReturnType<typeof spyOn>;
let originalFetch: typeof global.fetch;
let settings: Record<string, any>;

let mockStoreObservations: any;
let mockSyncObservation: any;
let mockUpdateMemorySessionId: any;
let dbManager: DatabaseManager;
let sessionManager: SessionManager;
let agent: OpenRouterAgent;

beforeEach(() => {
  settings = {
    ...SettingsDefaultsManager.getAllDefaults(),
    CLAUDE_MEM_OPENROUTER_API_KEY: 'test-key',
    CLAUDE_MEM_OPENROUTER_MODEL: 'vendor/model:free',
    CLAUDE_MEM_PROVIDER: 'openrouter',
  };
  settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => settings as any);
  modeSpy = spyOn(ModeManager, 'getInstance').mockImplementation(
    () => ({ getActiveMode: () => mockMode, loadMode: () => {} } as any),
  );

  mockStoreObservations = mock(() => ({ observationIds: [1], summaryId: null, createdAtEpoch: Date.now() }));
  mockSyncObservation = mock(() => Promise.resolve());
  mockUpdateMemorySessionId = mock(() => {});

  const mockSessionStore = {
    storeObservation: mock(() => ({ id: 1, createdAtEpoch: Date.now() })),
    storeObservations: mockStoreObservations,
    storeSummary: mock(() => ({ id: 1, createdAtEpoch: Date.now() })),
    markSessionCompleted: mock(() => {}),
    updateMemorySessionId: mockUpdateMemorySessionId,
    getSessionById: mock(() => ({ memory_session_id: 'mem-1' })),
    ensureMemorySessionIdRegistered: mock(() => {}),
  };

  dbManager = {
    getSessionStore: () => mockSessionStore,
    getChromaSync: () => ({ syncObservation: mockSyncObservation, syncSummary: mock(() => Promise.resolve()) }),
  } as unknown as DatabaseManager;

  sessionManager = {
    getMessageIterator: async function* () { yield* []; },
    getPendingMessageStore: () => ({
      markProcessed: mock(() => {}),
      confirmProcessed: mock(() => {}),
      cleanupProcessed: mock(() => 0),
      resetStuckMessages: mock(() => 0),
    }),
  } as unknown as SessionManager;

  agent = new OpenRouterAgent(dbManager, sessionManager);
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  settingsSpy.mockRestore();
  modeSpy.mockRestore();
  mock.restore();
});

describe('OpenRouterAgent.startSession', () => {
  it('builds a correct OpenAI-compatible request to the OpenRouter API', async () => {
    global.fetch = mock(() => openRouterResponse('no observations here')) as any;

    await agent.startSession(makeSession());

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-key');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('vendor/model:free');
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(4096);
    expect(body.messages[body.messages.length - 1].role).toBe('user');
    expect(typeof body.messages[0].content).toBe('string');
  });

  it('throws when no API key is configured', async () => {
    settings.CLAUDE_MEM_OPENROUTER_API_KEY = '';
    global.fetch = mock(() => openRouterResponse('x')) as any;

    await expect(agent.startSession(makeSession())).rejects.toThrow('OpenRouter API key not configured');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('generates a synthetic memorySessionId when the session lacks one', async () => {
    global.fetch = mock(() => openRouterResponse('ok')) as any;

    const session = makeSession({ memorySessionId: '' });
    await agent.startSession(session);

    expect(mockUpdateMemorySessionId).toHaveBeenCalledTimes(1);
    const [dbId, synthetic] = mockUpdateMemorySessionId.mock.calls[0];
    expect(dbId).toBe(1);
    expect(String(synthetic)).toMatch(/^openrouter-content-1-\d+$/);
    expect(session.memorySessionId).toBe(synthetic);
  });

  it('maps prior conversation history into OpenAI roles (multi-turn)', async () => {
    global.fetch = mock(() => openRouterResponse('ok')) as any;

    const session = makeSession({
      conversationHistory: [
        { role: 'user', content: 'earlier user' },
        { role: 'assistant', content: 'earlier assistant' },
      ],
      lastPromptNumber: 2,
    });
    await agent.startSession(session);

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    // 2 prior turns + the freshly pushed continuation prompt
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]).toEqual({ role: 'user', content: 'earlier user' });
    expect(body.messages[1]).toEqual({ role: 'assistant', content: 'earlier assistant' });
    expect(body.messages[2].role).toBe('user');
  });

  it('processes an observation in the response and stores it', async () => {
    const observationXml = `
      <observation>
        <type>discovery</type>
        <title>Found something</title>
        <subtitle>detail</subtitle>
        <narrative>narrative text</narrative>
        <facts><fact>a fact</fact></facts>
        <concepts><concept>idea</concept></concepts>
        <files_read><file>src/x.ts</file></files_read>
        <files_modified></files_modified>
      </observation>`;
    global.fetch = mock(() => openRouterResponse(observationXml, 200)) as any;

    const session = makeSession();
    await agent.startSession(session);

    expect(mockStoreObservations).toHaveBeenCalled();
    expect(mockSyncObservation).toHaveBeenCalled();
    expect(session.cumulativeInputTokens).toBeGreaterThan(0);
  });

  it('throws on a non-ok API response when no fallback is configured', async () => {
    global.fetch = mock(() => Promise.resolve(new Response('upstream boom', { status: 500 }))) as any;

    await expect(agent.startSession(makeSession())).rejects.toThrow('OpenRouter API error: 500');
  });
});

describe('OpenRouter availability helpers', () => {
  it('isOpenRouterAvailable reflects whether an API key is set', () => {
    settings.CLAUDE_MEM_OPENROUTER_API_KEY = 'k';
    expect(isOpenRouterAvailable()).toBe(true);

    settings.CLAUDE_MEM_OPENROUTER_API_KEY = '';
    // No credential file in the test env, so this should be false.
    expect(isOpenRouterAvailable()).toBe(false);
  });

  it('isOpenRouterSelected reflects the configured provider', () => {
    settings.CLAUDE_MEM_PROVIDER = 'openrouter';
    expect(isOpenRouterSelected()).toBe(true);

    settings.CLAUDE_MEM_PROVIDER = 'claude';
    expect(isOpenRouterSelected()).toBe(false);
  });
});
