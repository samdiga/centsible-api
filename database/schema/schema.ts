import {
  pgTable,
  uuid,
  text,
  bigint,
  boolean,
  integer,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  unique,
  pgEnum,
  primaryKey,
  real,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { jobs } from './jobs.js';
import { users } from './users.js';

export { users };

// ─────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────

export const accountTypeEnum = pgEnum('account_type', [
  'depository', // checking, savings, money market, CD
  'credit', // credit card, line of credit
  'loan', // mortgage, auto, student, personal
  'investment', // brokerage, 401k, IRA, 529
  'other', // manual-entry assets, crypto wallets
]);

export const accountSubtypeEnum = pgEnum('account_subtype', [
  'checking',
  'savings',
  'money_market',
  'cd',
  'hsa',
  'credit_card',
  'line_of_credit',
  'paypal',
  'mortgage',
  'auto',
  'student',
  'personal_loan',
  'brokerage',
  'ira',
  '401k',
  '403b',
  '529',
  'roth',
  'roth_401k',
  'manual_home',
  'manual_vehicle',
  'crypto',
  'cash',
  'other',
]);

export const transactionStatusEnum = pgEnum('transaction_status', [
  'posted',
  'pending',
  'removed',
]);

export const reviewStatusEnum = pgEnum('review_status', [
  'needs_review',
  'reviewed',
  'hidden',
]);

export const budgetStyleEnum = pgEnum('budget_style', [
  'flex',
  'category_zero_based',
]);

export const budgetPeriodEnum = pgEnum('budget_period', [
  'monthly',
  'biweekly',
  'weekly',
]);

export const rolloverEnum = pgEnum('rollover_behavior', [
  'none', // unused resets to zero
  'roll_positive', // roll unused forward, not overages
  'roll_all', // roll both unused and overages
]);

export const goalStatusEnum = pgEnum('goal_status', [
  'active',
  'paused',
  'completed',
  'archived',
]);

export const goalTypeEnum = pgEnum('goal_type', [
  'savings',
  'purchase',
  'debt_payoff',
  'emergency_fund',
]);

export const billCadenceEnum = pgEnum('recurring_cadence', [
  'daily',
  'weekly',
  'biweekly',
  'semimonthly',
  'monthly',
  'quarterly',
  'annual',
  'irregular',
]);

export const billTypeEnum = pgEnum('bill_type', ['payable', 'transfer']);

export const billSetupStatusEnum = pgEnum('recurring_status', [
  'active',
  'paused',
  'ended',
  'pending_confirmation',
]);

export const plaidItemStatusEnum = pgEnum('plaid_item_status', [
  'active',
  'login_required',
  'pending_expiration',
  'error',
  'disconnected',
]);

export const ruleMatchTypeEnum = pgEnum('rule_match_type', [
  'merchant_exact',
  'merchant_contains',
  'name_contains',
  'amount_exact',
  'amount_range',
  'combo',
]);

export const memberRelationshipEnum = pgEnum('member_relationship', [
  'self',
  'partner',
  'child',
  'parent',
  'roommate',
  'other',
]);

export const auditActionEnum = pgEnum('audit_action', [
  'create',
  'update',
  'delete',
  'bulk_update',
  'revert',
  'merge',
  'split',
  'sync',
]);

export const forecastEventSourceTypeEnum = pgEnum('forecast_event_source_type', [
  'manual',
  'recurring',
]);

// ─────────────────────────────────────────────────────────────────
// Users & household
// ─────────────────────────────────────────────────────────────────

export const householdMembers = pgTable(
  'household_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    avatarEmoji: text('avatar_emoji'),
    avatarColor: text('avatar_color'),
    avatarImageUrl: text('avatar_image_url'),
    relationship: memberRelationshipEnum('relationship').notNull().default('self'),
    isPrimary: boolean('is_primary').notNull().default(false),
    displayOrder: integer('display_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    userIdIdx: index('household_members_user_id_idx').on(t.userId),
  }),
);

// ─────────────────────────────────────────────────────────────────
// Plaid items (bank connections)
// ─────────────────────────────────────────────────────────────────

