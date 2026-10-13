import { describe, expect, it } from "vitest";

import { TransactionListQuerySchema } from "../transactions.schemas.js";

const food = "22222222-2222-4222-8222-222222222222";
const dining = "33333333-3333-4333-8333-333333333333";

describe("transaction list query", () => {
  it("reads a comma list of categories and true/false flags", () => {
    expect(
      TransactionListQuerySchema.parse({
        categoryIds: `${food},${dining}`,
        includeChildren: "true",
        budget: "false",
      }),
    ).toMatchObject({
      categoryIds: [food, dining],
      includeChildren: true,
      budget: false,
    });
  });

  it("leaves the new filters out when absent", () => {
    const query = TransactionListQuerySchema.parse({});
    expect(query.categoryIds).toBeUndefined();
    expect(query.budget).toBeUndefined();
  });

  it("rejects a non-uuid category and a flag that isn't true or false", () => {
    expect(
      TransactionListQuerySchema.safeParse({ categoryIds: "food" }).success,
    ).toBe(false);
    expect(
      TransactionListQuerySchema.safeParse({ uncategorized: "yes" }).success,
    ).toBe(false);
  });
});
