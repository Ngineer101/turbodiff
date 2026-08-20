import { describe, expect, it } from 'vite-plus/test';
// Co-located with the pure skill renderer.
import { skillMarkdown, type SkillDefinition } from './skill-files.ts';

const baseSkill: SkillDefinition = {
  slug: 'pdf-forms',
  name: 'PDF Forms',
  description: null,
  instructions: 'Fill out PDF forms using pdftk.',
};

describe('skillMarkdown', () => {
  it('escapes a description containing a colon and a quote', () => {
    const skill: SkillDefinition = {
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
    const skill: SkillDefinition = {
      ...baseSkill,
      instructions: 'Line one.\n\nLine two with *markdown* and `code`.',
    };
    expect(skillMarkdown(skill)).toContain('Line one.\n\nLine two with *markdown* and `code`.');
  });
});
