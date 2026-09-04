import { skillMarkdown, type SkillDefinition } from '../../domain/skill-files.ts';
import { validSkillFilePath } from '../../domain/skill-import.ts';

// The two sandbox capabilities mounting needs (structurally satisfied by
// @cloudflare/sandbox's Sandbox) — narrow so tests can stub it, same idiom
// as CheckSandbox in check-command.ts.
export interface SkillMountSandbox {
  // Only success is named — the sandbox's richer ExecResult/WriteFileResult
  // shapes satisfy these structurally, and mounting ignores the rest.
  exec(command: string): Promise<{ success: boolean }>;
  writeFile(path: string, contents: string): Promise<{ success: boolean }>;
}

export async function mountSkills(
  sandbox: SkillMountSandbox,
  workDir: string,
  skills: SkillDefinition[],
): Promise<void> {
  for (const skill of skills) {
    const dir = `${workDir}/.claude/skills/${skill.slug}`;
    await sandbox.exec(`mkdir -p ${dir}`);
    await sandbox.writeFile(`${dir}/SKILL.md`, skillMarkdown(skill));
    for (const file of skill.files ?? []) {
      // Defense in depth: the import route already sanitizes, but a path is
      // about to be interpolated into a shell command — never mount one
      // that fails the policy check.
      if (!validSkillFilePath(file.path)) continue;
      const parent = file.path.split('/').slice(0, -1).join('/');
      if (parent) await sandbox.exec(`mkdir -p ${dir}/${parent}`);
      await sandbox.writeFile(`${dir}/${file.path}`, file.contents);
    }
  }
}
