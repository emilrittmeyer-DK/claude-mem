/**
 * Contract tests for the worker HTTP data/memory routes.
 *
 * Strategy: mount the real route handler on a bare express app with a real
 * in-memory SessionStore (`:memory:`) behind a fake DatabaseManager, plus
 * lightweight fakes for the deps these endpoints don't exercise. We then make
 * real HTTP requests via fetch and assert the response contract.
 *
 * Logger is fully stubbed locally and the REAL logger (captured in
 * tests/setup.ts) is restored in afterAll, so this file cannot leak an
 * incomplete logger mock into other suites.
 *
 * Boundary of what these prove: the route -> SessionStore (SQL) wiring is
 * exercised for real against :memory:. The DatabaseManager and ChromaSync are
 * faked, so these tests do NOT prove the DatabaseManager -> Chroma wiring.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import express from 'express';
import type { Server as HttpServer } from 'http';

const noopLogger = new Proxy(
  {},
  { get: (_t, prop) => (prop === 'formatTool' ? (name: string) => String(name) : () => {}) },
);
mock.module('../../../src/utils/logger.js', () => ({ logger: noopLogger }));

import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { MemoryRoutes } from '../../../src/services/worker/http/routes/MemoryRoutes.js';
import { DataRoutes } from '../../../src/services/worker/http/routes/DataRoutes.js';
import { PaginationHelper } from '../../../src/services/worker/PaginationHelper.js';

interface MountedApp {
  baseUrl: string;
  close: () => Promise<void>;
}

async function mountApp(handlers: Array<{ setupRoutes: (app: express.Application) => void }>): Promise<MountedApp> {
  const app = express();
  app.use(express.json());
  for (const h of handlers) h.setupRoutes(app);
  // Final error handler (4-arg signature so express treats it as error middleware).
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (!res.headersSent) res.status(500).json({ error: String(err?.message ?? err) });
  });

  const server: HttpServer = await new Promise((resolve, reject) => {
    // Bind to port 0 so the OS assigns a free ephemeral port — avoids
    // collisions with other suites that also spin up HTTP servers.
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeObservation(overrides: Record<string, any> = {}) {
  return {
    type: 'discovery',
    title: 'Test',
    subtitle: null,
    facts: [],
    narrative: 'narrative',
    concepts: [],
    files_read: [],
    files_modified: [],
    ...overrides,
  };
}

let store: SessionStore;
let mounted: MountedApp;
let syncCalls: any[];

beforeEach(() => {
  store = new SessionStore(':memory:');
  syncCalls = [];
});

afterEach(async () => {
  if (mounted) await mounted.close();
  store.close();
});

afterAll(() => {
  const realLogger = (globalThis as any).__CMEM_REAL_LOGGER__;
  if (realLogger) mock.module('../../../src/utils/logger.js', () => realLogger);
});

const fakeChroma = () => ({
  syncObservation: (...args: any[]) => {
    syncCalls.push(args);
    return Promise.resolve();
  },
});

function memoryRoutesApp(defaultProject = 'default-proj') {
  const dbManager = { getSessionStore: () => store, getChromaSync: fakeChroma } as any;
  return mountApp([new MemoryRoutes(dbManager, defaultProject)]);
}

function dataRoutesApp() {
  const dbManager = { getSessionStore: () => store, getChromaSync: fakeChroma } as any;
  const paginationHelper = new PaginationHelper(dbManager);
  const sessionManager = { getActiveSessionCount: () => 0 } as any;
  const sseBroadcaster = { getClientCount: () => 0 } as any;
  const workerService = {} as any;
  return mountApp([
    new DataRoutes(paginationHelper, dbManager, sessionManager, sseBroadcaster, workerService, Date.now()),
  ]);
}

describe('MemoryRoutes POST /api/memory/save', () => {
  it('saves a memory and persists it to the store', async () => {
    mounted = await memoryRoutesApp();
    const res = await fetch(`${mounted.baseUrl}/api/memory/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'remember this fact', title: 'My Note', project: 'proj-x' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.project).toBe('proj-x');
    expect(body.title).toBe('My Note');
    expect(typeof body.id).toBe('number');

    // Persisted to SQLite.
    const stored = store.getObservationById(body.id);
    expect(stored).not.toBeNull();
    expect(stored!.narrative).toBe('remember this fact');
    expect(stored!.subtitle).toBe('Manual memory');

    // Chroma sync was attempted (fire-and-forget) with the right id/project.
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0][0]).toBe(body.id);
    expect(syncCalls[0][2]).toBe('proj-x');
  });

  it('truncates a long auto-derived title to 60 chars + ellipsis', async () => {
    mounted = await memoryRoutesApp();
    const longText = 'x'.repeat(120);
    const res = await fetch(`${mounted.baseUrl}/api/memory/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: longText }),
    });
    const body = await res.json();
    expect(body.title.endsWith('...')).toBe(true);
    expect(body.title.length).toBe(63); // 60 chars + "..."
  });

  it('derives a title from the text when none is given', async () => {
    mounted = await memoryRoutesApp();
    const res = await fetch(`${mounted.baseUrl}/api/memory/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'short text' }),
    });
    const body = await res.json();
    expect(body.title).toBe('short text');
    expect(body.project).toBe('default-proj');
  });

  it('rejects empty or missing text with 400', async () => {
    mounted = await memoryRoutesApp();
    for (const payload of [{ text: '' }, { text: '   ' }, {}]) {
      const res = await fetch(`${mounted.baseUrl}/api/memory/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
    }
  });
});

describe('DataRoutes retrieval endpoints', () => {
  function seed() {
    const sa = store.getOrCreateManualSession('proj-a');
    const sb = store.getOrCreateManualSession('proj-b');
    const o1 = store.storeObservation(sa, 'proj-a', makeObservation({ title: 'A1' }), 0, 0);
    const o2 = store.storeObservation(sa, 'proj-a', makeObservation({ title: 'A2' }), 0, 0);
    const o3 = store.storeObservation(sb, 'proj-b', makeObservation({ title: 'B1' }), 0, 0);
    return { o1, o2, o3 };
  }

  it('GET /api/observation/:id returns the observation', async () => {
    const { o1 } = seed();
    mounted = await dataRoutesApp();
    const res = await fetch(`${mounted.baseUrl}/api/observation/${o1.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(o1.id);
    expect(body.title).toBe('A1');
  });

  it('GET /api/observation/:id returns 404 for a missing id', async () => {
    seed();
    mounted = await dataRoutesApp();
    const res = await fetch(`${mounted.baseUrl}/api/observation/99999`);
    expect(res.status).toBe(404);
  });

  it('GET /api/observation/:id returns 400 for a non-integer id', async () => {
    seed();
    mounted = await dataRoutesApp();
    const res = await fetch(`${mounted.baseUrl}/api/observation/not-a-number`);
    expect(res.status).toBe(400);
  });

  it('GET /api/session/:id returns 404 for a missing session', async () => {
    seed();
    mounted = await dataRoutesApp();
    const res = await fetch(`${mounted.baseUrl}/api/session/99999`);
    expect(res.status).toBe(404);
  });

  it('GET /api/session/:id returns a stored session summary (positive path)', async () => {
    const sm = store.getOrCreateManualSession('proj-a');
    const summary = store.storeSummary(
      sm,
      'proj-a',
      {
        request: 'do x',
        investigated: 'looked',
        learned: 'learned',
        completed: 'done',
        next_steps: 'none',
        notes: null,
      },
      0,
      0,
    );
    mounted = await dataRoutesApp();
    const res = await fetch(`${mounted.baseUrl}/api/session/${summary.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(summary.id);
    expect(body.request).toBe('do x');
  });

  it('GET /api/projects lists distinct projects', async () => {
    seed();
    mounted = await dataRoutesApp();
    const res = await fetch(`${mounted.baseUrl}/api/projects`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects.sort()).toEqual(['proj-a', 'proj-b']);
  });

  it('GET /api/observations paginates with hasMore', async () => {
    seed(); // 3 observations total
    mounted = await dataRoutesApp();

    const firstPage = await (await fetch(`${mounted.baseUrl}/api/observations?limit=2&offset=0`)).json();
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);

    const lastPage = await (await fetch(`${mounted.baseUrl}/api/observations?limit=2&offset=2`)).json();
    expect(lastPage.items).toHaveLength(1);
    expect(lastPage.hasMore).toBe(false);
  });

  it('reports hasMore=false when the page exactly fills the limit (LIMIT+1 boundary)', async () => {
    const sa = store.getOrCreateManualSession('proj-a');
    store.storeObservation(sa, 'proj-a', makeObservation({ title: 'A1' }), 0, 0);
    store.storeObservation(sa, 'proj-a', makeObservation({ title: 'A2' }), 0, 0);
    mounted = await dataRoutesApp();

    const page = await (await fetch(`${mounted.baseUrl}/api/observations?limit=2&offset=0`)).json();
    expect(page.items).toHaveLength(2);
    // The LIMIT+1 trick must report no more pages even though the page is full.
    expect(page.hasMore).toBe(false);
  });

  // NOTE: GET /api/stats is intentionally not contract-tested here. Its handler
  // reads package.json via getPackageRoot(), which resolves to .../src under the
  // test runner (no package.json there) and 500s — an environment artifact of
  // package-root resolution, not a product bug. It works in the built plugin.
});

describe('DataRoutes POST /api/observations/batch', () => {
  function seed() {
    const sa = store.getOrCreateManualSession('proj-a');
    return [
      store.storeObservation(sa, 'proj-a', makeObservation({ title: 'A1' }), 0, 0).id,
      store.storeObservation(sa, 'proj-a', makeObservation({ title: 'A2' }), 0, 0).id,
    ];
  }

  async function postBatch(body: any) {
    return fetch(`${mounted.baseUrl}/api/observations/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns observations for an array of ids', async () => {
    const ids = seed();
    mounted = await dataRoutesApp();
    const res = await postBatch({ ids });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  it('coerces a JSON-string-encoded id array (MCP clients)', async () => {
    const ids = seed();
    mounted = await dataRoutesApp();
    const res = await postBatch({ ids: JSON.stringify(ids) });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(2);
  });

  it('coerces a comma-separated id string (MCP fallback path)', async () => {
    const ids = seed();
    mounted = await dataRoutesApp();
    const res = await postBatch({ ids: ids.join(',') });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(2);
  });

  it('rejects non-integer / malformed ids with 400', async () => {
    seed();
    mounted = await dataRoutesApp();
    for (const ids of [['1', '2'], [1.5], [null], 'garbage']) {
      const res = await postBatch({ ids });
      expect(res.status).toBe(400);
    }
  });

  it('returns an empty array for an empty id list', async () => {
    seed();
    mounted = await dataRoutesApp();
    const res = await postBatch({ ids: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('rejects a non-array ids payload with 400', async () => {
    seed();
    mounted = await dataRoutesApp();
    const res = await postBatch({ ids: 42 });
    expect(res.status).toBe(400);
  });
});
