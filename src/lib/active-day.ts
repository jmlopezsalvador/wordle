const MADRID_TZ = "Europe/Madrid";
const DAY_CHANGE_HOUR = 6;

function ymdFromUtcDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function addDaysToIsoDay(isoDay: string, days: number) {
  const d = new Date(`${isoDay}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return ymdFromUtcDate(d);
}

function getMadridNowParts(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MADRID_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return {
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour") || 0)
  };
}

export function getActiveDayISO(now = new Date()) {
  const { ymd, hour } = getMadridNowParts(now);
  if (hour < DAY_CHANGE_HOUR) {
    return addDaysToIsoDay(ymd, -1);
  }
  return ymd;
}

export function getLastClosedDayISO(now = new Date()) {
  return addDaysToIsoDay(getActiveDayISO(now), -1);
}

