import { HttpApiBuilder } from '@effect/platform';
import { Effect } from 'effect';
import { AppApi } from '../../contract/api.ts';
import { CurrentUser } from '../../contract/auth.ts';
import { SkillService } from './service.ts';

export const SkillsHandlers = HttpApiBuilder.group(
  AppApi,
  'skills',
  Effect.fn(function* (handlers) {
    const service = yield* SkillService;
    return handlers
      .handle('getSkillCatalog', ({ urlParams }) =>
        service.catalog(urlParams.q ?? '', urlParams.sort ?? 'trending'),
      )
      .handle('previewSkillImport', ({ payload }) =>
        Effect.flatMap(CurrentUser, (user) => service.previewImport(user, payload.reference)),
      )
      .handle('importSkill', ({ payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.import(user, payload.reference, payload.slug),
        ),
      )
      .handle('listSkills', () => Effect.flatMap(CurrentUser, service.list))
      .handle('getSkill', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.get(user, path.skillId)),
      )
      .handle('createSkill', ({ payload }) =>
        Effect.flatMap(CurrentUser, (user) => service.create(user, payload)),
      )
      .handle('updateSkill', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) => service.update(user, path.skillId, payload)),
      )
      .handle('deleteSkill', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.remove(user, path.skillId)),
      );
  }),
);
