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

// Renders a portable Agent Skill. OpenCode intentionally discovers the
// Claude-compatible .claude/skills path too, so existing mounted skills need
// no on-disk migration. JSON.stringify produces safe YAML scalars.
export function skillMarkdown(skill: SkillDefinition): string {
  const description = skill.description?.trim() || skill.name;
  return `---
name: ${JSON.stringify(skill.slug)}
description: ${JSON.stringify(description)}
---

${skill.instructions}
`;
}
