import { describe, expect, it } from 'vite-plus/test';
// Co-located with the pure skill-import policies.
import {
  classifyAuditVerdict,
  deriveSkillSlug,
  overallAuditOutcome,
  parseSkillMarkdown,
  parseSkillReference,
  sanitizeSkillFiles,
  validSkillFilePath,
} from './skill-import.ts';

describe('validSkillFilePath', () => {
  it.each(['references/palette.md', 'SKILL.md', 'a', 'scripts/run_all.sh', 'deep/a/b/c.txt'])(
    'accepts a well-formed relative path: %s',
    (path) => {
      expect(validSkillFilePath(path)).toBe(true);
    },
  );

  it.each([
    '../escape.md',
    'refs/../../etc/passwd',
    '/etc/passwd',
    '-rf',
    'dir//double.md',
    'dir/./dot.md',
    'space in name.md',
    'semi;colon.md',
    'tick`.md',
    '$var.md',
    '',
    `${'a/'.repeat(101)}b`,
  ])('rejects a path that could escape or corrupt the mount command: %s', (path) => {
    expect(validSkillFilePath(path)).toBe(false);
  });
});

describe('parseSkillMarkdown', () => {
  it('extracts quoted frontmatter scalars and the body', () => {
    const parsed = parseSkillMarkdown(
      `---\nname: "pdf-forms"\ndescription: "Handles: \\"quoted\\" values"\n---\n\nFill out forms.\n`,
    );
    expect(parsed).toEqual({
      name: 'pdf-forms',
      description: 'Handles: "quoted" values',
      body: 'Fill out forms.',
    });
  });

  it('extracts unquoted scalars and tolerates extra frontmatter keys', () => {
    const parsed = parseSkillMarkdown(
      `---\nname: pdf-forms\nlicense: MIT\ndescription: Fill PDF forms\n---\nBody line.`,
    );
    expect(parsed.name).toBe('pdf-forms');
    expect(parsed.description).toBe('Fill PDF forms');
    expect(parsed.body).toBe('Body line.');
  });

  it('treats a document without frontmatter as all body', () => {
    expect(parseSkillMarkdown('Just instructions.\n')).toEqual({
      name: null,
      description: null,
      body: 'Just instructions.',
    });
  });
});

describe('deriveSkillSlug', () => {
  it('lowercases and collapses non-alphanumeric runs into single dashes', () => {
    expect(deriveSkillSlug('PDF  Forms & Docs')).toBe('pdf-forms-docs');
  });

  it('truncates to 31 chars without leaving a trailing dash', () => {
    const slug = deriveSkillSlug('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bcdef');
    expect(slug).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(slug.length).toBeLessThanOrEqual(31);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('trims leading and trailing separators', () => {
    expect(deriveSkillSlug('--hello world!--')).toBe('hello-world');
  });
});

describe('sanitizeSkillFiles', () => {
  it('drops the root SKILL.md and invalid paths, keeps the rest', () => {
    const files = sanitizeSkillFiles([
      { path: 'SKILL.md', contents: 'rendered separately' },
      { path: '../evil.md', contents: 'x' },
      { path: 'references/notes.md', contents: 'keep me' },
    ]);
    expect(files).toEqual([{ path: 'references/notes.md', contents: 'keep me' }]);
  });

  it('throws a descriptive error when a file exceeds the per-file limit', () => {
    expect(() =>
      sanitizeSkillFiles([{ path: 'big.md', contents: 'x'.repeat(256 * 1024 + 1) }]),
    ).toThrow('too large');
  });

  it('applies the per-file limit to SKILL.md even though it is dropped', () => {
    expect(() =>
      sanitizeSkillFiles([{ path: 'SKILL.md', contents: 'x'.repeat(256 * 1024 + 1) }]),
    ).toThrow('too large');
  });

  it('counts SKILL.md against the total budget', () => {
    const files = [
      { path: 'SKILL.md', contents: 'x'.repeat(250 * 1024) },
      ...Array.from({ length: 4 }, (_, i) => ({
        path: `f${i}.md`,
        contents: 'x'.repeat(250 * 1024),
      })),
    ];
    expect(() => sanitizeSkillFiles(files)).toThrow('1 MiB');
  });

  it('throws when the total budget is exceeded', () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      path: `f${i}.md`,
      contents: 'x'.repeat(250 * 1024),
    }));
    expect(() => sanitizeSkillFiles(files)).toThrow('1 MiB');
  });

  it('throws when there are too many files', () => {
    const files = Array.from({ length: 21 }, (_, i) => ({ path: `f${i}.md`, contents: 'x' }));
    expect(() => sanitizeSkillFiles(files)).toThrow('too many files');
  });
});

describe('parseSkillReference', () => {
  it('parses a bare owner/repo/slug triple', () => {
    expect(parseSkillReference('anthropics/skills/pdf-forms')).toEqual({
      kind: 'catalog',
      source: 'anthropics/skills',
      slug: 'pdf-forms',
    });
  });

  it('parses skills.sh URLs by their trailing three path segments', () => {
    for (const url of [
      'https://skills.sh/anthropics/skills/pdf-forms',
      'https://www.skills.sh/skills/anthropics/skills/pdf-forms',
    ]) {
      expect(parseSkillReference(url)).toEqual({
        kind: 'catalog',
        source: 'anthropics/skills',
        slug: 'pdf-forms',
      });
    }
  });

  it('parses a GitHub folder URL into owner/repo/ref/path', () => {
    expect(
      parseSkillReference('https://github.com/anthropics/skills/tree/main/skills/pdf-forms'),
    ).toEqual({
      kind: 'github',
      owner: 'anthropics',
      repo: 'skills',
      ref: 'main',
      path: 'skills/pdf-forms',
    });
  });

  it.each([
    '',
    'not-a-reference',
    'owner/repo',
    'https://example.com/a/b/c',
    'https://github.com/owner/repo',
    'https://github.com/owner/repo/blob/main/SKILL.md',
  ])('returns null for an unparseable reference: %s', (reference) => {
    expect(parseSkillReference(reference)).toBeNull();
  });
});

describe('classifyAuditVerdict', () => {
  it.each(['pass', 'PASSED', 'safe', 'Looks clean', 'approved'])('reads %s as a pass', (v) => {
    expect(classifyAuditVerdict(v)).toBe('pass');
  });

  it.each(['fail', 'unsafe', 'malicious', 'rejected'])('reads %s as a fail', (v) => {
    expect(classifyAuditVerdict(v)).toBe('fail');
  });

  it('fails over passes when a verdict mentions both', () => {
    expect(classifyAuditVerdict('not safe — fails the prompt-injection check')).toBe('fail');
  });

  it('leaves unfamiliar wording unclassified', () => {
    expect(classifyAuditVerdict('pending')).toBeNull();
  });
});

describe('overallAuditOutcome', () => {
  it('passes only when every auditor passed', () => {
    expect(overallAuditOutcome([{ verdict: 'pass' }, { verdict: 'clean' }])).toBe('pass');
  });

  it('fails when any auditor failed, whatever the others said', () => {
    expect(overallAuditOutcome([{ verdict: 'pass' }, { verdict: 'unsafe' }])).toBe('fail');
  });

  it('is unknown with no audit, an empty audit, or an unclassifiable verdict', () => {
    expect(overallAuditOutcome(null)).toBeNull();
    expect(overallAuditOutcome([])).toBeNull();
    expect(overallAuditOutcome([{ verdict: 'pass' }, { verdict: 'pending' }])).toBeNull();
  });
});
