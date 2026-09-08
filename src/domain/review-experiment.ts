export interface WeightedReviewModel {
  model: string;
  weight: number;
}

export interface ReviewModelAssignment {
  model: string;
  experimental: boolean;
}

function stableBucket(key: string, total: number): number {
  let hash = 2_166_136_261;
  for (const char of key) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % total;
}

export function weightedReviewModel(
  key: string,
  role: 'scout' | 'verifier',
  candidates: WeightedReviewModel[],
  fallback: string,
): ReviewModelAssignment {
  const enabled = candidates.filter((candidate) => candidate.weight > 0);
  const total = enabled.reduce((sum, candidate) => sum + candidate.weight, 0);
  if (total === 0) return { model: fallback, experimental: false };
  let bucket = stableBucket(`${role}:${key}`, total);
  for (const candidate of enabled) {
    if (bucket < candidate.weight) return { model: candidate.model, experimental: true };
    bucket -= candidate.weight;
  }
  return { model: fallback, experimental: false };
}
