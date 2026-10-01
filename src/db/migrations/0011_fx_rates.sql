-- NBS middle rate lists (ADR-0022). Public data: nothing here is private.

-- One NBS list, keyed by its own date.
CREATE TABLE fx_lists (
  list_date TEXT PRIMARY KEY,
  list_number INTEGER NOT NULL,
  fetched_at TEXT NOT NULL
);

-- A list's rates for the codes in our currency table: RSD per `unit` units, times 10^4.
CREATE TABLE fx_rates (
  list_date TEXT NOT NULL REFERENCES fx_lists(list_date),
  currency TEXT NOT NULL,
  unit INTEGER NOT NULL CHECK (unit > 0),
  middle_e4 INTEGER NOT NULL CHECK (middle_e4 > 0),
  PRIMARY KEY (list_date, currency)
);

-- The list in force on each calendar day. A row fetched on or before its own Belgrade day is
-- fetched again: that day's list may not have been out yet.
CREATE TABLE fx_days (
  day TEXT PRIMARY KEY,
  list_date TEXT NOT NULL REFERENCES fx_lists(list_date),
  fetched_at TEXT NOT NULL
);
