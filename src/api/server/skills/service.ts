import { Context, Effect, Layer } from 'effect';
import {
  createSkill,
  deleteSkill,
  getSkill,
  getSkillBySlug,
  listIntegrations,
  listSkills,
  updateSkill,
  type SkillRow,
} from '../../../data/db.ts';
import { parseSkillReference } from '../../../domain/skill-import.ts';
import { validateSkillSlug } from '../../../domain/skill-definition.ts';
import { SkillsShApiError } from '../../../integrations/skills-sh/client.ts';
import { resolveSkillImport, SkillImportError } from '../../../integrations/skills/import.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type {
  CreateSkill,
  Skill,
  SkillCollection,
  SkillImportPreview,
  UpdateSkill,
} from '../../contract/skills.ts';
import {
  badRequest,
  conflict,
  internalServerError,
  notFound,
  upstreamFailure,
  type DomainError,
} from '../../contract/errors.ts';
import { requireOrganization, requireOrganizationWrite } from '../authorization.ts';
import { ApiDependencies } from '../context.ts';

const dataEffect = <A>(run: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: run,
    catch: (failure) => {
      console.error('turbodiff: skill operation failed', failure);
      return internalServerError();
    },
  });

const serialize = (row: SkillRow): Skill => ({
  id: row.id,
  organizationId: row.organization_id,
  slug: row.slug,
  name: row.name,
  content: row.content,
  contentHash: row.content_hash,
  enabled: row.enabled,
});

