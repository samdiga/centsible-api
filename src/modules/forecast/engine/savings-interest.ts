/** APY describes annual yield, not a card APR. Money arithmetic stays in bigint subcents. */
export const INTEREST_SCALE = 1_000_000_000_000n;
export function dailyYieldScaled(apy: number, date: string): bigint {
  if (!Number.isFinite(apy) || apy <= 0 || apy > 100) return 0n;
  const year = Number(date.slice(0, 4));
  const days =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 366 : 365;
  return BigInt(
    Math.round(
      Math.expm1(Math.log1p(apy / 100) / days) * Number(INTEREST_SCALE),
    ),
  );
}
export function accrueInterest(
  balanceCents: bigint,
  accruedScaledCents: bigint,
  apy: number,
  date: string,
): bigint {
  const principal = balanceCents > 0n ? balanceCents : 0n;
  return (
    accruedScaledCents +
    ((principal * INTEREST_SCALE + accruedScaledCents) *
      dailyYieldScaled(apy, date)) /
      INTEREST_SCALE
  );
}
export type SavingsInterest = {
  apy: number;
  accruedScaledCents: bigint;
  creditDay: number;
  creditedMonths: string[];
};
