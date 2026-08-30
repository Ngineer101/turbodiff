import { describe, expect, it } from 'vite-plus/test';
import {
  LIFECYCLE_STAGES,
  PROCESS_PROFILE_KEYS,
  type LifecycleScenario,
} from './lifecycle-contract.ts';
import { decideLifecycle } from './lifecycle-coordinator.ts';

// Executable acceptance inventory for docs/software-factory-lifecycle.md.
// These fixtures are deliberately data, not mocks of the current pipeline.
// Each implementation slice feeds the applicable rows through the lifecycle
// policy. Until then this test keeps the contract complete, internally
// consistent, and safe to merge without a permanently failing CI suite.
export const LIFECYCLE_SCENARIOS: LifecycleScenario[] = [
  {
    id: 'REV-001',
    description: 'a human GitHub PR can receive an explicitly requested review',
    profile: 'review_on_demand',
    given: {
      event: 'human.resume_requested',
      origin: 'human',
      startStage: 'review',
      stopAfterStage: 'review',
      capabilities: ['read_change', 'publish_review'],
    },
    expected: { kind: 'schedule', stage: 'review' },
  },
  {
    id: 'REV-002',
    description: 'opening a PR does not spend review budget in on-demand mode',
    profile: 'review_on_demand',
    given: {
      event: 'change.opened',
      origin: 'human',
      startStage: 'review',
      stopAfterStage: 'review',
      capabilities: ['read_change', 'publish_review'],
    },
    expected: { kind: 'ignore', reason: 'review requires an explicit request' },
  },
  {
    id: 'REV-003',
    description: 'automatic review admits a qualifying human PR',
    profile: 'automatic_review',
    given: {
      event: 'change.opened',
      origin: 'human',
      startStage: 'review',
      stopAfterStage: 'review',
      capabilities: ['read_change', 'publish_review'],
      facts: { draft: false, intakeMatches: true },
    },
    expected: { kind: 'schedule', stage: 'review' },
  },
  {
    id: 'REV-004',
    description: 'draft PRs wait for ready-for-review in automatic mode',
    profile: 'automatic_review',
    given: {
      event: 'change.opened',
      origin: 'human',
      startStage: 'review',
      stopAfterStage: 'review',
      capabilities: ['read_change', 'publish_review'],
      facts: { draft: true, intakeMatches: true },
    },
    expected: { kind: 'ignore', reason: 'change is draft' },
  },
  {
    id: 'REV-005',
    description: 'a pushed head can re-review under automatic review policy',
    profile: 'automatic_review',
    given: {
      event: 'change.updated',
      origin: 'human',
      startStage: 'review',
      stopAfterStage: 'review',
      completedStages: ['review'],
      capabilities: ['read_change', 'publish_review'],
      facts: { headChanged: true, debounceActive: false },
    },
    expected: { kind: 'schedule', stage: 'review' },
  },
  {
    id: 'RUN-001',
    description: 'a new idea starts with planning',
    profile: 'idea_to_pr',
    given: {
      event: 'work.requested',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'publish',
    },
    expected: { kind: 'schedule', stage: 'plan' },
  },
  {
    id: 'RUN-002',
    description: 'a ready plan waits for required human approval',
    profile: 'idea_to_pr',
    given: {
      event: 'plan.ready',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'publish',
      completedStages: ['plan'],
    },
    expected: { kind: 'wait', reason: 'plan approval required' },
  },
  {
    id: 'RUN-003',
    description: 'approving a plan schedules implementation',
    profile: 'idea_to_pr',
    given: {
      event: 'human.approved',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'publish',
      completedStages: ['plan'],
    },
    expected: { kind: 'schedule', stage: 'implement' },
  },
  {
    id: 'RUN-004',
    description: 'duplicate stage completion cannot schedule duplicate work',
    profile: 'full_delivery',
    given: {
      event: 'stage.completed',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'merge',
      completedStages: ['plan', 'implement'],
      facts: { eventAlreadyProcessed: true },
    },
    expected: { kind: 'ignore', reason: 'event already processed' },
  },
  {
    id: 'RUN-005',
    description: 'terminal runs ignore later provider events',
    profile: 'full_delivery',
    given: {
      event: 'change.updated',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'merge',
      completedStages: ['plan', 'implement', 'publish', 'review', 'verify', 'merge'],
      facts: { runStatus: 'completed' },
    },
    expected: { kind: 'ignore', reason: 'run is terminal' },
  },
  {
    id: 'RUN-006',
    description: 'a live repository kill switch prevents new stage claims',
    profile: 'full_delivery',
    given: {
      event: 'stage.completed',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'merge',
      completedStages: ['plan'],
      facts: { repositoryEnabled: false },
    },
    expected: { kind: 'handoff', reason: 'repository automation disabled' },
  },
  {
    id: 'HND-001',
    description: 'idea-to-PR stops successfully after publishing the change',
    profile: 'idea_to_pr',
    given: {
      event: 'stage.completed',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'publish',
      completedStages: ['plan', 'implement', 'publish'],
    },
    expected: { kind: 'handoff', reason: 'requested stop boundary reached' },
  },
  {
    id: 'HND-002',
    description: 'a handed-off PR does not auto-review on its opened event',
    profile: 'idea_to_pr',
    given: {
      event: 'change.opened',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'publish',
      completedStages: ['plan', 'implement', 'publish'],
    },
    expected: { kind: 'ignore', reason: 'run responsibility ended at publish' },
  },
  {
    id: 'HND-003',
    description: 'a user can resume a handed-off change at review',
    profile: 'review_on_demand',
    given: {
      event: 'human.resume_requested',
      origin: 'factory',
      startStage: 'review',
      stopAfterStage: 'review',
      capabilities: ['read_change', 'publish_review'],
      facts: { previousRunStatus: 'handed_off' },
    },
    expected: { kind: 'schedule', stage: 'review' },
  },
  {
    id: 'HND-004',
    description: 'an explicit handoff request stops before another stage',
    profile: 'full_delivery',
    given: {
      event: 'human.handoff_requested',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'merge',
      completedStages: ['plan', 'implement', 'publish'],
    },
    expected: { kind: 'handoff', reason: 'handoff requested by user' },
  },
  {
    id: 'CAP-001',
    description: 'a readable fork PR remains reviewable without head-write access',
    profile: 'review_on_demand',
    given: {
      event: 'human.resume_requested',
      origin: 'human',
      startStage: 'review',
      stopAfterStage: 'review',
      capabilities: ['read_change', 'publish_review'],
      facts: { fork: true },
    },
    expected: { kind: 'schedule', stage: 'review' },
  },
  {
    id: 'CAP-002',
    description: 'repair hands off when the provider cannot write the head',
    profile: 'review_and_repair',
    given: {
      event: 'stage.completed',
      origin: 'human',
      startStage: 'review',
      stopAfterStage: 'repair',
      completedStages: ['review'],
      capabilities: ['read_change', 'publish_review'],
      facts: { blockingFindings: true },
    },
    expected: { kind: 'handoff', reason: 'change head is not writable' },
  },
  {
    id: 'CAP-003',
    description: 'missing review publication capability prevents paid review dispatch',
    profile: 'review_on_demand',
    given: {
      event: 'human.resume_requested',
      origin: 'human',
      startStage: 'review',
      stopAfterStage: 'review',
      capabilities: ['read_change'],
    },
    expected: { kind: 'handoff', reason: 'provider cannot publish a review' },
  },
  {
    id: 'CAP-004',
    description: 'merge is never scheduled without live merge authority',
    profile: 'full_delivery',
    given: {
      event: 'external.checks_updated',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'merge',
      completedStages: ['plan', 'implement', 'publish', 'review', 'verify'],
      capabilities: ['read_change', 'publish_review', 'write_head'],
      facts: { allGatesGreen: true },
    },
    expected: { kind: 'handoff', reason: 'merge authority unavailable' },
  },
  {
    id: 'VER-001',
    description: 'an existing PR with a contract can start directly at verification',
    profile: 'assisted_delivery',
    given: {
      event: 'human.resume_requested',
      origin: 'human',
      startStage: 'verify',
      stopAfterStage: 'verify',
      capabilities: ['read_change', 'publish_check'],
      facts: { acceptanceContractPresent: true },
    },
    expected: { kind: 'schedule', stage: 'verify' },
  },
  {
    id: 'VER-002',
    description: 'verification waits when no acceptance contract exists',
    profile: 'assisted_delivery',
    given: {
      event: 'human.resume_requested',
      origin: 'human',
      startStage: 'verify',
      stopAfterStage: 'verify',
      capabilities: ['read_change', 'publish_check'],
      facts: { acceptanceContractPresent: false },
    },
    expected: { kind: 'wait', reason: 'acceptance contract required' },
  },
  {
    id: 'VER-003',
    description: 'failed verification repairs only when policy and write capability allow it',
    profile: 'full_delivery',
    given: {
      event: 'stage.completed',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'merge',
      completedStages: ['plan', 'implement', 'publish', 'review', 'verify'],
      capabilities: ['read_change', 'publish_review', 'publish_check', 'write_head', 'merge'],
      facts: { verificationPassed: false, repairAttemptsRemaining: true },
    },
    expected: { kind: 'schedule', stage: 'repair' },
  },
  {
    id: 'VER-004',
    description: 'a human-directed criteria conflict waits for a decision',
    profile: 'full_delivery',
    given: {
      event: 'stage.completed',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'merge',
      completedStages: ['plan', 'implement', 'publish', 'review', 'repair', 'verify'],
      capabilities: ['read_change', 'publish_review', 'publish_check', 'write_head', 'merge'],
      facts: { criteriaConflict: true, latestRepairWasHumanDirected: true },
    },
    expected: { kind: 'wait', reason: 'acceptance criteria conflict requires a human decision' },
  },
  {
    id: 'MRG-001',
    description: 'automatic merge runs when every internal and external gate is green',
    profile: 'full_delivery',
    given: {
      event: 'external.checks_updated',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'merge',
      completedStages: ['plan', 'implement', 'publish', 'review', 'verify'],
      capabilities: ['read_change', 'publish_review', 'publish_check', 'write_head', 'merge'],
      facts: {
        reviewPassed: true,
        verificationPassed: true,
        externalChecksGreen: true,
        requiredApprovalsPresent: true,
        conflict: false,
      },
    },
    expected: { kind: 'schedule', stage: 'merge' },
  },
  {
    id: 'MRG-002',
    description: 'unknown external checks decline automatic merge',
    profile: 'full_delivery',
    given: {
      event: 'stage.completed',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'merge',
      completedStages: ['plan', 'implement', 'publish', 'review', 'verify'],
      capabilities: ['read_change', 'publish_review', 'publish_check', 'write_head', 'merge'],
      facts: { externalChecksGreen: false, externalChecksPending: true },
    },
    expected: { kind: 'wait', reason: 'external checks are not green' },
  },
  {
    id: 'MRG-003',
    description: 'a merge conflict prevents automatic merge',
    profile: 'full_delivery',
    given: {
      event: 'external.checks_updated',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'merge',
      completedStages: ['plan', 'implement', 'publish', 'review', 'verify'],
      capabilities: ['read_change', 'publish_review', 'publish_check', 'write_head', 'merge'],
      facts: { allGatesGreen: true, conflict: true },
    },
    expected: { kind: 'wait', reason: 'change has a merge conflict' },
  },
  {
    id: 'MRG-004',
    description: 'provider merge queue is selected when direct merge is unavailable',
    profile: 'full_delivery',
    given: {
      event: 'external.checks_updated',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'merge',
      completedStages: ['plan', 'implement', 'publish', 'review', 'verify'],
      capabilities: ['read_change', 'publish_review', 'publish_check', 'write_head', 'merge_queue'],
      facts: { allGatesGreen: true, mergeQueueRequired: true },
    },
    expected: { kind: 'schedule', stage: 'merge' },
  },
  {
    id: 'CMP-001',
    description: 'existing repositories retain factory-only intake after migration',
    profile: 'legacy_factory',
    given: {
      event: 'change.opened',
      origin: 'human',
      startStage: 'review',
      stopAfterStage: 'merge',
      capabilities: ['read_change', 'publish_review', 'write_head', 'merge'],
    },
    expected: { kind: 'ignore', reason: 'legacy profile admits factory changes only' },
  },
  {
    id: 'CMP-002',
    description: 'legacy factory-generated changes retain current automatic review behavior',
    profile: 'legacy_factory',
    given: {
      event: 'change.opened',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'merge',
      completedStages: ['plan', 'implement', 'publish'],
      capabilities: ['read_change', 'publish_review', 'write_head', 'merge'],
    },
    expected: { kind: 'schedule', stage: 'review' },
  },
  {
    id: 'CMP-003',
    description: 'automation output enters the same change lifecycle',
    profile: 'automatic_review',
    given: {
      event: 'change.opened',
      origin: 'automation',
      startStage: 'review',
      stopAfterStage: 'review',
      capabilities: ['read_change', 'publish_review', 'write_head'],
      facts: { intakeMatches: true },
    },
    expected: { kind: 'schedule', stage: 'review' },
  },
  {
    id: 'CMP-004',
    description: 'native turnkey delivery uses the same lifecycle contract as hosted changes',
    profile: 'native_turnkey',
    given: {
      event: 'work.requested',
      origin: 'factory',
      startStage: 'plan',
      stopAfterStage: 'merge',
      capabilities: ['read_change', 'publish_review', 'write_head', 'publish_check', 'merge'],
    },
    expected: { kind: 'schedule', stage: 'plan' },
  },
];

