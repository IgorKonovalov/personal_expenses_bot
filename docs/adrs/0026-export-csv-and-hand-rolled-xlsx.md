# ADR-0026: Export writes CSV and a hand-rolled XLSX, with no spreadsheet dependency

> **Status:** proposed
> **Date:** 2026-10-01
> **Related plan(s):** Plan 0024 ([0024-export-and-data-ownership.md](../plans/0024-export-and-data-ownership.md))

## Context

`/export` (Plan 0024) promises that a user can take all their data out in a form they can open on
a phone. Most users open a file from Telegram on a phone, in Excel, Google Sheets or Numbers. CSV
opens there too, but it has no encoding or delimiter metadata. Excel in a Russian or Serbian locale
expects `;` and a decimal comma, and it reads a UTF-8 file without a BOM as Cyrillic garbage.
Line items also don't fit one CSV: a receipt's items are a second table.

XLSX fixes all of that: typed cells, any number of sheets, and no locale guessing. But
the format is a zip of XML parts. The usual libraries (SheetJS, exceljs) are large, and each adds
a transitive tree that ADR-0001's dependency rule counts as a cost. SheetJS also left the npm
registry, so its current versions install from a vendor URL.

Node 24 ships everything a minimal writer needs: `zlib.deflateRawSync` for the entries and
`zlib.crc32` for the zip checksums. The parts we need are a fixed set: content types, two rels
files, the workbook, a stylesheet and one worksheet per table. Cells are inline strings and plain
numbers, with no shared-strings table, formulas, merged cells or charts.

## Decision

We offer both formats. CSV is UTF-8 with a BOM, `;` as the separator, a decimal comma, CRLF line
ends and RFC 4180 quoting. The expenses and the receipt items are two files. XLSX is one workbook
with an expenses sheet and an items sheet, written by our own module in `src/domain/export/`. That
module covers a zip writer (deflate, CRC-32, a central directory) and an XLSX writer over it
(inline-string and numeric cells, one number style per currency exponent). Both writers are pure:
rows in, bytes out. Amounts reach both formats as exact decimal strings rendered from minor units
by the money module. No float ever holds an amount, even though the spreadsheet reads the cell
as a double.

## Consequences

### Positive
- No new dependency, no supply-chain surface, and no install-size cost on the 256 MiB VPS.
- The writer emits only what the export needs, so it is small enough to read in a review and to
  test byte-for-byte.
- XLSX sidesteps CSV's locale traps for most users. CSV remains for everything else.

### Negative
- We own a file-format writer. A spreadsheet app that rejects our output is our bug to find, and
  only a human opening the file in real apps finds it (Plan 0024's last phase).
- Zip64 is out of scope: the writer refuses output past 4 GiB, far beyond any ledger.
- Every future spreadsheet feature (frozen header, column widths, a totals row) is code we write,
  not an option we set.
- The CSV defaults (`;` and a decimal comma) suit Excel in the ru/sr locales and need an import
  step in an English-locale Google Sheets. That is a guess about the audience.

## Alternatives considered

### Alternative A: CSV only
This needs no writer at all. It lost because two tables need two files that a phone user must keep
together, and because Excel's locale handling makes a CSV's first impression on a phone a gamble.

### Alternative B: a spreadsheet library (SheetJS or exceljs)
These give correct XLSX with many features we'd never use. They lost on cost: a dependency tree in
the hundreds of kilobytes to megabytes, for output that uses two cell types. SheetJS also
installs from outside the npm registry, which our release-age cooldown can't vet.
