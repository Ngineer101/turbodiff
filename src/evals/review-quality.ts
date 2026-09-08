export interface ReviewEvalFinding {
  id: string;
  severity: 'P1' | 'P2';
}

export interface ReviewEvalCase {
  id: string;
  changedLines: number;
  expected: ReviewEvalFinding[];
  actual: ReviewEvalFinding[];
}

export interface ReviewEvalScore {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  p1Precision: number;
  commentsPerKloc: number;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

export function scoreReviewEval(cases: ReviewEvalCase[]): ReviewEvalScore {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let p1TruePositives = 0;
  let p1FalsePositives = 0;
  let changedLines = 0;
  let comments = 0;

  for (const entry of cases) {
    changedLines += entry.changedLines;
    comments += entry.actual.length;
    const expected = new Map(entry.expected.map((finding) => [finding.id, finding]));
    const actual = new Map(entry.actual.map((finding) => [finding.id, finding]));
    for (const finding of actual.values()) {
      if (expected.has(finding.id)) {
        truePositives++;
        if (finding.severity === 'P1') p1TruePositives++;
      } else {
        falsePositives++;
        if (finding.severity === 'P1') p1FalsePositives++;
      }
    }
    for (const finding of expected.values()) {
      if (!actual.has(finding.id)) falseNegatives++;
    }
  }

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision: ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, truePositives + falseNegatives),
    p1Precision: ratio(p1TruePositives, p1TruePositives + p1FalsePositives),
    commentsPerKloc: changedLines === 0 ? 0 : comments / (changedLines / 1_000),
  };
}

export function reviewEvalPasses(score: ReviewEvalScore): boolean {
  return score.precision >= 0.9 && score.recall >= 0.8 && score.p1Precision >= 0.95;
}