export const plaidItems = pgTable(
  'plaid_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    plaidItemId: text('plaid_item_id').notNull().unique(),
    institutionId: text('institution_id').notNull(),
    institutionName: text('institution_name').notNull(),
    accessTokenEncrypted: text('access_token_encrypted').notNull(),
    accessTokenNonce: text('access_token_nonce').notNull(),
    cursor: text('cursor'),
    status: plaidItemStatusEnum('status').notNull().default('active'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    availableProducts: jsonb('available_products')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    billedProducts: jsonb('billed_products')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    consentedProducts: jsonb('consented_products')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastWebhookAt: timestamp('last_webhook_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    userIdIdx: index('plaid_items_user_id_idx').on(t.userId),
    statusIdx: index('plaid_items_status_idx').on(t.status),
  }),
);

// ─────────────────────────────────────────────────────────────────
// Accounts
// ─────────────────────────────────────────────────────────────────

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    plaidItemId: uuid('plaid_item_id').references(() => plaidItems.id, {
      onDelete: 'set null',
    }),
    plaidAccountId: text('plaid_account_id').unique(),
    name: text('name').notNull(),
    nameOverride: text('name_override'),
    officialName: text('official_name'),
    type: accountTypeEnum('type').notNull(),
    subtype: accountSubtypeEnum('subtype').notNull(),
    mask: text('mask'),
    currency: text('currency').notNull().default('USD'),
    currentBalance: bigint('current_balance_cents', { mode: 'bigint' }),
    availableBalance: bigint('available_balance_cents', { mode: 'bigint' }),
    limit: bigint('limit_cents', { mode: 'bigint' }),
    limitOverride: bigint('limit_override_cents', { mode: 'bigint' }),
    apr: real('apr'),
    apy: real('apy'),
    minimumPayment: bigint('minimum_payment_cents', { mode: 'bigint' }),
    paymentDueDate: date('payment_due_date'),
    paymentDueDateOverride: date('payment_due_date_override'),
    statementBalance: bigint('statement_balance_cents', { mode: 'bigint' }),
    statementDate: date('statement_date'),
    originationDate: date('origination_date'),
    maturityDate: date('maturity_date'),
    color: text('color'),
    icon: text('icon'),
    isHidden: boolean('is_hidden').notNull().default(false),
    excludeFromNetWorth: boolean('exclude_from_net_worth').notNull().default(false),
    excludeFromBudgets: boolean('exclude_from_budgets').notNull().default(false),
    excludeFromForecast: boolean('exclude_from_forecast').notNull().default(false),
    defaultMemberId: uuid('default_member_id').references(() => householdMembers.id, {
      onDelete: 'set null',
    }),
    displayOrder: integer('display_order').notNull().default(0),
    isManual: boolean('is_manual').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    balanceLastRefreshedAt: timestamp('balance_last_refreshed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    userIdIdx: index('accounts_user_id_idx').on(t.userId),
    plaidItemIdIdx: index('accounts_plaid_item_id_idx').on(t.plaidItemId),
    typeIdx: index('accounts_type_idx').on(t.userId, t.type),
  }),
);

export const manualAssets = pgTable(
  'manual_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull(),
    value: bigint('value_cents', { mode: 'bigint' }).notNull(),
    acquisitionDate: date('acquisition_date'),
    appreciationRatePerYear: real('appreciation_rate_per_year'),
    notes: text('notes'),
    isLiability: boolean('is_liability').notNull().default(false),
    displayOrder: integer('display_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    userIdIdx: index('manual_assets_user_id_idx').on(t.userId),
  }),
);

export const holdings = pgTable(
  'holdings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    plaidSecurityId: text('plaid_security_id'),
    ticker: text('ticker'),
    name: text('name').notNull(),
    securityType: text('security_type'),
    quantity: real('quantity').notNull(),
    costBasis: bigint('cost_basis_cents', { mode: 'bigint' }),
    currentPrice: bigint('current_price_cents', { mode: 'bigint' }),
    currentValue: bigint('current_value_cents', { mode: 'bigint' }),
    currency: text('currency').notNull().default('USD'),
    isManual: boolean('is_manual').notNull().default(false),
    priceLastRefreshedAt: timestamp('price_last_refreshed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    userIdIdx: index('holdings_user_id_idx').on(t.userId),
    accountIdIdx: index('holdings_account_id_idx').on(t.accountId),
  }),
);

