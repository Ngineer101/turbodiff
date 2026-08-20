import type { Sandbox } from '@cloudflare/sandbox';
import { skillMarkdown, type SkillDefinition } from '../../domain/skill-files.ts';

export async function mountSkills(
  sandbox: Sandbox,
  workDir: string,
  skills: SkillDefinition[],
): Promise<void> {
  for (const skill of skills) {
    const dir = `${workDir}/.claude/skills/${skill.slug}`;
    await sandbox.exec(`mkdir -p ${dir}`);
    await sandbox.writeFile(`${dir}/SKILL.md`, skillMarkdown(skill));
  }
}
