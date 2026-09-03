export type SupplementalSourceVerification = {
  sourceRoot: string;
  sourceCommit: string;
  supplementalCommits: readonly string[];
};

export function verifySupplementalSource(
  verification: SupplementalSourceVerification,
): void;