describe('composable lifecycle acceptance contract', () => {
  it('produces the specified decision for every acceptance scenario', () => {
    for (const scenario of LIFECYCLE_SCENARIOS) {
      expect(decideLifecycle(scenario.profile, scenario.given), scenario.id).toEqual(
        scenario.expected,
      );
    }
  });
  it('uses stable, unique scenario ids', () => {
    const ids = LIFECYCLE_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^(REV|RUN|HND|CAP|VER|MRG|CMP)-\d{3}$/);
  });

  it('covers every built-in process profile', () => {
    const covered = new Set(LIFECYCLE_SCENARIOS.map((scenario) => scenario.profile));
    for (const profile of PROCESS_PROFILE_KEYS) expect(covered.has(profile)).toBe(true);
  });

  it('uses only ordered lifecycle boundaries', () => {
    for (const scenario of LIFECYCLE_SCENARIOS) {
      expect(LIFECYCLE_STAGES.indexOf(scenario.given.startStage)).toBeLessThanOrEqual(
        LIFECYCLE_STAGES.indexOf(scenario.given.stopAfterStage),
      );
    }
  });

  it('keeps decision payloads structurally unambiguous', () => {
    for (const { expected } of LIFECYCLE_SCENARIOS) {
      if (expected.kind === 'schedule') {
        expect(LIFECYCLE_STAGES).toContain(expected.stage);
        expect('reason' in expected).toBe(false);
      } else if (expected.kind === 'complete') {
        expect(Object.keys(expected)).toEqual(['kind']);
      } else {
        expect(expected.reason.trim()).not.toBe('');
      }
    }
  });

  it('never schedules repair without a writable change head', () => {
    const repairs = LIFECYCLE_SCENARIOS.filter(
      (scenario) => scenario.expected.kind === 'schedule' && scenario.expected.stage === 'repair',
    );
    expect(repairs.length).toBeGreaterThan(0);
    for (const scenario of repairs) {
      expect(scenario.given.capabilities).toContain('write_head');
    }
  });

  it('never schedules merge without direct-merge or merge-queue capability', () => {
    const merges = LIFECYCLE_SCENARIOS.filter(
      (scenario) => scenario.expected.kind === 'schedule' && scenario.expected.stage === 'merge',
    );
    expect(merges.length).toBeGreaterThan(0);
    for (const scenario of merges) {
      const capabilities = scenario.given.capabilities ?? [];
      expect(capabilities.includes('merge') || capabilities.includes('merge_queue')).toBe(true);
    }
  });

  it('makes every declared stop boundary observable in the inventory', () => {
    const boundaries = new Set(
      LIFECYCLE_SCENARIOS.map((scenario) => scenario.given.stopAfterStage),
    );
    const requiredBoundaries = ['review', 'repair', 'verify', 'publish', 'merge'] satisfies Array<
      (typeof LIFECYCLE_STAGES)[number]
    >;
    for (const required of requiredBoundaries) {
      expect(boundaries.has(required)).toBe(true);
    }
  });
});
