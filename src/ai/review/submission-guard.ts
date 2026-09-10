import {
  useAgentFinish,
  useDelivery,
  usePersistentState,
  type AgentAppendMessage,
} from '@flue/runtime';

// A model saying "I'm posting an approval" does not publish anything. Check
// the exact dispatch's durable row: even a non-throwing post_review can return
// posted:false. A completed but inconclusive review still settles normally;
// lifecycle coverage/verification gates retain authority over readiness.
export function useReviewSubmissionGuard(
  reviewId: number,
  readStatus: () => Promise<string | null>,
): void {
  const delivery = useDelivery();
  const [remindedReviewId, setRemindedReviewId] = usePersistentState<number | null>(
    'review-submission-reminder',
    null,
  );
  useAgentFinish(async ({ append }) => {
    const status = await readStatus();
    if (status === 'completed') return;
    if (status !== 'running') {
      throw new Error(`Review ${reviewId} is no longer active (${status ?? 'missing'}).`);
    }
    if (remindedReviewId === reviewId) {
      throw new Error(
        `Review ${reviewId} was not submitted: post_review did not complete the review after a corrective continuation.`,
      );
    }
    setRemindedReviewId(reviewId);
    const reminder: AgentAppendMessage = {
      kind: 'signal',
      // Appends become the render-time delivery. Keep the original dispatch
      // attributes, otherwise the next turn loses its model and review pin.
      type: delivery.kind === 'signal' ? delivery.type : 'review.submission_required',
      body:
        'This review is still unsubmitted. Your chat response does not post a GitHub or native review. ' +
        'Use the evidence already gathered and call post_review now with your candidate findings and fileEvidence, ' +
        'including an empty findings array when there are no supported findings. ' +
        'If a tool failed, address its error; do not claim success without completing post_review. ' +
        'Do not restart the review or repeat successful repository checks.',
    };
    if (delivery.kind === 'signal') {
      reminder.attributes = delivery.attributes;
      reminder.tagName = delivery.tagName;
    }
    append(reminder);
  });
}
