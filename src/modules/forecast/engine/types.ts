export type ForecastInputEvent = Readonly<{
  date: string;
  amountCents: bigint;
  name: string;
  confidence: number;
  sourceType: "recurring" | "manual" | "pending_transaction";
  sourceId?: string;
  recurringSeriesId?: string | null;
}>;

export type ForecastInput = Readonly<{
  today: string;
  horizonDays: number;
  startingBalanceCents: bigint;
  events: ForecastInputEvent[];
  discretionaryDailyAvgCents: bigint;
}>;

export type DayForecast = Readonly<{
  date: string;
  p50Cents: bigint;
  p10Cents: bigint;
  p90Cents: bigint;
  events: ForecastInputEvent[];
}>;

export type ForecastResult = Readonly<{
  days: DayForecast[];
  tightestDay: Readonly<{ date: string; balanceCents: bigint }>;
  algorithmVersion: "v1";
}>;

export type ForecastWireEvent = Readonly<{
  name: string;
  amountCents: string;
  confidence: number;
  sourceType: "recurring" | "manual" | "pending_transaction";
  sourceId?: string;
  recurringSeriesId?: string | null;
}>;

export type ForecastWireDay = Readonly<{
  date: string;
  p50Cents: string;
  p10Cents: string;
  p90Cents: string;
  events: ForecastWireEvent[];
}>;

/** Serialized day shape used by scenario transforms. */
export type ForecastDay = ForecastWireDay;