// ─────────────────────────────────────────────────────────────────
// Categories
// ─────────────────────────────────────────────────────────────────

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'), // self-reference; FK declared in raw SQL migration
    name: text('name').notNull(),
    icon: text('icon'),
    color: text('color'),
    isIncome: boolean('is_income').notNull().default(false),
    isTransfer: boolean('is_transfer').notNull().default(false),
    excludeFromBudgets: boolean('exclude_from_budgets').notNull().default(false),
    displayOrder: integer('display_order').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('categories_user_id_idx').on(t.userId),
    parentIdIdx: index('categories_parent_id_idx').on(t.parentId),
    systemRootNameUniq: uniqueIndex('categories_system_root_name_uniq')
      .on(t.name)
      .where(sql`user_id IS NULL AND parent_id IS NULL`),
    systemSubNameUniq: uniqueIndex('categories_system_sub_name_uniq')
      .on(t.parentId, t.name)
      .where(sql`user_id IS NULL AND parent_id IS NOT NULL`),
    userNameUniq: uniqueIndex('categories_user_name_uniq')
      .on(t.userId, t.parentId, t.name)
      .where(sql`user_id IS NOT NULL`),
  }),
);

// ─────────────────────────────────────────────────────────────────
// Transactions
// ─────────────────────────────────────────────────────────────────

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    plaidTransactionId: text('plaid_transaction_id').unique(),
    amount: bigint('amount_cents', { mode: 'bigint' }).notNull(), // Plaid sign: + outflow, − inflow
    currency: text('currency').notNull().default('USD'),
    date: date('date').notNull(),
    authorizedDate: date('authorized_date'),
    status: transactionStatusEnum('status').notNull().default('posted'),
    name: text('name').notNull(),
    merchantName: text('merchant_name'),
    paymentChannel: text('payment_channel'),
    plaidCategoryPrimary: text('plaid_category_primary'),
    plaidCategoryDetailed: text('plaid_category_detailed'),
    plaidCategoryConfidence: text('plaid_category_confidence'),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    userCategoryOverride: boolean('user_category_override').notNull().default(false),
    userName: text('user_name'),
    notes: text('notes'),
    householdMemberId: uuid('household_member_id').references(() => householdMembers.id, {
      onDelete: 'set null',
    }),
    recurringSeriesId: uuid('recurring_series_id'), // FK declared in raw SQL migration
    isRecurring: boolean('is_recurring').notNull().default(false),
    isSplit: boolean('is_split').notNull().default(false),
    parentTransactionId: uuid('parent_transaction_id'), // FK declared in raw SQL migration
    reviewStatus: reviewStatusEnum('review_status').notNull().default('needs_review'),
    excludeFromBudgets: boolean('exclude_from_budgets').notNull().default(false),
    excludeFromReports: boolean('exclude_from_reports').notNull().default(false),
    isDuplicateOf: uuid('is_duplicate_of'), // FK declared in raw SQL migration
    location: jsonb('location').$type<{
      address?: string;
      city?: string;
      region?: string;
      postalCode?: string;
      country?: string;
      lat?: number;
      lon?: number;
    }>(),
    paymentMeta: jsonb('payment_meta').$type<{
      referenceNumber?: string;
      ppdId?: string;
      payee?: string;
      payer?: string;
      paymentMethod?: string;
      paymentProcessor?: string;
      reason?: string;
    }>(),
    plaidRawPayload: jsonb('plaid_raw_payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    userDateIdx: index('transactions_user_date_idx').on(t.userId, t.date.desc()),
    userAccountDateIdx: index('transactions_user_account_date_idx').on(
      t.userId,
      t.accountId,
      t.date.desc(),
    ),
    userCategoryDateIdx: index('transactions_user_category_date_idx').on(
      t.userId,
      t.categoryId,
      t.date.desc(),
    ),
    userMemberDateIdx: index('transactions_user_member_date_idx').on(
      t.userId,
      t.householdMemberId,
      t.date.desc(),
    ),
    userReviewIdx: index('transactions_user_review_idx').on(t.userId, t.reviewStatus),
    merchantIdx: index('transactions_merchant_idx').on(t.userId, t.merchantName),
    recurringSeriesIdx: index('transactions_recurring_series_idx').on(t.recurringSeriesId),
    parentIdx: index('transactions_parent_idx').on(t.parentTransactionId),
    userStatusDateIdx: index('transactions_user_status_date_idx').on(
      t.userId,
      t.status,
      t.date.desc(),
    ),
  }),
);

