import { ASCTIME, IMF, MONTHS, RFC850 } from "../config/probe.ts";

export function httpDateMs(header: string | null): number | null {
  if (header == null) return null;
  const value = header.trim();
  const imf = IMF.exec(value);
  if (imf)
    return utcDate(
      Number(imf[3]),
      MONTHS[imf[2]],
      Number(imf[1]),
      Number(imf[4]),
      Number(imf[5]),
      Number(imf[6]),
    );
  const rfc = RFC850.exec(value);
  if (rfc) {
    const year = Number(rfc[3]);
    return utcDate(
      year >= 70 ? 1900 + year : 2000 + year,
      MONTHS[rfc[2]],
      Number(rfc[1]),
      Number(rfc[4]),
      Number(rfc[5]),
      Number(rfc[6]),
    );
  }
  const asctime = ASCTIME.exec(value);
  if (asctime) {
    return utcDate(
      Number(asctime[6]),
      MONTHS[asctime[1]],
      Number(asctime[2]),
      Number(asctime[3]),
      Number(asctime[4]),
      Number(asctime[5]),
    );
  }
  return null;
}

function utcDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | null {
  if (month == null || hour > 23 || minute > 59 || second > 59 || day < 1) return null;
  const ms = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(ms);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    return null;
  return ms;
}
