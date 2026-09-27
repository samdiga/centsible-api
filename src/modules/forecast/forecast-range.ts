/** Calendar ranges start today and include the last day of the target month. */
export function calendarForecastRange(today: string, monthOffset: number) {
  const [year, month] = today.split("-").map(Number);
  const endDate = new Date(Date.UTC(year!, month! + monthOffset, 0))
    .toISOString()
    .slice(0, 10);
  const horizonDays =
    Math.round((Date.parse(endDate) - Date.parse(today)) / 86_400_000) + 1;
  return { endDate, horizonDays };
}