export const transactionSplits = pgTable(
  'transaction_splits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    householdMemberId: uuid('household_member_id')
      .notNull()
      .references(() => householdMembers.id, { onDelete: 'cascade' }),
    amount: bigint('amount_cents', { mode: 'bigint' }).notNull(),
    percentage: real('percentage'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    transactionIdIdx: index('transaction_splits_transaction_id_idx').on(t.transactionId),
    memberIdIdx: index('transaction_splits_member_id_idx').on(t.householdMemberId),
  }),
);

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userNameIdx: uniqueIndex('tags_user_name_idx').on(t.userId, t.name),
  }),
);

export const transactionTags = pgTable(
  'transaction_tags',
  {
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.transactionId, t.tagId] }),
  }),
);

/**
 * One row per Idempotency-Key a user sent to POST /transactions. A retry
 * with the same key and body replays `response`; the same key with a
 * different body is rejected. Written in the same DB transaction as the
 * transaction insert and balance change, so the effect happens exactly once.
 */
export const transactionIdempotencyKeys = pgTable(
  'transaction_idempotency_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: uuid('key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response'),
    transactionId: uuid('transaction_id').references(() => transactions.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.key] }),
  }),
);

// ─────────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────────

export const rules = pgTable(
  'rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name'),
    priority: integer('priority').notNull().default(100),
    matchType: ruleMatchTypeEnum('match_type').notNull(),
    matchMerchant: text('match_merchant'),
    matchNameContains: text('match_name_contains'),
    matchAmountMin: bigint('match_amount_min_cents', { mode: 'bigint' }),
    matchAmountMax: bigint('match_amount_max_cents', { mode: 'bigint' }),
    matchAccountId: uuid('match_account_id').references(() => accounts.id, {
      onDelete: 'cascade',
    }),
    actionCategoryId: uuid('action_category_id').references(() => categories.id, {
      onDelete: 'set null',
    }),
    actionMemberId: uuid('action_member_id').references(() => householdMembers.id, {
      onDelete: 'set null',
    }),
    actionSetNotes: text('action_set_notes'),
    actionAddTags: jsonb('action_add_tags').$type<string[]>(),
    actionRename: text('action_rename'),
    actionHide: boolean('action_hide'),
    actionMarkReviewed: boolean('action_mark_reviewed'),
    actionExcludeFromBudgets: boolean('action_exclude_from_budgets'),
    isActive: boolean('is_active').notNull().default(true),
    applyToExisting: boolean('apply_to_existing').notNull().default(false),
    lastAppliedAt: timestamp('last_applied_at', { withTimezone: true }),
    timesApplied: integer('times_applied').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userPriorityIdx: index('rules_user_priority_idx').on(t.userId, t.priority),
    userActiveIdx: index('rules_user_active_idx').on(t.userId, t.isActive),
  }),
);

// ─────────────────────────────────────────────────────────────────
// Bill setup (formerly recurring_series)
// ─────────────────────────────────────────────────────────────────

