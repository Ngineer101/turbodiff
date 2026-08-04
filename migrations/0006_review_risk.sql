-- Risk-tiered dispatch (trivial/lite/full — see src/lib/risk.ts) and
-- findings-per-review tracking. Both NULL on rows predating the feature and
-- on mention/manual dispatches, which bypass tiering.
ALTER TABLE reviews ADD COLUMN risk_tier TEXT;
ALTER TABLE reviews ADD COLUMN findings_count INTEGER;
