import { getDb } from "../../platform/database/client.js";
import type { Db } from "../../platform/database/types.js";
import { addDays, generateAccountsForecast } from "./engine/accounts.js";
import { getAccountForecastInputs } from "./forecast-accounts.repository.js";

export type CardPaymentProjection = Readonly<{
  cardAccountId: string;
  dueDate: string;
  /** What the v2 engine expects the user to pay toward this statement. */
  paymentCents: bigint;
}>;

/**
 * The v2 engine's projected payment for each card statement due from `today`
 * through `through`, the same figures Horizon draws.
 */
export async function projectCardPayments(
  userId: string,
  today: string,
  through: string,
  db: Db = getDb(),
): Promise<CardPaymentProjection[]> {
  let horizonDays = 1;
  while (addDays(today, horizonDays - 1) < through) horizonDays += 1;
  const inputs = await getAccountForecastInputs(userId, horizonDays, today, db);
  return generateAccountsForecast({ today, horizonDays, ...inputs })
    .cardStatements.filter((statement) => statement.dueDate <= through)
    .map((statement) => ({
      cardAccountId: statement.accountId,
      dueDate: statement.dueDate,
      paymentCents: statement.paymentCents,
    }));
}
