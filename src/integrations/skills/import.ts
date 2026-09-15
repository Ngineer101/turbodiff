import {
  deriveSkillSlug,
  parseSkillMarkdown,
  sanitizeSkillFiles,
  type SkillFile,
  type SkillReference,
} from '../../domain/skill-import.ts';
import { installationToken } from '../github/app.ts';
import { GitHubApiError, githubJson } from '../github/client.ts';
import type { AuditVerdict, SkillsShClient } from '../skills-sh/client.ts';

export class SkillImportError extends Error {}

export interface ResolvedSkillImport {
  name: string;
  suggestedSlug: string;
  description: string | null;
  instructions: string;
  files: SkillFile[];
  source: 'skills.sh' | 'github';
  sourceRef: string;
  hash: string | null;
  installs: number | null;
  audit: AuditVerdict[] | null;
}

function sanitized(files: { path: string; contents: string }[]): SkillFile[] {
  try {
    return sanitizeSkillFiles(files);
  } catch (error) {
    throw new SkillImportError(error instanceof Error ? error.message : 'skill files are invalid');
  }
}

function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

async function githubFolder(
  token: string,
  reference: SkillReference & { kind: 'github' },
): Promise<{ path: string; contents: string }[]> {
  const refQuery = reference.ref ? `?ref=${encodeURIComponent(reference.ref)}` : '';
  const files: { path: string; contents: string }[] = [];
  const visit = async (path: string, depth: number): Promise<void> => {
    const listing = await githubJson<
      { path: string; type: string }[] | { path: string; type: string }
    >(token, `/repos/${reference.owner}/${reference.repo}/contents/${path}${refQuery}`);
    if (!Array.isArray(listing)) {
      throw new SkillImportError('the GitHub URL must point to a folder containing a SKILL.md');
    }
    for (const entry of listing) {
      if (entry.type === 'dir') {
        if (depth < 3) await visit(entry.path, depth + 1);
        continue;
      }
      if (entry.type !== 'file') continue;
      if (files.length >= 30) {
        throw new SkillImportError('the GitHub folder has too many files to import as a skill');
      }
      const file = await githubJson<{ content?: string; encoding?: string }>(
        token,
        `/repos/${reference.owner}/${reference.repo}/contents/${entry.path}${refQuery}`,
      );
      if (!file.content || file.encoding !== 'base64') continue;
      files.push({
        path: entry.path.slice(reference.path.length + 1),
        contents: decodeBase64Utf8(file.content),
      });
    }
  };
  await visit(reference.path, 0);
  return files;
}

export async function resolveSkillImport(
  reference: SkillReference,
  rawReference: string,
  installationId: number,
  skillsSh: SkillsShClient,
): Promise<ResolvedSkillImport> {
  if (reference.kind === 'catalog') {
    if (!skillsSh.configured()) {
      throw new SkillImportError(
        'skills.sh access is not configured; use a GitHub folder URL instead',
      );
    }
    const [detail, audit] = await Promise.all([
      skillsSh.detail(reference.source, reference.slug),
      skillsSh.audit(reference.source, reference.slug).catch(() => null),
    ]);
    if (!detail.files) throw new SkillImportError('skills.sh has no snapshot for this skill');
    const skillMarkdown = detail.files.find((file) => file.path === 'SKILL.md');
    if (!skillMarkdown) throw new SkillImportError('the skills.sh snapshot has no SKILL.md');
    const parsed = parseSkillMarkdown(skillMarkdown.contents);
    return {
      name: parsed.name ?? detail.name,
      suggestedSlug: deriveSkillSlug(reference.slug || parsed.name || detail.name),
      description: parsed.description ?? detail.description,
      instructions: parsed.body,
      files: sanitized(detail.files),
      source: 'skills.sh',
      sourceRef: `${reference.source}/${reference.slug}`,
      hash: detail.hash,
      installs: detail.installs,
      audit,
    };
  }

  let folder: { path: string; contents: string }[];
  try {
    folder = await githubFolder(await installationToken(installationId), reference);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      throw new SkillImportError('the GitHub folder was not found');
    }
    throw error;
  }
  const skillMarkdown = folder.find((file) => file.path === 'SKILL.md');
  if (!skillMarkdown) throw new SkillImportError('the GitHub folder has no SKILL.md');
  const parsed = parseSkillMarkdown(skillMarkdown.contents);
  const name = parsed.name ?? reference.path.split('/').pop() ?? reference.repo;
  return {
    name,
    suggestedSlug: deriveSkillSlug(name),
    description: parsed.description,
    instructions: parsed.body,
    files: sanitized(folder),
    source: 'github',
    sourceRef: rawReference.trim(),
    hash: null,
    installs: null,
    audit: null,
  };
}
