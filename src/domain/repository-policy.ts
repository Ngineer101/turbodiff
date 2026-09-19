import { isJsonObject, isString, type JsonValue } from '../shared/json.ts';

export const PROCESS_PROFILES = [
  'review_on_demand',
  'automatic_review',
  'idea_to_pr',
  'assisted_delivery',
  'full_delivery',
] as const;
export type ProcessProfile = (typeof PROCESS_PROFILES)[number];

export function repositoryPolicy(value: JsonValue) {
  const settings = isJsonObject(value) ? value : {};
  const processProfile =
    PROCESS_PROFILES.find((profile) => profile === settings.processProfile) ?? 'automatic_review';
  return {
    processProfile,
    reviewOnPush: settings.reviewOnPush === true,
    blockingReviews: settings.blockingReviews !== false,
    checkCommand:
      isString(settings.checkCommand) && settings.checkCommand.trim()
        ? settings.checkCommand.trim()
        : null,
    repair: processProfile === 'assisted_delivery' || processProfile === 'full_delivery',
    verify: processProfile === 'assisted_delivery' || processProfile === 'full_delivery',
    merge: processProfile === 'full_delivery',
    review: processProfile !== 'review_on_demand' && processProfile !== 'idea_to_pr',
  };
}