export const billSetup = pgTable(
  'bill_setup',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    billType: billTypeEnum('bill_type').notNull().default('payable'),
    toAccountId: uuid('to_account_id').references(() => accounts.id, { onDelete: 'set null' }),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    canonicalName: text('canonical_name').notNull(),
    merchantPatterns: jsonb('merchant_patterns')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    isIncome: boolean('is_income').notNull().default(false),
    cadence: billCadenceEnum('cadence').notNull(),
    dayOfMonth: integer('day_of_month'),
    dayOfWeek: integer('day_of_week'),
    avgAmount: bigint('avg_amount_cents', { mode: 'bigint' }).notNull(),
    stdDevAmount: bigint('std_dev_amount_cents', { mode: 'bigint' }).notNull().default(sql`0`),
    lastAmount: bigint('last_amount_cents', { mode: 'bigint' }),
    lastOccurredOn: date('last_occurred_on'),
    nextExpectedDate: date('next_expected_date'),
    confidence: real('confidence').notNull().default(0),
    sampleCount: integer('sample_count').notNull().default(0),
    status: billSetupStatusEnum('status').notNull().default('pending_confirmation'),
    userConfirmed: boolean('user_confirmed').notNull().default(false),
    autoDetected: boolean('auto_detected').notNull().default(true),
    notes: text('notes'),
    lastPriceChangeAt: timestamp('last_price_change_at', { withTimezone: true }),
    previousAvgAmount: bigint('previous_avg_amount_cents', { mode: 'bigint' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    userIdIdx: index('bill_setup_user_id_idx').on(t.userId),
    userNextDateIdx: index('bill_setup_user_next_date_idx').on(
      t.userId,
      t.nextExpectedDate,
    ),
    userStatusIdx: index('bill_setup_user_status_idx').on(t.userId, t.status),
    userNameCadenceUniq: uniqueIndex('bill_setup_user_name_cadence_uniq').on(
      t.userId,
      t.canonicalName,
      t.cadence,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────
// Bill occurrences (payment lifecycle)
// ─────────────────────────────────────────────────────────────────

export const billOccurrenceStatusEnum = pgEnum('bill_occurrence_status', [
  'upcoming',
  'overdue',
  'processing',
  'paid',
  'skipped',
  'cancelled',
]);

export const billOccurrences = pgTable(
  'bill_occurrences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    billSetupId: uuid('bill_setup_id')
      .notNull()
      .references(() => billSetup.id, { onDelete: 'cascade' }),
    occurrenceKey: text('occurrence_key').notNull(),
    dueDate: date('due_date').notNull(),
    dueDateOverride: date('due_date_override'),
    status: billOccurrenceStatusEnum('status').notNull().default('upcoming'),
    expectedAmountCents: bigint('expected_amount_cents', { mode: 'bigint' }).notNull(),
    expectedAmountOverrideCents: bigint('expected_amount_override_cents', { mode: 'bigint' }),
    paidAmountCents: bigint('paid_amount_cents', { mode: 'bigint' }),
    paidAccountId: uuid('paid_account_id').references(() => accounts.id, { onDelete: 'set null' }),
    linkedTransactionId: uuid('linked_transaction_id').references(() => transactions.id, { onDelete: 'set null' }),
    markedPaidAt: timestamp('marked_paid_at', { withTimezone: true }),
    confirmedPaidAt: timestamp('confirmed_paid_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userDueDateIdx: index('bill_occurrences_user_due_date_idx').on(t.userId, t.dueDate.desc()),
    userSetupIdx: index('bill_occurrences_user_setup_idx').on(t.userId, t.billSetupId),
    userStatusIdx: index('bill_occurrences_user_status_idx').on(t.userId, t.status),
    linkedTxnIdx: index('bill_occurrences_linked_txn_idx').on(t.linkedTransactionId),
    setupDueDateUniq: uniqueIndex('bill_occurrences_setup_due_date_uniq').on(t.billSetupId, t.dueDate),
    setupOccurrenceKeyUniq: uniqueIndex('bill_occurrences_setup_occurrence_key_uniq').on(t.billSetupId, t.occurrenceKey),
  }),
);

// Backwards-compat aliases — removed after all consumers are updated
export const recurringSeries = billSetup;
export const recurringStatusEnum = billSetupStatusEnum;
export const recurringCadenceEnum = billCadenceEnum;

// ─────────────────────────────────────────────────────────────────
// Budgets
// ─────────────────────────────────────────────────────────────────

export const budgets = pgTable(
  'budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default('My Budget'),
    style: budgetStyleEnum('style').notNull().default('flex'),
    period: budgetPeriodEnum('period').notNull().default('monthly'),
    startDate: date('start_date').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('budgets_user_id_idx').on(t.userId),
    userActiveIdx: index('budgets_user_active_idx').on(t.userId, t.isActive),
    oneActivePerUserUniq: uniqueIndex('budgets_one_active_per_user_uniq')
      .on(t.userId)
      .where(sql`is_active = true`),
  }),
);

export const budgetItems = pgTable(
  'budget_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    householdMemberId: uuid('household_member_id').references(() => householdMembers.id, {
      onDelete: 'set null',
    }),
    amount: bigint('amount_cents', { mode: 'bigint' }).notNull(),
    rolloverBehavior: rolloverEnum('rollover_behavior').notNull().default('none'),
    rolloverBalance: bigint('rollover_balance_cents', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    isPaused: boolean('is_paused').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    budgetIdIdx: index('budget_items_budget_id_idx').on(t.budgetId),
    categoryIdIdx: index('budget_items_category_id_idx').on(t.categoryId),
    uniqPerTuple: uniqueIndex('budget_items_unique_tuple').on(
      t.budgetId,
      t.categoryId,
      t.householdMemberId,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────
// Goals
// ─────────────────────────────────────────────────────────────────

export const goals = pgTable(
  'goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: goalTypeEnum('type').notNull(),
    targetAmount: bigint('target_amount_cents', { mode: 'bigint' }).notNull(),
    currentAmount: bigint('current_amount_cents', { mode: 'bigint' }).notNull().default(sql`0`),
    targetDate: date('target_date'),
    linkedAccountId: uuid('linked_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    linkedCategoryId: uuid('linked_category_id').references(() => categories.id, {
      onDelete: 'set null',
    }),
    linkedDebtAccountId: uuid('linked_debt_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    memberAllocations: jsonb('member_allocations').$type<
      Array<{ memberId: string; percentage: number }>
    >(),
    autoContributeMonthly: bigint('auto_contribute_monthly_cents', { mode: 'bigint' }),
    autoContributeFromCategoryId: uuid('auto_contribute_from_category_id').references(
      () => categories.id,
      { onDelete: 'set null' },
    ),
    photoUrl: text('photo_url'),
    emoji: text('emoji'),
    color: text('color'),
    status: goalStatusEnum('status').notNull().default('active'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    displayOrder: integer('display_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    userIdIdx: index('goals_user_id_idx').on(t.userId),
    userStatusIdx: index('goals_user_status_idx').on(t.userId, t.status),
  }),
);

export const goalContributions = pgTable(
  'goal_contributions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    goalId: uuid('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    transactionId: uuid('transaction_id').references(() => transactions.id, {
      onDelete: 'set null',
    }),
    amount: bigint('amount_cents', { mode: 'bigint' }).notNull(),
    date: date('date').notNull(),
    note: text('note'),
    isManual: boolean('is_manual').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    goalIdIdx: index('goal_contributions_goal_id_idx').on(t.goalId),
    userIdIdx: index('goal_contributions_user_id_idx').on(t.userId),
  }),
);

