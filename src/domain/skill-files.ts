// Pure rendering of persisted skills into an agent-runtime file format.

import type { SkillFile } from './skill-import.ts';

export interface SkillDefinition {
  slug: string;
  name: string;
  description: string | null;
  instructions: string;
  // Extra files beyond SKILL.md, present on imported multi-file skills.
  files?: SkillFile[] | null;
}

// Renders a skill as a native Claude Code SKILL.md so `claude -p` auto-
// discovers it from .claude/skills/<slug>/SKILL.md in the sandboxed
// checkout. JSON.stringify produces valid double-quoted YAML scalars, so
// arbitrary name/description text (colons, quotes, newlines) can't corrupt
// the frontmatter block.
export function skillMarkdown(skill: SkillDefinition): string {
  const description = skill.description?.trim() || skill.name;
  return `---
name: ${JSON.stringify(skill.slug)}
description: ${JSON.stringify(description)}
---

${skill.instructions}
`;
}
