/**
 * Transaction splits (T-186): the arithmetic on a transaction's category
 * lines. Pure, integer cents. Spec:
 * docs/superpowers/specs/2026-11-07-transaction-splits-design.md
 */

export type SplitLine = {
  categoryId: string | null;
  amount: bigint;
  position: number;
  isRemainder: boolean;
};

export type SplitValidationError =
  | "too_few_lines"
  | "zero_line"
  | "sign_mismatch"
  | "sum_mismatch"
  | "duplicate_category"
  | "remainder_count";

const abs = (value: bigint) => (value < 0n ? -value : value);
const sign = (value: bigint) => (value > 0n ? 1 : value < 0n ? -1 : 0);
const total = (lines: readonly SplitLine[]) =>
  lines.reduce((sum, line) => sum + line.amount, 0n);

/**
 * The category a split shows as a whole: older apps' categoryId and where a
 * flagged split counts. The largest line by absolute amount (refunds are
 * negative); ties go to the lowest position.
 */
export function derivedCategoryId(lines: readonly SplitLine[]): string | null {
  let best: SplitLine | undefined;
  for (const line of lines) {
    if (
      !best ||
      abs(line.amount) > abs(best.amount) ||
      (abs(line.amount) === abs(best.amount) && line.position < best.position)
    )
      best = line;
  }
  return best?.categoryId ?? null;
}

/** Null when the lines are a valid split of `transactionAmount`. */
export function validateSplitLines(
  lines: readonly SplitLine[],
  transactionAmount: bigint,
): SplitValidationError | null {
  if (lines.length < 2) return "too_few_lines";
  if (lines.some((line) => line.amount === 0n)) return "zero_line";
  if (lines.some((line) => sign(line.amount) !== sign(transactionAmount)))
    return "sign_mismatch";
  const categories = lines.map((line) => line.categoryId);
  if (new Set(categories).size !== categories.length)
    return "duplicate_category";
  if (lines.filter((line) => line.isRemainder).length !== 1)
    return "remainder_count";
  if (total(lines) !== transactionAmount) return "sum_mismatch";
  return null;
}

/**
 * The lines after the transaction's amount changes to `newAmount`. The
 * remainder line absorbs the difference; when that leaves any line zero or
 * of the wrong sign, the lines are returned unchanged and `outOfBalance` is
 * true. Lines that already add up to `newAmount` are balanced, so a flag
 * clears when the amount comes back.
 */
export function rebalance(
  lines: readonly SplitLine[],
  newAmount: bigint,
): { lines: SplitLine[]; outOfBalance: boolean } {
  if (total(lines) === newAmount)
    return { lines: [...lines], outOfBalance: false };
  const remainder = lines.find((line) => line.isRemainder);
  if (!remainder) return { lines: [...lines], outOfBalance: true };
  const others = total(lines) - remainder.amount;
  const adjusted = lines.map((line) =>
    line === remainder ? { ...line, amount: newAmount - others } : line,
  );
  const balanced = adjusted.every(
    (line) => line.amount !== 0n && sign(line.amount) === sign(newAmount),
  );
  return balanced
    ? { lines: adjusted, outOfBalance: false }
    : { lines: [...lines], outOfBalance: true };
}

/**
 * Lines that came to share a category (an archive-with-reassign or a
 * customised default moved one onto another) become one line at the lowest
 * position, amounts summed, keeping the remainder marker if either had it.
 * Positions are renumbered from 0.
 */
export function mergeDuplicateCategories(
  lines: readonly SplitLine[],
): SplitLine[] {
  const merged: SplitLine[] = [];
  for (const line of [...lines].sort((a, b) => a.position - b.position)) {
    const existing = merged.find((m) => m.categoryId === line.categoryId);
    if (existing) {
      existing.amount += line.amount;
      existing.isRemainder ||= line.isRemainder;
    } else merged.push({ ...line });
  }
  return merged.map((line, position) => ({ ...line, position }));
}
