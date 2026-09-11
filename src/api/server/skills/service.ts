import { Context, Effect, Layer } from 'effect';
import {
  createSkill,
  deleteSkill,
  getSkillById,
  getSkillBySlug,
  listSkills,
  updateSkill,
  type SkillRow,
} from '../../../data/db.ts';
import { parseSkillReference } from '../../../domain/skill-import.ts';
import { validateSkillDefinition, validateSkillSlug } from '../../../domain/skill-definition.ts';
import { SkillsShApiError } from '../../../integrations/skills-sh/client.ts';
import { resolveSkillImport, SkillImportError } from '../../../integrations/skills/import.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type {
  CreateSkill,
  Skill,
  SkillCatalog,
  SkillCollection,
  SkillImportPreview,
  UpdateSkill,
} from '../../contract/skills.ts';
import {
  badRequest,
  forbidden,
  internalServerError,
  notFound,
  upstreamFailure,
  type DomainError,
} from '../../contract/errors.ts';
import { capableInstallationIds } from '../authorization.ts';
import { ApiDependencies } from '../context.ts';

export interface SkillOperations {
  readonly catalog: (
    query: string,
    sort: 'all-time' | 'trending' | 'hot',
  ) => Effect.Effect<typeof SkillCatalog.Type, DomainError>;
  readonly previewImport: (
    user: CurrentUserIdentity,
    reference: string,
  ) => Effect.Effect<typeof SkillImportPreview.Type, DomainError>;
  readonly import: (
    user: CurrentUserIdentity,
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

const dataEffect = <A>(operation: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: operation,
    catch: (error) => {
      console.error('turbodiff: Effect skill operation failed', error);
      return internalServerError();
    },
  });

const serialize = (skill: SkillRow): Skill => ({
  id: skill.id,
  installationId: skill.installation_id,
  slug: skill.slug,
  name: skill.name,
  description: skill.description,
  instructions: skill.instructions,
  source: skill.source,
  sourceRef: skill.source_ref,
  sourceHash: skill.source_hash,
  importedAt: skill.imported_at,
  files: skill.files.map((file) => ({ path: file.path })),
});

export const SkillServiceLive = Layer.effect(
  SkillService,
  Effect.gen(function* () {
    const dependencies = yield* ApiDependencies;

    const owned = (user: CurrentUserIdentity, id: number) =>
      dataEffect(() => getSkillById(id)).pipe(
        Effect.flatMap((skill) =>
          skill && user.installationIds.includes(skill.installation_id)
            ? Effect.succeed(skill)
            : Effect.fail(notFound('Unknown skill')),
        ),
      );

    const capable = (user: CurrentUserIdentity) =>
      capableInstallationIds(user, dependencies).pipe(
        Effect.flatMap((ids) =>
          ids.length > 0
            ? Effect.succeed(ids)
            : Effect.fail(forbidden("'settings' capability required for this action")),
        ),
      );

    const validate = (input: CreateSkill) => {
      const values = {
        slug: input.slug.trim().toLowerCase(),
        name: input.name.trim(),
        description: input.description.trim(),
        instructions: input.instructions.trim(),
      };
      return {
        values,
        error: validateSkillSlug(values.slug) ?? validateSkillDefinition(values),
      };
    };

    const resolve = (user: CurrentUserIdentity, rawReference: string) => {
      const reference = parseSkillReference(rawReference);
      if (!reference || user.installationIds[0] === undefined) {
        return Effect.fail(
          badRequest('Use owner/repo/skill, a skills.sh URL, or a GitHub folder URL'),
        );
      }
      return Effect.tryPromise({
        try: () =>
          resolveSkillImport(
            reference,
            rawReference,
            user.installationIds[0]!,
            dependencies.skillsSh,
          ),
        catch: (error) => {
          if (error instanceof SkillImportError) return badRequest(error.message);
          const detail = error instanceof Error ? error.message : 'Skill source request failed';
          if (error instanceof SkillsShApiError) return upstreamFailure(detail.slice(0, 500));
          return upstreamFailure(`Skill source request failed: ${detail}`.slice(0, 500));
        },
      });
    };

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
      previewImport: (user, reference) =>
        Effect.gen(function* () {
          const resolved = yield* resolve(user, reference);
          const existing = yield* dataEffect(() =>
            Promise.all(
              user.installationIds.map((id) => getSkillBySlug(id, resolved.suggestedSlug)),
            ),
          );
          return {
            name: resolved.name,
            suggestedSlug: resolved.suggestedSlug,
            slugTaken: existing.some(Boolean),
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
      import: (user, reference, override) =>
        Effect.gen(function* () {
          const capableIds = yield* capable(user);
          const resolved = yield* resolve(user, reference);
          const slug = override?.trim().toLowerCase() || resolved.suggestedSlug;
          const slugError = validateSkillSlug(slug);
          if (slugError) return yield* Effect.fail(badRequest(slugError));
          const existing = yield* dataEffect(() =>
            Promise.all(user.installationIds.map((id) => getSkillBySlug(id, slug))),
          );
          if (existing.some(Boolean)) {
            return yield* Effect.fail(badRequest(`A skill with slug "${slug}" already exists`));
          }
          yield* dataEffect(() =>
            Promise.all(
              capableIds.map((id) =>
                createSkill(id, {
                  slug,
                  name: resolved.name,
                  description: resolved.description ?? '',
                  instructions: resolved.instructions,
                  files: resolved.files,
                  source: resolved.source,
                  source_ref: resolved.sourceRef,
                  source_hash: resolved.hash,
                  imported_at: true,
                }),
              ),
            ).then(() => undefined),
          );
          const created = yield* dataEffect(() => getSkillBySlug(capableIds[0]!, slug));
          if (!created) return yield* Effect.fail(internalServerError());
          return serialize(created);
        }),
      list: (user) =>
        Effect.gen(function* () {
          const skills = yield* dataEffect(() => listSkills(user.installationIds));
          const capableIds = new Set(yield* capableInstallationIds(user, dependencies));
          const bySlug = new Map<string, SkillRow>();
          for (const skill of skills) {
            const previous = bySlug.get(skill.slug);
            if (
              !previous ||
              (!capableIds.has(previous.installation_id) && capableIds.has(skill.installation_id))
            ) {
              bySlug.set(skill.slug, skill);
            }
          }
          return { items: [...bySlug.values()].map(serialize) };
        }),
      get: (user, id) => owned(user, id).pipe(Effect.map(serialize)),
      create: (user, input) =>
        Effect.gen(function* () {
          const capableIds = yield* capable(user);
          const { values, error } = validate(input);
          if (error) return yield* Effect.fail(badRequest(error));
          const existing = yield* dataEffect(() =>
            Promise.all(user.installationIds.map((id) => getSkillBySlug(id, values.slug))),
          );
          if (existing.some(Boolean)) {
            return yield* Effect.fail(
              badRequest(`A skill with slug "${values.slug}" already exists`),
            );
          }
          yield* dataEffect(() =>
            Promise.all(capableIds.map((id) => createSkill(id, values))).then(() => undefined),
          );
          const created = yield* dataEffect(() => getSkillBySlug(capableIds[0]!, values.slug));
          if (!created) return yield* Effect.fail(internalServerError());
          return serialize(created);
        }),
      update: (user, id, input) =>
        Effect.gen(function* () {
          const skill = yield* owned(user, id);
          const capableIds = yield* capable(user);
          const values = {
            slug: skill.slug,
            name: input.name.trim(),
            description: input.description.trim(),
            instructions: input.instructions.trim(),
          };
          const error = validateSkillDefinition(values);
          if (error) return yield* Effect.fail(badRequest(error));
          const siblings = (yield* dataEffect(() => listSkills(capableIds))).filter(
            (candidate) => candidate.slug === skill.slug,
          );
          yield* dataEffect(async () => {
            await Promise.all(siblings.map((candidate) => updateSkill(candidate.id, values)));
            const covered = new Set(siblings.map((candidate) => candidate.installation_id));
            await Promise.all(
              capableIds
                .filter((installationId) => !covered.has(installationId))
                .map((installationId) =>
                  createSkill(installationId, {
                    ...values,
                    files: skill.files,
                    source: skill.source,
                    source_ref: skill.source_ref,
                    source_hash: skill.source_hash,
                    imported_at: skill.imported_at !== null,
                  }),
                ),
            );
          });
          const updated = yield* dataEffect(() => getSkillBySlug(capableIds[0]!, skill.slug));
          if (!updated) return yield* Effect.fail(internalServerError());
          return serialize(updated);
        }),
      remove: (user, id) =>
        Effect.gen(function* () {
          const skill = yield* owned(user, id);
          const capableIds = yield* capable(user);
          const siblings = (yield* dataEffect(() => listSkills(capableIds))).filter(
            (candidate) => candidate.slug === skill.slug,
          );
          yield* dataEffect(() =>
            Promise.all(siblings.map((candidate) => deleteSkill(candidate.id))).then(
              () => undefined,
            ),
          );
        }),
    } satisfies SkillOperations;
  }),
);