const contentHash = async (content: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const owned = (user: CurrentUserIdentity, id: number) =>
  dataEffect(() => getSkill(id)).pipe(
    Effect.flatMap((row) =>
      row && user.organizationIds.includes(row.organization_id)
        ? Effect.succeed(row)
        : Effect.fail(notFound('Unknown skill')),
    ),
  );

export interface SkillOperations {
  readonly catalog: (
    query: string,
    sort: 'all-time' | 'trending' | 'hot',
  ) => Effect.Effect<
    {
      configured: boolean;
      items: readonly {
        source: string;
        slug: string;
        name: string;
        description: string | null;
        installs: number | null;
      }[];
      error?: string;
    },
    DomainError
  >;
  readonly previewImport: (
    user: CurrentUserIdentity,
    organizationId: string,
    reference: string,
  ) => Effect.Effect<typeof SkillImportPreview.Type, DomainError>;
  readonly import: (
    user: CurrentUserIdentity,
    organizationId: string,
    reference: string,
    slug?: string,
  ) => Effect.Effect<Skill, DomainError>;
  readonly list: (user: CurrentUserIdentity) => Effect.Effect<SkillCollection, DomainError>;
  readonly get: (user: CurrentUserIdentity, id: number) => Effect.Effect<Skill, DomainError>;
  readonly create: (
    user: CurrentUserIdentity,
    input: CreateSkill,
  ) => Effect.Effect<Skill, DomainError>;
  readonly update: (
    user: CurrentUserIdentity,
    id: number,
    input: UpdateSkill,
  ) => Effect.Effect<Skill, DomainError>;
  readonly remove: (user: CurrentUserIdentity, id: number) => Effect.Effect<void, DomainError>;
}

export class SkillService extends Context.Tag('Turbodiff/SkillService')<
  SkillService,
  SkillOperations
>() {}

export const SkillServiceLive = Layer.effect(
  SkillService,
  Effect.gen(function* () {
    const dependencies = yield* ApiDependencies;

    const resolve = (organizationId: string, rawReference: string) =>
      Effect.gen(function* () {
        const reference = parseSkillReference(rawReference);
        if (!reference) {
          return yield* Effect.fail(
            badRequest('Use owner/repo/skill, a skills.sh URL, or a GitHub folder URL'),
          );
        }
        let githubInstallationId = 0;
        if (reference.kind === 'github') {
          const integrations = yield* dataEffect(() => listIntegrations([organizationId]));
          const github = integrations.find(
            (integration) => integration.provider === 'github' && integration.enabled,
          );
          githubInstallationId = Number(github?.external_account_id);
          if (!Number.isSafeInteger(githubInstallationId) || githubInstallationId <= 0) {
            return yield* Effect.fail(
              conflict('A GitHub integration is required to import this skill'),
            );
          }
        }
        return yield* Effect.tryPromise({
          try: () =>
            resolveSkillImport(
              reference,
              rawReference,
              githubInstallationId,
              dependencies.skillsSh,
            ),
          catch: (failure) => {
            if (failure instanceof SkillImportError) return badRequest(failure.message);
            const detail = failure instanceof Error ? failure.message : 'Skill import failed';
            return failure instanceof SkillsShApiError
              ? upstreamFailure(detail.slice(0, 500))
              : upstreamFailure(`Skill import failed: ${detail}`.slice(0, 500));
          },
        });
      });

    return {
      catalog: (query, sort) =>
        Effect.gen(function* () {
          if (!dependencies.skillsSh.configured()) return { configured: false, items: [] };
          const result = yield* Effect.either(
            Effect.tryPromise(() =>
              query.trim()
                ? dependencies.skillsSh.search(query.trim(), 30)
                : dependencies.skillsSh.leaderboard(sort),
            ),
          );
          if (result._tag === 'Left') {
            console.error('turbodiff: skills.sh catalog request failed', result.left);
            return { configured: true, items: [], error: 'skills.sh catalog request failed' };
          }
          return { configured: true, items: result.right };
        }),
      previewImport: (user, organizationId, reference) =>
        Effect.gen(function* () {
          yield* requireOrganization(user, organizationId);
          const resolved = yield* resolve(organizationId, reference);
          const existing = yield* dataEffect(() =>
            getSkillBySlug(organizationId, resolved.suggestedSlug),
          );
          return {
            name: resolved.name,
            suggestedSlug: resolved.suggestedSlug,
            slugTaken: existing !== null,
            description: resolved.description,
            instructions: resolved.instructions,
            files: resolved.files.map((file) => ({ path: file.path })),
            source: resolved.source,
            sourceRef: resolved.sourceRef,
            hash: resolved.hash,
            installs: resolved.installs,
            audit: resolved.audit,
          };
        }),
      import: (user, organizationId, reference, overrideSlug) =>
        Effect.gen(function* () {
          yield* requireOrganizationWrite(user, organizationId);
          const resolved = yield* resolve(organizationId, reference);
          const slug = overrideSlug?.trim().toLowerCase() || resolved.suggestedSlug;
          const validationError = validateSkillSlug(slug);
          if (validationError) return yield* Effect.fail(badRequest(validationError));
          if (yield* dataEffect(() => getSkillBySlug(organizationId, slug))) {
            return yield* Effect.fail(conflict(`Skill slug "${slug}" already exists`));
          }
          const created = yield* dataEffect(async () =>
            createSkill({
              organizationId,
              slug,
              name: resolved.name.trim(),
              content: resolved.instructions,
              contentHash: resolved.hash ?? (await contentHash(resolved.instructions)),
            }),
          );
          return serialize(created);
        }),
      list: (user) =>
        dataEffect(() => listSkills(user.organizationIds)).pipe(
          Effect.map((items) => ({ items: items.map(serialize) })),
        ),
      get: (user, id) => owned(user, id).pipe(Effect.map(serialize)),
      create: (user, input) =>
        Effect.gen(function* () {
          yield* requireOrganizationWrite(user, input.organizationId);
          const slug = input.slug.trim().toLowerCase();
          const name = input.name.trim();
          const content = input.content.trim();
          const validationError = validateSkillSlug(slug);
          if (validationError) return yield* Effect.fail(badRequest(validationError));
          if (!name || !content) {
            return yield* Effect.fail(badRequest('Skill name and content are required'));
          }
          if (yield* dataEffect(() => getSkillBySlug(input.organizationId, slug))) {
            return yield* Effect.fail(conflict(`Skill slug "${slug}" already exists`));
          }
          return serialize(
            yield* dataEffect(async () =>
              createSkill({
                organizationId: input.organizationId,
                slug,
                name,
                content,
                contentHash: await contentHash(content),
              }),
            ),
          );
        }),
      update: (user, id, input) =>
        Effect.gen(function* () {
          const row = yield* owned(user, id);
          yield* requireOrganizationWrite(user, row.organization_id);
          const name = input.name?.trim();
          const content = input.content?.trim();
          if (input.name !== undefined && !name) {
            return yield* Effect.fail(badRequest('Skill name is required'));
          }
          if (input.content !== undefined && !content) {
            return yield* Effect.fail(badRequest('Skill content is required'));
          }
          yield* dataEffect(async () =>
            updateSkill(id, {
              name,
              content,
              contentHash: content ? await contentHash(content) : undefined,
              enabled: input.enabled,
            }),
          );
          const updated = yield* dataEffect(() => getSkill(id));
          if (!updated) return yield* Effect.fail(notFound('Unknown skill'));
          return serialize(updated);
        }),
      remove: (user, id) =>
        Effect.gen(function* () {
          const row = yield* owned(user, id);
          yield* requireOrganizationWrite(user, row.organization_id);
          yield* dataEffect(() => deleteSkill(id));
        }),
    } satisfies SkillOperations;
  }),
);
