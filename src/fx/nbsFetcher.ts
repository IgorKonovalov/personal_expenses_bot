import type { FxRate } from '../db/fxRates.js';
import { toCurrencyCode } from '../domain/currencies.js';
import { parseRateE4 } from '../domain/fx.js';
import { parseLocalDate, type LocalDate } from '../domain/time.js';
import type { RateListFailure, RateListFetcher, RateListOutcome } from '../services/fetchRates.js';

// The NBS middle rate list in force on a date (ADR-0022): the IndexByDate page for that date
// links the list's XML download, which is read by pattern. The XML is flat (a header, then
// `<item>`s of plain text fields), so no XML parser is needed.

const ORIGIN = 'https://webappcenter.nbs.rs';
const INDEX_URL = `${ORIGIN}/ExchangeRateWebApp/ExchangeRate/IndexByDate`;
// The middle rate list type on IndexByDate.
const MIDDLE_RATE_LIST_TYPE = '3';
const TIMEOUT_MS = 10_000;
const USER_AGENT = 'personal-expenses-bot (NBS middle rates for its own reports)';

export type Fetch = typeof fetch;

export function createNbsFetcher(fetchImpl: Fetch = fetch): RateListFetcher {
  return async (day, signal): Promise<RateListOutcome> => {
    const query = new URLSearchParams({
      isSearchExecuted: 'true',
      Date: dottedDate(day),
      ExchangeRateListTypeID: MIDDLE_RATE_LIST_TYPE,
    });
    const page = await requestText(
      fetchImpl,
      `${INDEX_URL}?${query.toString()}`,
      'text/html',
      signal,
    );
    if (page.kind === 'failed') return page;
    const xmlUrl = xmlLinkOf(page.body);
    if (xmlUrl === undefined) return { kind: 'failed', reason: 'unparseable' };

    const xml = await requestText(fetchImpl, xmlUrl, 'application/xml', signal);
    if (xml.kind === 'failed') return xml;
    const list = parseNbsList(xml.body);
    return list === undefined
      ? { kind: 'failed', reason: 'unparseable' }
      : { kind: 'fetched', list };
  };
}

// The absolute URL of the page's `Download?...Format=xml` link.
export function xmlLinkOf(html: string): string | undefined {
  const href = /href="([^"]*\/Download\?[^"]*Format=xml[^"]*)"/.exec(html)?.[1];
  if (href === undefined) return undefined;
  const decoded = href.replace(/&amp;/g, '&');
  return decoded.startsWith('/') ? `${ORIGIN}${decoded}` : undefined;
}

// The list's number, date and the rates of the codes in our currency table. Undefined when the
// header is missing, there are no items, or any item lacks a currency, has a unit that isn't a
// positive integer, or a middle rate that isn't four-decimal: a list is stored whole or not at
// all.
export function parseNbsList(
  xml: string,
): { listDate: LocalDate; listNumber: number; rates: FxRate[] } | undefined {
  const header = /<header>([\s\S]*?)<\/header>/.exec(xml)?.[1];
  if (header === undefined) return undefined;
  const listNumber = positiveInteger(field(header, 'No'));
  const listDate = fromDotted(field(header, 'Date'));
  if (listNumber === undefined || listDate === undefined) return undefined;

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => match[1] ?? '');
  if (items.length === 0) return undefined;
  const rates: FxRate[] = [];
  for (const item of items) {
    const code = field(item, 'Currency');
    const unit = positiveInteger(field(item, 'Unit'));
    const middle = field(item, 'Middle_Rate');
    const middleE4 = middle === undefined ? undefined : parseRateE4(middle);
    if (code === undefined || unit === undefined || middleE4 === undefined) return undefined;
    const currency = toCurrencyCode(code);
    if (currency !== undefined) rates.push({ currency, unit, middleE4 });
  }
  return { listDate, listNumber, rates };
}

function field(block: string, name: string): string | undefined {
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)?.[1]?.trim();
}

function positiveInteger(text: string | undefined): number | undefined {
  return text !== undefined && /^[1-9]\d{0,8}$/.test(text) ? Number(text) : undefined;
}

// `28.09.2026` -> `2026-09-28`.
function fromDotted(text: string | undefined): LocalDate | undefined {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text ?? '');
  return match === null ? undefined : parseLocalDate(`${match[3]}-${match[2]}-${match[1]}`);
}

// `2026-09-28` -> `28.09.2026`.
function dottedDate(day: LocalDate): string {
  const [year, month, date] = day.split('-');
  return `${date}.${month}.${year}`;
}

type TextResult =
  | { readonly kind: 'ok'; readonly body: string }
  | { readonly kind: 'failed'; readonly reason: RateListFailure };

// One GET's body as text, bounded by TIMEOUT_MS and `signal`. A non-2xx status, an empty body
// or a network error is a failure.
async function requestText(
  fetchImpl: Fetch,
  url: string,
  accept: string,
  signal: AbortSignal,
): Promise<TextResult> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: accept, 'User-Agent': USER_AGENT },
      signal: bounded,
    });
    if (!response.ok) return { kind: 'failed', reason: 'http' };
    const body = await response.text();
    return body.trim() === '' ? { kind: 'failed', reason: 'empty' } : { kind: 'ok', body };
  } catch {
    return { kind: 'failed', reason: bounded.aborted ? 'timeout' : 'network' };
  }
}
