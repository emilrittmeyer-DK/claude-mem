/**
 * Unit tests for ChromaSync's pure, MCP-free logic: collection-name
 * sanitization (constructor) and document formatting. These are private
 * methods exercised via white-box access — they contain no network/MCP calls,
 * so no live Chroma server is required.
 *
 * Batching / addDocuments / sync* are not covered here (they require a mocked
 * ChromaMcpManager) — see the integration suite.
 */
import { describe, it, expect } from 'bun:test';
import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';

function collectionName(project: string): string {
  return (new ChromaSync(project) as any).collectionName;
}

describe('ChromaSync collection-name sanitization', () => {
  it('keeps already-valid names', () => {
    expect(collectionName('my-project')).toBe('cm__my-project');
    expect(collectionName('name.v2')).toBe('cm__name.v2');
    expect(collectionName('123abc')).toBe('cm__123abc');
  });

  it('replaces disallowed characters with underscores', () => {
    expect(collectionName('My Project')).toBe('cm__My_Project');
  });

  it('strips trailing non-alphanumeric characters', () => {
    expect(collectionName('weird™!!!')).toBe('cm__weird');
    expect(collectionName('name.')).toBe('cm__name');
  });

  it('falls back to "unknown" when nothing usable remains', () => {
    expect(collectionName('')).toBe('cm__unknown');
    expect(collectionName('™™™')).toBe('cm__unknown');
  });
});

describe('ChromaSync.formatObservationDocs', () => {
  const sync = new ChromaSync('proj') as any;

  const obs = {
    id: 5,
    memory_session_id: 'mem-1',
    project: 'proj',
    created_at_epoch: 1234,
    type: 'bugfix',
    title: 'T',
    subtitle: 'sub',
    narrative: 'the narrative',
    text: null,
    facts: JSON.stringify(['fact one', 'fact two']),
    concepts: JSON.stringify(['c1']),
    files_read: JSON.stringify(['a.ts']),
    files_modified: JSON.stringify([]),
  };

  it('emits one narrative doc plus one doc per fact', () => {
    const docs = sync.formatObservationDocs(obs);
    expect(docs).toHaveLength(3); // narrative + 2 facts (no text)

    const narrative = docs.find((d: any) => d.id === 'obs_5_narrative');
    expect(narrative.document).toBe('the narrative');
    expect(narrative.metadata.field_type).toBe('narrative');

    expect(docs.find((d: any) => d.id === 'obs_5_fact_0').document).toBe('fact one');
    expect(docs.find((d: any) => d.id === 'obs_5_fact_1').document).toBe('fact two');
    expect(docs.find((d: any) => d.id === 'obs_5_fact_1').metadata.fact_index).toBe(1);
  });

  it('carries base metadata and joins concepts/files', () => {
    const docs = sync.formatObservationDocs(obs);
    const meta = docs[0].metadata;
    expect(meta.sqlite_id).toBe(5);
    expect(meta.doc_type).toBe('observation');
    expect(meta.type).toBe('bugfix');
    expect(meta.title).toBe('T');
    expect(meta.subtitle).toBe('sub');
    expect(meta.concepts).toBe('c1');
    expect(meta.files_read).toBe('a.ts');
    // files_modified was empty -> omitted
    expect(meta.files_modified).toBeUndefined();
  });

  it('includes a legacy text doc when present', () => {
    const docs = sync.formatObservationDocs({ ...obs, narrative: null, facts: '[]', text: 'legacy body' });
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe('obs_5_text');
    expect(docs[0].metadata.field_type).toBe('text');
  });
});

describe('ChromaSync.formatSummaryDocs', () => {
  const sync = new ChromaSync('proj') as any;

  it('emits one doc per non-empty field, skipping empty/null fields', () => {
    const docs = sync.formatSummaryDocs({
      id: 9,
      memory_session_id: 'mem-1',
      project: 'proj',
      created_at_epoch: 1,
      prompt_number: 2,
      request: 'r',
      investigated: 'i',
      learned: 'l',
      completed: '', // empty -> skipped
      next_steps: null, // null -> skipped
      notes: 'n',
    });

    const ids = docs.map((d: any) => d.id).sort();
    expect(ids).toEqual([
      'summary_9_investigated',
      'summary_9_learned',
      'summary_9_notes',
      'summary_9_request',
    ].sort());

    const request = docs.find((d: any) => d.id === 'summary_9_request');
    expect(request.metadata.doc_type).toBe('session_summary');
    expect(request.metadata.field_type).toBe('request');
    expect(request.metadata.prompt_number).toBe(2);
  });
});
