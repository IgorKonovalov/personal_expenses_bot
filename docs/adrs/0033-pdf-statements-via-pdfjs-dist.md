# ADR-0033: PDF statements are read with `pdfjs-dist`, imported lazily and only by the statements adapter

> **Status:** accepted (2026-10-06)
> **Date:** 2026-10-02
> **Related plan(s):** Plan 0027 ([0027-bank-statement-import.md](../plans/done/0027-bank-statement-import.md))

## Context

The bank behind Plan 0021's SMS template exports statements as PDF, XLSX and CSV, and PDF is the
default most users reach first. ADR-0001 treats every dependency as a cost: pinned, cooled down
and justified. CSV needs nothing, and XLSX reading needs only `zlib` and a small XML reader of our
own, the mirror of ADR-0026's writer. PDF is different. Text sits in compressed content streams,
drawn glyph by glyph, in subset fonts whose bytes map to Unicode only through `ToUnicode` CMaps.
Serbian Latin's `š ć č đ ž` and any Cyrillic depend on those maps. Rows have to be rebuilt from
glyph positions.

The VPS gives the container 256 MiB (Plan 0002), so a large library must not sit in memory for an
event that happens a few times a month.

## Decision

We add `pdfjs-dist` (Mozilla's PDF engine, the one Firefox uses), pinned to an exact version
under the release-age cooldown, and use its Node legacy build. It is imported with a dynamic
`import()` only inside `src/statements/pdf.ts`, when a PDF document arrives, so it never loads at
boot. The adapter returns positioned lines: text items grouped by their y-coordinate within a
tolerance, each kept as a cell with its x-coordinate, sorted by x. A pure per-bank template under
`src/domain/statements/` assigns cells to columns by the header cells' x positions and parses
them. The template's fixtures are synthetic positioned lines that follow the bank's layout with
made-up values. The adapter is tested on a synthetic PDF built in the test. A real statement is
never committed.

## Consequences

### Positive
- Real-world PDF text extraction, including subset fonts and Unicode maps, maintained by people
  who do nothing else.
- The bank-specific parsing stays pure and is tested on positioned text, with no real PDF in the
  repo.
- Normal runtime memory is unchanged. Only an import pays for the library.

### Negative
- A large install, several megabytes, in the production image and the lockfile, for one
  feature.
- A PDF import's peak memory is higher than anything else the bot does. Plan 0027 caps the file
  size and page count to bound it.
- Line reconstruction from positions is a heuristic. A layout change by the bank breaks the
  template, as it would any approach.

## Alternatives considered

### Alternative A: a hand-rolled extractor over `zlib`
No dependency. It lost because correct text needs font and CMap handling (subset fonts, Identity-H
encodings, `ToUnicode`). That's a PDF engine's core, and every gap shows up as mangled letters in
merchant names.

### Alternative B: no PDF, CSV and XLSX only
No dependency at all. It lost on the product call: PDF is the bank's default statement, and asking
users to find a different export in e-banking loses most of them.
