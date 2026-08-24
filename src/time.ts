export function nowIso(clock: () => Date): string {
  return clock().toISOString();
}

export function localDate(timezone: string, instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);

  const part = (type: "year" | "month" | "day"): string => {
    const found = parts.find((p) => p.type === type);
    if (found === undefined) {
      throw new Error(`Intl returned no ${type} part for time zone ${timezone}`);
    }
    return found.value;
  };

  return `${part("year")}-${part("month")}-${part("day")}`;
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = LOCAL_DATE.exec(value);
  if (match === null) return false;

  const [, year, month, day] = match as unknown as [string, string, string, string];
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1) return false;

  // Day 0 of month m + 1 is the last day of month m. Months are zero-based here.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= lastDay;
}
