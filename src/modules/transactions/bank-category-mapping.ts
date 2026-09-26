/**
 * Maps Plaid's personal finance category onto Centsy's default categories by
 * name. The most specific match wins: a detailed code before its primary
 * group. Codes with no honest counterpart (GENERAL_SERVICES, most of
 * GOVERNMENT_AND_NON_PROFIT) map to nothing rather than a guess, and a renamed
 * or deleted default simply stops matching.
 *
 * Kept in step with the app's display-only copy
 * (centsible-ui BankCategoryMapping.swift), built from production's codes.
 */
export type BankCategoryTarget = Readonly<{ parent: string; child?: string }>;

export const DETAILED_BANK_CATEGORIES: Readonly<
  Record<string, BankCategoryTarget>
> = {
  BANK_FEES_ATM_FEES: { parent: "Fees & Charges", child: "ATM Fees" },
  BANK_FEES_FOREIGN_TRANSACTION_FEES: {
    parent: "Fees & Charges",
    child: "Foreign Transaction",
  },
  BANK_FEES_OVERDRAFT_FEES: { parent: "Fees & Charges", child: "Overdraft" },
  BANK_FEES_LATE_PAYMENT: { parent: "Fees & Charges", child: "Late Fee" },
  ENTERTAINMENT_TV_AND_MOVIES: { parent: "Entertainment", child: "Movies" },
  ENTERTAINMENT_VIDEO_GAMES: { parent: "Entertainment", child: "Games" },
  ENTERTAINMENT_MUSIC_AND_AUDIO: {
    parent: "Entertainment",
    child: "Streaming",
  },
  ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS: {
    parent: "Entertainment",
    child: "Sports",
  },
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: {
    parent: "Food & Drink",
    child: "Alcohol & Bars",
  },
  FOOD_AND_DRINK_COFFEE: { parent: "Food & Drink", child: "Coffee Shops" },
  FOOD_AND_DRINK_FAST_FOOD: { parent: "Food & Drink", child: "Fast Food" },
  FOOD_AND_DRINK_GROCERIES: { parent: "Food & Drink", child: "Groceries" },
  FOOD_AND_DRINK_RESTAURANT: { parent: "Food & Drink", child: "Restaurants" },
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: {
    parent: "Shopping",
    child: "Clothing",
  },
  GENERAL_MERCHANDISE_ELECTRONICS: { parent: "Shopping", child: "Electronics" },
  GENERAL_MERCHANDISE_DEPARTMENT_STORES: {
    parent: "Shopping",
    child: "General Merchandise",
  },
  GENERAL_MERCHANDISE_SUPERSTORES: {
    parent: "Shopping",
    child: "General Merchandise",
  },
  GENERAL_MERCHANDISE_OFFICE_SUPPLIES: {
    parent: "Shopping",
    child: "General Merchandise",
  },
  GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE: {
    parent: "Shopping",
    child: "General Merchandise",
  },
  GENERAL_MERCHANDISE_SPORTING_GOODS: { parent: "Shopping", child: "Hobbies" },
  GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: {
    parent: "Gifts & Donations",
    child: "Gifts",
  },
  GENERAL_SERVICES_AUTOMOTIVE: {
    parent: "Transportation",
    child: "Car Maintenance",
  },
  GENERAL_SERVICES_EDUCATION: { parent: "Education" },
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: {
    parent: "Gifts & Donations",
    child: "Charity",
  },
  GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT: { parent: "Taxes" },
  HOME_IMPROVEMENT_HARDWARE: { parent: "Housing", child: "Home Improvement" },
  INCOME_DIVIDENDS: { parent: "Income", child: "Dividends" },
  INCOME_INTEREST_EARNED: { parent: "Income", child: "Interest" },
  INCOME_WAGES: { parent: "Income", child: "Paycheck" },
  LOAN_PAYMENTS_CAR_PAYMENT: { parent: "Transportation", child: "Car Payment" },
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: {
    parent: "Debt Payments",
    child: "Credit Card Payment",
  },
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: { parent: "Housing", child: "Mortgage" },
  LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT: {
    parent: "Debt Payments",
    child: "Personal Loan",
  },
  LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT: {
    parent: "Debt Payments",
    child: "Student Loan",
  },
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS: {
    parent: "Health & Wellness",
    child: "Pharmacy",
  },
  MEDICAL_DENTAL_CARE: { parent: "Health & Wellness", child: "Dentist" },
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: {
    parent: "Health & Wellness",
    child: "Gym",
  },
  PERSONAL_CARE_HAIR_AND_BEAUTY: { parent: "Personal", child: "Beauty" },
  PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING: {
    parent: "Personal",
    child: "Laundry",
  },
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: {
    parent: "Bills & Utilities",
    child: "Electricity",
  },
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: {
    parent: "Bills & Utilities",
    child: "Internet",
  },
  RENT_AND_UTILITIES_RENT: { parent: "Housing", child: "Rent" },
  RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT: {
    parent: "Bills & Utilities",
    child: "Trash",
  },
  RENT_AND_UTILITIES_TELEPHONE: { parent: "Bills & Utilities", child: "Phone" },
  RENT_AND_UTILITIES_WATER: { parent: "Bills & Utilities", child: "Water" },
  TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS: {
    parent: "Savings & Investments",
  },
  TRANSPORTATION_GAS: { parent: "Transportation", child: "Gas" },
  TRANSPORTATION_PARKING: { parent: "Transportation", child: "Parking" },
  TRANSPORTATION_PUBLIC_TRANSIT: {
    parent: "Transportation",
    child: "Public Transit",
  },
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: {
    parent: "Transportation",
    child: "Rideshare",
  },
  TRAVEL_FLIGHTS: { parent: "Travel", child: "Flights" },
  TRAVEL_LODGING: { parent: "Travel", child: "Lodging" },
};

export const PRIMARY_BANK_CATEGORIES: Readonly<
  Record<string, BankCategoryTarget>
> = {
  BANK_FEES: { parent: "Fees & Charges" },
  ENTERTAINMENT: { parent: "Entertainment" },
  FOOD_AND_DRINK: { parent: "Food & Drink" },
  GENERAL_MERCHANDISE: { parent: "Shopping" },
  HOME_IMPROVEMENT: { parent: "Housing", child: "Home Improvement" },
  INCOME: { parent: "Income" },
  LOAN_PAYMENTS: { parent: "Debt Payments" },
  MEDICAL: { parent: "Health & Wellness" },
  PERSONAL_CARE: { parent: "Personal" },
  RENT_AND_UTILITIES: { parent: "Bills & Utilities" },
  TRANSFER_IN: { parent: "Transfer" },
  TRANSFER_OUT: { parent: "Transfer" },
  TRANSPORTATION: { parent: "Transportation" },
  TRAVEL: { parent: "Travel" },
};

export function bankCategoryTarget(
  primary: string | null | undefined,
  detailed: string | null | undefined,
): BankCategoryTarget | null {
  if (detailed && DETAILED_BANK_CATEGORIES[detailed])
    return DETAILED_BANK_CATEGORIES[detailed];
  if (primary && PRIMARY_BANK_CATEGORIES[primary])
    return PRIMARY_BANK_CATEGORIES[primary];
  return null;
}
