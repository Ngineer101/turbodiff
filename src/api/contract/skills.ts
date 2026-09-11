import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());
const skillId = HttpApiSchema.param(
  'skillId',
  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
);

export const Skill = Schema.Struct({
  id: PositiveInt,
  installationId: PositiveInt,
  slug: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  instructions: Schema.String,
  source: Schema.NullOr(Schema.String),
  sourceRef: Schema.NullOr(Schema.String),
  sourceHash: Schema.NullOr(Schema.String),
  importedAt: Schema.NullOr(Schema.String),
  files: Schema.Array(Schema.Struct({ path: Schema.String })),
});
export type Skill = typeof Skill.Type;

export const SkillCollection = Schema.Struct({ items: Schema.Array(Skill) });
export type SkillCollection = typeof SkillCollection.Type;

export const CreateSkill = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
});
export type CreateSkill = typeof CreateSkill.Type;

export const UpdateSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
});
export type UpdateSkill = typeof UpdateSkill.Type;

const CatalogSkill = Schema.Struct({
  source: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  installs: Schema.NullOr(Schema.Number),
});
export const SkillCatalogQuery = Schema.Struct({
  q: Schema.optional(Schema.String),
  sort: Schema.optional(Schema.Literal('all-time', 'trending', 'hot')),
});
export const SkillCatalog = Schema.Struct({
  configured: Schema.Boolean,
  items: Schema.Array(CatalogSkill),
  error: Schema.optional(Schema.String),
});
export const SkillImportRequest = Schema.Struct({
  reference: Schema.String,
  slug: Schema.optional(Schema.String),
});
export const SkillImportPreview = Schema.Struct({
  name: Schema.String,
  suggestedSlug: Schema.String,
  slugTaken: Schema.Boolean,
  description: Schema.NullOr(Schema.String),
  instructions: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String })),
  source: Schema.Literal('skills.sh', 'github'),
  sourceRef: Schema.String,
  hash: Schema.NullOr(Schema.String),
  installs: Schema.NullOr(Schema.Number),
  audit: Schema.NullOr(
    Schema.Array(Schema.Struct({ auditor: Schema.String, verdict: Schema.String })),
  ),
});

export const SkillsApi = HttpApiGroup.make('skills')
  .add(
    HttpApiEndpoint.get('getSkillCatalog', '/skills/catalog')
      .setUrlParams(SkillCatalogQuery)
      .addSuccess(SkillCatalog)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('previewSkillImport', '/skill-import-previews')
      .setPayload(SkillImportRequest)
      .addSuccess(SkillImportPreview, { status: 201 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('importSkill', '/skill-imports')
      .setPayload(SkillImportRequest)
      .addSuccess(Skill, { status: 201 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('listSkills', '/skills').addSuccess(SkillCollection).addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('createSkill', '/skills')
      .setPayload(CreateSkill)
      .addSuccess(Skill, { status: 201 })
      .addError(DomainError),
  )
  .add(HttpApiEndpoint.get('getSkill')`/skills/${skillId}`.addSuccess(Skill).addError(DomainError))
  .add(
    HttpApiEndpoint.patch('updateSkill')`/skills/${skillId}`
      .setPayload(UpdateSkill)
      .addSuccess(Skill)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.del('deleteSkill')`/skills/${skillId}`
      .addSuccess(HttpApiSchema.NoContent, { status: 204 })
      .addError(DomainError),
  );