// ─────────────────────────────────────────────────────────────────
// Net worth snapshots
// ─────────────────────────────────────────────────────────────────

export const netWorthSnapshots = pgTable(
  'net_worth_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    totalAssets: bigint('total_assets_cents', { mode: 'bigint' }).notNull(),
    totalLiabilities: bigint('total_liabilities_cents', { mode: 'bigint' }).notNull(),
    netWorth: bigint('net_worth_cents', { mode: 'bigint' }).notNull(),
    liquidAssets: bigint('liquid_assets_cents', { mode: 'bigint' }).notNull(),
    breakdown: jsonb('breakdown').$type<Record<string, number>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userDateIdx: uniqueIndex('net_worth_snapshots_user_date_idx').on(t.userId, t.date),
  }),
);

// ─────────────────────────────────────────────────────────────────
// Cash Horizon
// ─────────────────────────────────────────────────────────────────

export const forecastRuns = pgTable(
  'forecast_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    horizonDays: integer('horizon_days').notNull(),
    algorithmVersion: text('algorithm_version').notNull(),
    scenarioId: uuid('scenario_id'), // FK declared in raw SQL migration
    startBalance: bigint('start_balance_cents', { mode: 'bigint' }).notNull(),
    endBalanceP50: bigint('end_balance_p50_cents', { mode: 'bigint' }).notNull(),
    minBalanceP10: bigint('min_balance_p10_cents', { mode: 'bigint' }).notNull(),
    minBalanceDate: date('min_balance_date').notNull(),
    dailyResults: jsonb('daily_results')
      .$type<
        Array<{
          date: string;
          p10: string;
          p50: string;
          p90: string;
          events: Array<{
            name: string;
            amount: string;
            confidence: number;
            sourceType: string;
            sourceId?: string;
          }>;
        }>
      >()
      .notNull(),
    actualEndBalance: bigint('actual_end_balance_cents', { mode: 'bigint' }),
    mape: real('mape'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('forecast_runs_user_id_idx').on(t.userId),
    userCreatedIdx: index('forecast_runs_user_created_idx').on(
      t.userId,
      t.createdAt.desc(),
    ),
  }),
);

export const forecastScenarios = pgTable(
  'forecast_scenarios',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    modifiers: jsonb('modifiers')
      .$type<
        Array<{
          type:
            | 'add_expense'
            | 'remove_expense'
            | 'add_income'
            | 'delay_event'
            | 'modify_recurring';
          date?: string;
          amount?: number;
          recurringSeriesId?: string;
          note?: string;
        }>
      >()
      .notNull()
      .default(sql`'[]'::jsonb`),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    userIdIdx: index('forecast_scenarios_user_id_idx').on(t.userId),
  }),
);

