/**
 * Unit tests for the smart-file-read parser.
 *
 * detectLanguage and the parseFile fallback path are pure/deterministic. Real
 * tree-sitter parsing shells out to the tree-sitter CLI (slow first-run grammar
 * compilation, environment-dependent), so it is intentionally not exercised
 * here — these tests stay fast and deterministic.
 */
import { describe, it, expect } from 'bun:test';
import { detectLanguage, parseFile } from '../../../src/services/smart-file-read/parser.js';

describe('detectLanguage', () => {
  const cases: Array<[string, string]> = [
    ['file.ts', 'typescript'],
    ['file.tsx', 'tsx'],
    ['file.jsx', 'tsx'],
    ['file.js', 'javascript'],
    ['file.mjs', 'javascript'],
    ['file.cjs', 'javascript'],
    ['file.py', 'python'],
    ['file.pyw', 'python'],
    ['file.go', 'go'],
    ['file.rs', 'rust'],
    ['file.rb', 'ruby'],
    ['file.java', 'java'],
    ['file.c', 'c'],
    ['file.h', 'c'],
    ['file.cpp', 'cpp'],
    ['file.cc', 'cpp'],
    ['file.cxx', 'cpp'],
    ['file.hpp', 'cpp'],
    ['file.hh', 'cpp'],
    ['/abs/path/to/module.ts', 'typescript'],
    ['file.unknownext', 'unknown'],
    ['Makefile', 'unknown'],
    ['.gitignore', 'unknown'],
  ];

  for (const [input, expected] of cases) {
    it(`maps ${input} -> ${expected}`, () => {
      expect(detectLanguage(input)).toBe(expected);
    });
  }
});

describe('parseFile fallback (no grammar)', () => {
  it('returns an empty-symbol FoldedFile for an unknown language', () => {
    const content = 'line one\nline two\nline three';
    const result = parseFile(content, 'notes.unknownext');
    expect(result.filePath).toBe('notes.unknownext');
    expect(result.language).toBe('unknown');
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.totalLines).toBe(3);
    expect(typeof result.foldedTokenEstimate).toBe('number');
  });

  it('counts lines correctly for an empty file', () => {
    const result = parseFile('', 'empty.unknownext');
    expect(result.totalLines).toBe(1); // ''.split('\n') -> ['']
    expect(result.symbols).toEqual([]);
  });
});
