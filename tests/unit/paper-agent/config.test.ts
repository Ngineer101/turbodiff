import { describe, expect, it } from 'vite-plus/test';
import { validatePaperUrl } from '../../../src/paper-agent/config.ts';

describe('validatePaperUrl', () => {
  it('accepts and normalises an absolute https URL', () => {
    expect(validatePaperUrl('https://paper.example.com/doc/abc')).toBe(
      'https://paper.example.com/doc/abc',
    );
    expect(validatePaperUrl('  https://paper.example.com/doc/abc  ')).toBe(
      'https://paper.example.com/doc/abc',
    );
  });

  it('accepts http', () => {
    expect(validatePaperUrl('http://localhost:8787/x')).toBe('http://localhost:8787/x');
  });

  it('rejects an empty value', () => {
    expect(() => validatePaperUrl('   ')).toThrow(/no Paper URL/);
  });

  it('rejects a value without a scheme (what Chromium reports as invalid URL)', () => {
    expect(() => validatePaperUrl('paper.example.com/doc/abc')).toThrow(/invalid Paper URL/);
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => validatePaperUrl('ftp://paper.example.com/doc')).toThrow(/http or https/);
  });
});