export const forecastEvents = pgTable(
  'forecast_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    amount: bigint('amount_cents', { mode: 'bigint' }).notNull(),
    date: date('date').notNull(),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    note: text('note'),
    resolvedToTransactionId: uuid('resolved_to_transaction_id').references(
      () => transactions.id,
      { onDelete: 'set null' },
    ),
    recurringSeriesId: uuid('recurring_series_id'), // FK declared in raw SQL migration
    billOccurrenceId: uuid('bill_occurrence_id').references(() => billOccurrences.id, { onDelete: 'set null' }),
    sourceType: forecastEventSourceTypeEnum('source_type').notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    userDateIdx: index('forecast_events_user_date_idx').on(t.userId, t.date),
    recurringSeriesDateIdx: index('forecast_events_recurring_series_date_idx').on(t.recurringSeriesId, t.date),
    recurringIdentityUniq: uniqueIndex('forecast_events_identity_uniq').on(
      t.userId,
      t.recurringSeriesId,
      t.date,
    ).where(sql`bill_occurrence_id IS NULL`),
    seriesDateUniq: uniqueIndex('forecast_events_series_date_uniq')
      .on(t.recurringSeriesId, t.date)
      .where(sql`recurring_series_id IS NOT NULL AND deleted_at IS NULL AND bill_occurrence_id IS NULL`),
    billOccurrenceIdUniq: uniqueIndex('forecast_events_bill_occurrence_id_uniq')
      .on(t.billOccurrenceId)
      .where(sql`bill_occurrence_id IS NOT NULL`),
  }),
);

// ─────────────────────────────────────────────────────────────────
// AI
// ─────────────────────────────────────────────────────────────────

export const aiSessions = pgTable(
  'ai_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    userIdIdx: index('ai_sessions_user_id_idx').on(t.userId),
  }),
);

export const aiMessages = pgTable(
  'ai_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => aiSessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    model: text('model'),
    promptVersion: text('prompt_version'),
    toolCalls: jsonb('tool_calls').$type<
      Array<{ name: string; input: unknown; output: unknown }>
    >(),
    citations: jsonb('citations').$type<Array<{ transactionId: string }>>(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cachedTokens: integer('cached_tokens'),
    latencyMs: integer('latency_ms'),
    confidence: real('confidence'),
    guardrailFlags: jsonb('guardrail_flags').$type<string[]>(),
    userFeedback: text('user_feedback'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionIdIdx: index('ai_messages_session_id_idx').on(t.sessionId),
    userIdIdx: index('ai_messages_user_id_idx').on(t.userId),
  }),
);

// pgvector column added via raw SQL migration (drizzle-kit can't express it natively).
export const transactionEmbeddings = pgTable(
  'transaction_embeddings',
  {
    transactionId: uuid('transaction_id')
      .primaryKey()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('transaction_embeddings_user_id_idx').on(t.userId),
  }),
);

// ─────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────

export const notificationPreferences = pgTable('notification_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  dailyDigestEnabled: boolean('daily_digest_enabled').notNull().default(true),
  dailyDigestHour: integer('daily_digest_hour').notNull().default(9),
  lowBalanceAlertsEnabled: boolean('low_balance_alerts_enabled').notNull().default(true),
  lowBalanceThreshold: bigint('low_balance_threshold_cents', { mode: 'bigint' })
    .notNull()
    .default(sql`10000`),
  billRemindersEnabled: boolean('bill_reminders_enabled').notNull().default(true),
  billReminderDaysAhead: integer('bill_reminder_days_ahead').notNull().default(3),
  largeTransactionAlertsEnabled: boolean('large_transaction_alerts_enabled')
    .notNull()
    .default(true),
  largeTransactionThreshold: bigint('large_transaction_threshold_cents', {
    mode: 'bigint',
  })
    .notNull()
    .default(sql`20000`),
  priceChangeAlertsEnabled: boolean('price_change_alerts_enabled').notNull().default(true),
  quietHoursEnabled: boolean('quiet_hours_enabled').notNull().default(true),
  quietHoursStart: integer('quiet_hours_start').notNull().default(22),
  quietHoursEnd: integer('quiet_hours_end').notNull().default(7),
  pushToken: text('push_token'),
  pushPlatform: text('push_platform'),
  pushEnvironment: text('push_environment'),
  syncAlertsEnabled: boolean('sync_alerts_enabled').notNull().default(true),
  materializationHorizonMonths: integer('materialization_horizon_months').notNull().default(12),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    payload: jsonb('payload'),
    readAt: timestamp('read_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    pushSentAt: timestamp('push_sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index('notifications_user_created_idx').on(
      t.userId,
      t.createdAt.desc(),
    ),
    userUnreadIdx: index('notifications_user_unread_idx').on(t.userId, t.readAt),
  }),
);

