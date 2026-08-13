import { describe, expect, it } from 'vite-plus/test';
import { skillMarkdown } from './skill-files.ts';
import type { SkillRow } from './db.ts';

const baseSkill: SkillRow = {
  id: 1,
  installation_id: 1,
  slug: 'pdf-forms',
  name: 'PDF Forms',
  description: null,
  instructions: 'Fill out PDF forms using pdftk.',
  created_at: '2026-01-01 00:00:00',
};

describe('skillMarkdown', () => {
  it('escapes a description containing a colon and a quote', () => {
    const skill: SkillRow = {
      ...baseSkill,
      description: 'Handles: "quoted" values',
    };
    expect(skillMarkdown(skill)).toBe(
      `---
name: "pdf-forms"
description: "Handles: \\"quoted\\" values"
---

Fill out PDF forms using pdftk.
`,
    );
  });

  it('passes instructions through unmodified', () => {
    const skill: SkillRow = {
      ...baseSkill,
      instructions: 'Line one.\n\nLine two with *markdown* and `code`.',
    };
    expect(skillMarkdown(skill)).toContain('Line one.\n\nLine two with *markdown* and `code`.');
  });
});
