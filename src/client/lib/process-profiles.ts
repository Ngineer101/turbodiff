import type { ApiProcessProfile } from '../../shared/api-types.ts';

// The process-profile ladder as the UI presents it: a single choice per repo,
// in escalating order of autonomy, with a one-line description. `artifactsOnly`
// gates native_turnkey to Artifacts (turbodiff-hosted) repos. Shared by the
// settings repo config and the new-project form.
export const PROCESS_PROFILES: {
  value: ApiProcessProfile;
  label: string;
  description: string;
  artifactsOnly?: boolean;
}[] = [
  {
    value: 'legacy_factory',
    label: 'Legacy factory',
    description: 'Preserve the existing end-to-end factory behavior for factory-created changes.',
  },
  {
    value: 'review_on_demand',
    label: 'Review on demand',
    description: 'Review any open change only when a person explicitly requests it.',
  },
  {
    value: 'automatic_review',
    label: 'Automatic review',
    description: 'Automatically review qualifying human, automation, and factory changes.',
  },
  {
    value: 'review_and_repair',
    label: 'Review + repair',
    description:
      'Automatically review writable changes, repair blocking findings, and re-review until clean or handed off.',
  },
  {
    value: 'idea_to_pr',
    label: 'Idea to PR',
    description:
      'Turn approved feature specifications into changes, then hand off at the pull request.',
  },
  {
    value: 'assisted_delivery',
    label: 'Assisted delivery',
    description: 'Implement, publish, review, repair, and verify; leave merge to the team.',
  },
  {
    value: 'full_delivery',
    label: 'Full delivery',
    description: 'Run the full lifecycle through merge when every gate passes.',
  },
  {
    value: 'native_turnkey',
    label: 'Native turnkey',
    description: 'Run full delivery using native Artifacts change requests.',
    artifactsOnly: true,
  },
];
