import { Config, Option, Schema } from "effect";

const minute = 60_000;
const day = 24 * 60 * minute;

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatter = (timeZone: string) => {
  const cached = formatters.get(timeZone);

  if (cached !== undefined) {
    return cached;
  }

  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });

  formatters.set(timeZone, created);

  return created;
};

const knownZone = (timeZone: string) => {
  if (/^[+-]/.test(timeZone)) {
    return false;
  }

  try {
    formatter(timeZone);

    return true;
  } catch {
    return false;
  }
};

const ClockTime = Schema.String.check(
  Schema.makeFilter(
    (time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time) || "Use a 24-hour HH:MM time, such as 07:30.",
  ),
);

export const QuietHours = Schema.Struct({
  start: ClockTime,
  end: ClockTime,
  timeZone: Schema.String.check(
    Schema.makeFilter(
      (zone) => knownZone(zone) || "Use an IANA time zone name, such as Europe/London.",
    ),
  ),
}).check(
  Schema.makeFilter(
    (window) => window.start !== window.end || "Use different quiet-hours start and end times.",
  ),
);

export type QuietHours = typeof QuietHours.Type;

export const quietHours = Config.schema(Schema.fromJsonString(QuietHours), "quietHours").pipe(
  Config.option,
  Config.map(Option.getOrNull),
);

// The zone's wall-clock reading at an instant, expressed as a UTC timestamp.
const wall = (at: number, timeZone: string) => {
  const parts = new Map(
    formatter(timeZone)
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  );

  return Date.UTC(
    parts.get("year")!,
    parts.get("month")! - 1,
    parts.get("day"),
    parts.get("hour"),
    parts.get("minute"),
    parts.get("second"),
  );
};

const offset = (at: number, timeZone: string) => wall(at, timeZone) - Math.floor(at / 1000) * 1000;

// The first instant at which the zone's clock reads `local` or later. A skipped
// time resolves to the end of the gap; a repeated time resolves to its first occurrence.
const resolve = (local: number, timeZone: string) => {
  const candidates = [local - day, local + day].map((at) => local - offset(at, timeZone));
  const exact = candidates.filter((at) => wall(at, timeZone) === local);

  if (exact.length > 0) {
    return Math.min(...exact);
  }

  let low = Math.min(...candidates);
  let high = Math.max(...candidates);

  while (high - low > 1000) {
    const middle = low + Math.floor((high - low) / 2000) * 1000;

    if (wall(middle, timeZone) >= local) {
      high = middle;
    } else {
      low = middle;
    }
  }

  return high;
};

const clockOffset = (time: string) =>
  (Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))) * minute;

/** When `at` falls inside a quiet window, returns the instant the window ends; otherwise null. */
export const quietHoursEnd = (window: QuietHours, at: number): number | null => {
  const start = clockOffset(window.start);
  const end = clockOffset(window.end) + (window.end < window.start ? day : 0);
  const today = Math.floor(wall(at, window.timeZone) / day) * day;

  for (const date of [today - day, today]) {
    const until = resolve(date + end, window.timeZone);

    if (resolve(date + start, window.timeZone) <= at && at < until) {
      return until;
    }
  }

  return null;
};