// ─────────────────────────────────────────────────────────────────
// Audit log & system
// ─────────────────────────────────────────────────────────────────

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    action: auditActionEnum('action').notNull(),
    beforeJson: jsonb('before_json'),
    afterJson: jsonb('after_json'),
    source: text('source').notNull(),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userEntityIdx: index('audit_log_user_entity_idx').on(t.userId, t.entityType, t.entityId),
    userCreatedIdx: index('audit_log_user_created_idx').on(t.userId, t.createdAt.desc()),
  }),
);

export const featureFlags = pgTable(
  'feature_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    flagKey: text('flag_key').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    variant: text('variant'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userFlagIdx: uniqueIndex('feature_flags_user_flag_idx').on(t.userId, t.flagKey),
  }),
);

export const plaidRawImports = pgTable(
  'plaid_raw_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    plaidItemId: uuid('plaid_item_id')
      .notNull()
      .references(() => plaidItems.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    cursor: text('cursor'),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index('plaid_raw_imports_user_created_idx').on(
      t.userId,
      t.createdAt.desc(),
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────
// Sync pipeline orchestration (runs, steps, schedules)
// ─────────────────────────────────────────────────────────────────

export const pipelineTriggerEnum = pgEnum('pipeline_trigger', [
  'scheduled',
  'manual',
  'webhook',
]);

export const pipelineRunStatusEnum = pgEnum('pipeline_run_status', [
  'running',
  'success',
  'partial',
  'failed',
]);

export const pipelineStepStatusEnum = pgEnum('pipeline_step_status', [
  'pending',
  'running',
  'success',
  'failed',
  'skipped',
]);

export const pipelineRuns = pgTable(
  'pipeline_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    trigger: pipelineTriggerEnum('trigger').notNull(),
    status: pipelineRunStatusEnum('status').notNull().default('running'),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userStartedIdx: index('pipeline_runs_user_started_idx').on(t.userId, t.startedAt.desc()),
    jobIdx: index('pipeline_runs_job_idx').on(t.jobId),
  }),
);

export const pipelineRunSteps = pgTable(
  'pipeline_run_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    step: text('step').notNull(),
    status: pipelineStepStatusEnum('status').notNull().default('pending'),
    // Counts/booleans/date-strings only. NEVER transaction names, account
    // numbers, or tokens (CLAUDE.md no-PII rule).
    stats: jsonb('stats').$type<Record<string, number | string | boolean>>(),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runStepUniq: uniqueIndex('pipeline_run_steps_run_step_uniq').on(t.runId, t.step),
    userIdx: index('pipeline_run_steps_user_idx').on(t.userId),
  }),
);

export const syncSchedules = pgTable(
  'sync_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // NULL for system schedules (retention purge etc.), like jobs.user_id.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    scheduleKey: text('schedule_key').notNull(),
    hour: integer('hour').notNull().default(6),
    minute: integer('minute').notNull().default(0),
    timezone: text('timezone').notNull().default('UTC'),
    enabled: boolean('enabled').notNull().default(true),
    // Local calendar date (in `timezone`) this schedule last fired for.
    // Atomic claim marker — prevents double-dispatch across instances.
    lastDispatchedFor: date('last_dispatched_for'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // NULLS NOT DISTINCT so two system rows (user_id NULL) with the same
    // key are rejected. Requires Postgres 15+.
    // drizzle-orm 0.36.4's uniqueIndex().with() only emits index storage
    // parameters, not NULLS NOT DISTINCT — use the unique() table
    // constraint builder instead, which supports it directly.
    userKeyUniq: unique('sync_schedules_user_key_uniq')
      .on(t.userId, t.scheduleKey)
      .nullsNotDistinct(),
  }),
);
