import { describe, expect, it } from 'vite-plus/test';
import { mountSkills, type SkillMountSandbox } from './skills.ts';

// Minimal fake sandbox: records exec commands and written files.
function fakeSandbox() {
  const execs: string[] = [];
  const writes: { path: string; contents: string }[] = [];
  const sandbox: SkillMountSandbox = {
    exec: async (command) => {
      execs.push(command);
      return { success: true };
    },
    writeFile: async (path, contents) => {
      writes.push({ path, contents });
      return { success: true };
    },
  };
  return { sandbox, execs, writes };
}

describe('mountSkills', () => {
  it('writes SKILL.md plus every extra file under the skill directory', async () => {
    const { sandbox, execs, writes } = fakeSandbox();

    await mountSkills(sandbox, '/work', [
      {
        slug: 'pdf-forms',
        name: 'PDF Forms',
        description: null,
        instructions: 'Use pdftk.',
        files: [
          { path: 'references/notes.md', contents: 'notes' },
          { path: 'top.txt', contents: 'top' },
        ],
      },
    ]);

    expect(execs).toEqual([
      'mkdir -p /work/.claude/skills/pdf-forms',
      'mkdir -p /work/.claude/skills/pdf-forms/references',
    ]);
    expect(writes.map((w) => w.path)).toEqual([
      '/work/.claude/skills/pdf-forms/SKILL.md',
      '/work/.claude/skills/pdf-forms/references/notes.md',
      '/work/.claude/skills/pdf-forms/top.txt',
    ]);
    expect(writes[1]?.contents).toBe('notes');
  });

  it('skips files whose path fails the mount policy, and tolerates absent files', async () => {
    const { sandbox, writes } = fakeSandbox();

    await mountSkills(sandbox, '/work', [
      {
        slug: 'sneaky',
        name: 'Sneaky',
        description: null,
        instructions: 'x',
        files: [
          { path: '../escape.md', contents: 'no' },
          { path: '/etc/passwd', contents: 'no' },
          { path: 'ok.md', contents: 'yes' },
        ],
      },
      { slug: 'plain', name: 'Plain', description: null, instructions: 'y' },
    ]);

    expect(writes.map((w) => w.path)).toEqual([
      '/work/.claude/skills/sneaky/SKILL.md',
      '/work/.claude/skills/sneaky/ok.md',
      '/work/.claude/skills/plain/SKILL.md',
    ]);
  });
});
