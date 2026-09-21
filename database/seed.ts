import { fileURLToPath } from "node:url";
import { and, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import { categories } from "./schema/index.js";
import * as schema from "./schema/index.js";
import type { Db } from "../src/platform/database/types.js";

interface CategorySeed {
  name: string;
  icon: string;
  color: string;
  isIncome?: boolean;
  isTransfer?: boolean;
  excludeFromBudgets?: boolean;
  subs?: readonly SubcategorySeed[];
}

interface SubcategorySeed {
  name: string;
  icon: string;
}

const testSchemaPattern = /^centsible_test_[a-z0-9_]+$/;

export const DEFAULT_CATEGORIES: readonly CategorySeed[] = [
  {
    name: "Income",
    icon: "dollar-sign",
    color: "#10b981",
    isIncome: true,
    subs: [
      { name: "Paycheck", icon: "dollar-sign" },
      { name: "Freelance", icon: "briefcase" },
      { name: "Interest", icon: "trending-up" },
      { name: "Dividends", icon: "trending-up" },
      { name: "Refund", icon: "receipt" },
      { name: "Other Income", icon: "dollar-sign" },
    ],
  },
  {
    name: "Housing",
    icon: "home",
    color: "#8b5cf6",
    subs: [
      { name: "Rent", icon: "home" },
      { name: "Mortgage", icon: "home" },
      { name: "HOA", icon: "building-2" },
      { name: "Home Maintenance", icon: "wrench" },
      { name: "Home Improvement", icon: "wrench" },
    ],
  },
  {
    name: "Food & Drink",
    icon: "utensils",
    color: "#f59e0b",
    subs: [
      { name: "Groceries", icon: "shopping-cart" },
      { name: "Restaurants", icon: "utensils" },
      { name: "Coffee Shops", icon: "coffee" },
      { name: "Fast Food", icon: "utensils" },
      { name: "Alcohol & Bars", icon: "wine" },
    ],
  },
  {
    name: "Transportation",
    icon: "car",
    color: "#3b82f6",
    subs: [
      { name: "Gas", icon: "fuel" },
      { name: "Parking", icon: "map-pin" },
      { name: "Public Transit", icon: "bus" },
      { name: "Rideshare", icon: "car" },
      { name: "Car Insurance", icon: "shield" },
      { name: "Car Maintenance", icon: "wrench" },
      { name: "Car Payment", icon: "credit-card" },
    ],
  },
  {
    name: "Shopping",
    icon: "shopping-bag",
    color: "#ec4899",
    subs: [
      { name: "Clothing", icon: "shirt" },
      { name: "Electronics", icon: "smartphone" },
      { name: "Home Goods", icon: "home" },
      { name: "Hobbies", icon: "star" },
      { name: "General Merchandise", icon: "shopping-bag" },
    ],
  },
  {
    name: "Entertainment",
    icon: "tv",
    color: "#a855f7",
    subs: [
      { name: "Movies", icon: "tv" },
      { name: "Concerts", icon: "music" },
      { name: "Streaming", icon: "tv" },
      { name: "Games", icon: "gamepad-2" },
      { name: "Sports", icon: "dumbbell" },
      { name: "Books", icon: "book-open" },
    ],
  },
  {
    name: "Health & Wellness",
    icon: "heart-pulse",
    color: "#06b6d4",
    subs: [
      { name: "Doctor", icon: "stethoscope" },
      { name: "Dentist", icon: "stethoscope" },
      { name: "Pharmacy", icon: "pill" },
      { name: "Gym", icon: "dumbbell" },
      { name: "Wellness", icon: "leaf" },
      { name: "Insurance", icon: "shield" },
    ],
  },
  {
    name: "Personal",
    icon: "users",
    color: "#f97316",
    subs: [
      { name: "Haircut", icon: "users" },
      { name: "Beauty", icon: "star" },
      { name: "Laundry", icon: "repeat" },
      { name: "Personal Care", icon: "users" },
    ],
  },
  {
    name: "Bills & Utilities",
    icon: "zap",
    color: "#64748b",
    subs: [
      { name: "Electricity", icon: "zap" },
      { name: "Water", icon: "droplets" },
      { name: "Internet", icon: "globe" },
      { name: "Phone", icon: "smartphone" },
      { name: "Gas/Heating", icon: "flame" },
      { name: "Trash", icon: "trash-2" },
    ],
  },
  {
    name: "Subscriptions",
    icon: "repeat",
    color: "#0ea5e9",
    subs: [
      { name: "Streaming Services", icon: "tv" },
      { name: "Software", icon: "laptop" },
      { name: "News & Magazines", icon: "book-open" },
      { name: "Memberships", icon: "users" },
    ],
  },
  {
    name: "Savings & Investments",
    icon: "trending-up",
    color: "#22c55e",
    subs: [
      { name: "Emergency Fund", icon: "piggy-bank" },
      { name: "Retirement", icon: "trending-up" },
      { name: "Brokerage", icon: "trending-up" },
      { name: "Crypto", icon: "trending-up" },
    ],
  },
  {
    name: "Debt Payments",
    icon: "credit-card",
    color: "#ef4444",
    subs: [
      { name: "Credit Card Payment", icon: "credit-card" },
      { name: "Student Loan", icon: "graduation-cap" },
      { name: "Personal Loan", icon: "landmark" },
      { name: "Other Loan", icon: "landmark" },
    ],
  },
  {
    name: "Fees & Charges",
    icon: "receipt",
    color: "#dc2626",
    subs: [
      { name: "Bank Fees", icon: "landmark" },
      { name: "Overdraft", icon: "landmark" },
      { name: "ATM Fees", icon: "landmark" },
      { name: "Foreign Transaction", icon: "globe" },
      { name: "Late Fee", icon: "receipt" },
    ],
  },
  {
    name: "Transfer",
    icon: "arrow-left-right",
    color: "#6b7280",
    isTransfer: true,
    excludeFromBudgets: true,
  },
  {
    name: "Taxes",
    icon: "landmark",
    color: "#78716c",
    subs: [
      { name: "Federal Tax", icon: "landmark" },
      { name: "State Tax", icon: "landmark" },
      { name: "Property Tax", icon: "home" },
      { name: "Tax Prep", icon: "receipt" },
    ],
  },
  {
    name: "Education",
    icon: "graduation-cap",
    color: "#2563eb",
    subs: [
      { name: "Tuition", icon: "graduation-cap" },
      { name: "Books", icon: "book-open" },
      { name: "Courses", icon: "laptop" },
    ],
  },
  {
    name: "Kids",
    icon: "baby",
    color: "#f472b6",
    subs: [
      { name: "Childcare", icon: "baby" },
      { name: "School", icon: "graduation-cap" },
      { name: "Activities", icon: "star" },
      { name: "Toys", icon: "gift" },
      { name: "Clothes", icon: "shirt" },
    ],
  },
  {
    name: "Pets",
    icon: "paw-print",
    color: "#84cc16",
    subs: [
      { name: "Food", icon: "paw-print" },
      { name: "Vet", icon: "heart-pulse" },
      { name: "Grooming", icon: "paw-print" },
      { name: "Supplies", icon: "paw-print" },
    ],
  },
  {
    name: "Gifts & Donations",
    icon: "gift",
    color: "#e11d48",
    subs: [
      { name: "Gifts", icon: "gift" },
      { name: "Charity", icon: "heart" },
    ],
  },
  {
    name: "Travel",
    icon: "plane",
    color: "#0891b2",
    subs: [
      { name: "Flights", icon: "plane" },
      { name: "Lodging", icon: "hotel" },
      { name: "Activities", icon: "map-pin" },
      { name: "Food (Travel)", icon: "utensils" },
    ],
  },
  { name: "Business", icon: "briefcase", color: "#7c3aed" },
  { name: "Uncategorized", icon: "help-circle", color: "#94a3b8" },
];

export async function seedSystemData(db: Db): Promise<void> {
  await db
    .insert(categories)
    .values(
      DEFAULT_CATEGORIES.map((group, rootOrder) => ({
        userId: null,
        name: group.name,
        icon: group.icon,
        color: group.color,
        isIncome: group.isIncome ?? false,
        isTransfer: group.isTransfer ?? false,
        excludeFromBudgets: group.excludeFromBudgets ?? false,
        displayOrder: rootOrder,
      })),
    )
    .onConflictDoNothing();

  const roots = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(and(isNull(categories.userId), isNull(categories.parentId)));
  const rootIds = new Map(roots.map((root) => [root.name, root.id]));
  const childRows = DEFAULT_CATEGORIES.flatMap((group) => {
    const parentId = rootIds.get(group.name);
    if (!parentId) {
      throw new Error(`Could not resolve system category: ${group.name}`);
    }
    return (group.subs ?? []).map((child, childOrder) => ({
      userId: null,
      parentId,
      name: child.name,
      icon: child.icon,
      color: group.color,
      isIncome: group.isIncome ?? false,
      isTransfer: group.isTransfer ?? false,
      excludeFromBudgets: group.excludeFromBudgets ?? false,
      displayOrder: childOrder,
    }));
  });
  if (childRows.length > 0) {
    await db.insert(categories).values(childRows).onConflictDoNothing();
  }
}

function resolveSeedSchema(environment: NodeJS.ProcessEnv): string {
  const schemaName = environment.DATABASE_SCHEMA;
  if (!schemaName) {
    throw new Error(
      "DATABASE_SCHEMA is required; seeding never defaults to public",
    );
  }
  if (
    schemaName === "public" &&
    environment.ALLOW_PUBLIC_DATABASE_MIGRATION !== "true"
  ) {
    throw new Error(
      "DATABASE_SCHEMA=public requires ALLOW_PUBLIC_DATABASE_MIGRATION=true",
    );
  }
  if (schemaName !== "public" && !testSchemaPattern.test(schemaName)) {
    throw new Error("Refusing to seed an unsupported database schema");
  }
  return schemaName;
}

function quoteSchema(schemaName: string): string {
  return schemaName === "public" ? '"public"' : `"${schemaName}"`;
}

export async function seedSchema(
  client: Sql,
  schemaName: string,
): Promise<void> {
  if (schemaName !== "public" && !testSchemaPattern.test(schemaName)) {
    throw new Error("Refusing to seed an unsupported database schema");
  }
  const quotedSchema = quoteSchema(schemaName);
  await client.unsafe(`SET search_path TO ${quotedSchema}`);
  const current = await client<{ schema_name: string }[]>`
    select current_schema() as schema_name
  `;
  if (current[0]?.schema_name !== schemaName) {
    throw new Error("Database search path does not match the seed schema");
  }
  const db = drizzle(client, { schema });
  await db.transaction(async (transaction) => {
    await seedSystemData(transaction as Db);
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const schemaName = resolveSeedSchema(process.env);
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await seedSchema(client, schemaName);
    console.log("System data seed complete");
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
