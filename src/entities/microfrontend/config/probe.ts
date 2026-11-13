// Manifest requests in the proved 2.9.1 path use a 10s timeout.
export const REQUEST_TIMEOUT_MS = 10_000;

export const REQUEST_CONCURRENCY = 8;

export const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

const WEEKDAY = "Mon|Tue|Wed|Thu|Fri|Sat|Sun";

const WEEKDAY_LONG = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday";

const MONTH = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";

export const IMF = new RegExp(
  `^(?:${WEEKDAY}), (\\d{2}) (${MONTH}) (\\d{4}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`,
);

export const RFC850 = new RegExp(
  `^(?:${WEEKDAY_LONG}), (\\d{2})-(${MONTH})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`,
);

export const ASCTIME = new RegExp(
  `^(?:${WEEKDAY}) (${MONTH}) ([ \\d]\\d) (\\d{2}):(\\d{2}):(\\d{2}) (\\d{4})$`,
);
