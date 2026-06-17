/**
 * Unit tests for the transcript field-resolution utilities.
 *
 * These are pure functions (JSONPath-ish traversal, field-spec coalescing,
 * and match-rule evaluation) that drive the transcript ingestion pipeline.
 * No mocks required.
 */
import { describe, it, expect } from 'bun:test';
import {
  getValueByPath,
  resolveFieldSpec,
  resolveFields,
  matchesRule,
} from '../../../src/services/transcripts/field-utils.js';
import type { TranscriptSchema, WatchTarget, MatchRule, FieldSpec } from '../../../src/services/transcripts/types.js';

const schema: TranscriptSchema = {
  name: 'test-schema',
  eventTypePath: 'type',
  events: [],
};

const watch: WatchTarget = {
  name: 'w1',
  path: '/logs',
  schema: 'test-schema',
  workspace: '/work/proj',
  project: 'proj',
};

const ctx = { watch, schema, session: { sid: 'S-1' } };

describe('getValueByPath', () => {
  it('reads a top-level property', () => {
    expect(getValueByPath({ type: 'tool' }, 'type')).toBe('tool');
  });

  it('reads nested properties', () => {
    expect(getValueByPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('reads array indices', () => {
    expect(getValueByPath({ items: [{ name: 'x' }, { name: 'y' }] }, 'items[1].name')).toBe('y');
  });

  it('strips a leading $ / $.', () => {
    expect(getValueByPath({ a: 1 }, '$.a')).toBe(1);
    expect(getValueByPath({ a: 1 }, '$a')).toBe(1);
  });

  it('returns undefined for missing paths and null traversal', () => {
    expect(getValueByPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(getValueByPath({ a: null }, 'a.b')).toBeUndefined();
    expect(getValueByPath(null, 'a')).toBeUndefined();
    expect(getValueByPath({ a: 1 }, '')).toBeUndefined();
  });
});

describe('resolveFieldSpec', () => {
  it('returns undefined for an undefined spec', () => {
    expect(resolveFieldSpec(undefined, {}, ctx)).toBeUndefined();
  });

  it('resolves a plain string path against the entry', () => {
    expect(resolveFieldSpec('type', { type: 'observation' }, ctx)).toBe('observation');
  });

  it('resolves context tokens ($cwd / $project / $watch / $schema / $session)', () => {
    expect(resolveFieldSpec('$cwd', {}, ctx)).toBe('/work/proj');
    expect(resolveFieldSpec('$project', {}, ctx)).toBe('proj');
    expect(resolveFieldSpec('$watch.name', {}, ctx)).toBe('w1');
    expect(resolveFieldSpec('$schema.name', {}, ctx)).toBe('test-schema');
    expect(resolveFieldSpec('$session.sid', {}, ctx)).toBe('S-1');
  });

  it('coalesces to the first non-empty candidate', () => {
    const spec: FieldSpec = { coalesce: ['missing.path', 'present'] };
    expect(resolveFieldSpec(spec, { present: 'here' }, ctx)).toBe('here');
  });

  it('falls through coalesce -> path -> value -> default', () => {
    // path wins when present
    expect(resolveFieldSpec({ path: 'a', value: 'V', default: 'D' }, { a: 'fromPath' }, ctx)).toBe('fromPath');
    // value wins when path empty
    expect(resolveFieldSpec({ path: 'missing', value: 'V', default: 'D' }, {}, ctx)).toBe('V');
    // default is last resort
    expect(resolveFieldSpec({ path: 'missing', default: 'D' }, {}, ctx)).toBe('D');
  });

  it('treats empty string/null/undefined as empty when coalescing', () => {
    const spec: FieldSpec = { coalesce: ['empty', 'blank', 'good'] };
    expect(resolveFieldSpec(spec, { empty: '', blank: null, good: 'value' }, ctx)).toBe('value');
  });
});

describe('resolveFields', () => {
  it('resolves a map of field specs', () => {
    const fields: Record<string, FieldSpec> = {
      sessionId: '$session.sid',
      title: 'data.title',
      project: '$project',
    };
    const resolved = resolveFields(fields, { data: { title: 'Hello' } }, ctx);
    expect(resolved).toEqual({ sessionId: 'S-1', title: 'Hello', project: 'proj' });
  });

  it('returns an empty object when fields is undefined', () => {
    expect(resolveFields(undefined, {}, ctx)).toEqual({});
  });
});

describe('matchesRule', () => {
  it('matches everything when no rule is given', () => {
    expect(matchesRule({ type: 'x' }, undefined, schema)).toBe(true);
  });

  it('evaluates an equals rule against the default eventTypePath', () => {
    const rule: MatchRule = { equals: 'tool_use' };
    expect(matchesRule({ type: 'tool_use' }, rule, schema)).toBe(true);
    expect(matchesRule({ type: 'other' }, rule, schema)).toBe(false);
  });

  it('evaluates an explicit path', () => {
    const rule: MatchRule = { path: 'event.kind', equals: 'k' };
    expect(matchesRule({ event: { kind: 'k' } }, rule, schema)).toBe(true);
  });

  it('evaluates an "in" rule', () => {
    const rule: MatchRule = { in: ['a', 'b'] };
    expect(matchesRule({ type: 'b' }, rule, schema)).toBe(true);
    expect(matchesRule({ type: 'c' }, rule, schema)).toBe(false);
  });

  it('evaluates a "contains" rule (string only)', () => {
    const rule: MatchRule = { contains: 'err' };
    expect(matchesRule({ type: 'has-error' }, rule, schema)).toBe(true);
    expect(matchesRule({ type: 'clean' }, rule, schema)).toBe(false);
    expect(matchesRule({ type: 123 }, rule, schema)).toBe(false);
  });

  it('evaluates an "exists" rule', () => {
    const rule: MatchRule = { path: 'maybe', exists: true };
    expect(matchesRule({ maybe: 'yes' }, rule, schema)).toBe(true);
    expect(matchesRule({ maybe: '' }, rule, schema)).toBe(false);
    expect(matchesRule({}, rule, schema)).toBe(false);
  });

  it('evaluates a regex rule and fails closed on an invalid pattern', () => {
    expect(matchesRule({ type: 'abc123' }, { regex: '\\d+' }, schema)).toBe(true);
    expect(matchesRule({ type: 'abc' }, { regex: '\\d+' }, schema)).toBe(false);
    // Invalid regex -> false rather than throwing.
    expect(matchesRule({ type: 'abc' }, { regex: '(' }, schema)).toBe(false);
  });
});
