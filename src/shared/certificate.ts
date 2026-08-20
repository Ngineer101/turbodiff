export interface CertificateCriterion {
  text: string;
  verdict: 'pass' | 'fail' | 'skip' | null;
}

export interface CertificateShot {
  url: string;
  label: string;
}

export interface CertificateData {
  serial: string;
  featureTitle: string;
  repoFullName: string;
  prNumber: number;
  prUrl: string;
  authorLogin: string | null;
  verifiedAt: string | null;
  criteria: CertificateCriterion[];
  screenshots: CertificateShot[];
  screenshotCount: number;
  agentMinutes: number | null;
  fixIterations: number;
  agentRuns: number;
  verified: boolean;
  pageUrl: string;
}
