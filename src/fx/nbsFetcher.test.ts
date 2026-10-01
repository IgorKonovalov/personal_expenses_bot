import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LocalDate } from '../domain/time.js';
import { createNbsFetcher, type Fetch } from './nbsFetcher.js';

// Trimmed from the real NBS pages for 2026-09-28 (list 184).
const fixture = (name: string) =>
  readFileSync(new URL(`./testing/${name}`, import.meta.url), 'utf8');
const INDEX = fixture('nbs-index-2026-09-28.html');
const INDEX_NO_XML = fixture('nbs-index-no-xml.html');
const LIST = fixture('nbs-list-184.xml');
const LIST_BAD_RATE = fixture('nbs-list-bad-rate.xml');

const XML_URL =
  'https://webappcenter.nbs.rs/ExchangeRateWebApp/ExchangeRate/Download?ExchangeRateListID=8d81a4b5-e5cc-4557-8eaa-bf228b6c4eee&ExchangeRateListTypeName=srednjiKurs&Format=xml';

function fakeFetch(index: string, list: string, seen: string[] = []): Fetch {
  return (input) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    return Promise.resolve(new Response(url.includes('/IndexByDate?') ? index : list));
  };
}

const DAY = '2026-09-28' as LocalDate;
const signal = () => new AbortController().signal;

describe('createNbsFetcher', () => {
  it('reads list 184 of 2026-09-28, keeping only the codes in our currency table', async () => {
    const seen: string[] = [];
    const outcome = await createNbsFetcher(fakeFetch(INDEX, LIST, seen))(DAY, signal());
    expect(seen).toEqual([
      'https://webappcenter.nbs.rs/ExchangeRateWebApp/ExchangeRate/IndexByDate?isSearchExecuted=true&Date=28.09.2026&ExchangeRateListTypeID=3',
      XML_URL,
    ]);
    expect(outcome).toEqual({
      kind: 'fetched',
      list: {
        listDate: '2026-09-28',
        listNumber: 184,
        // AUD is on the list but not in our table.
        rates: [
          { currency: 'EUR', unit: 1, middleE4: 1174993 },
          { currency: 'HUF', unit: 100, middleE4: 320756 },
          { currency: 'JPY', unit: 100, middleE4: 654009 },
          { currency: 'USD', unit: 1, middleE4: 1031782 },
        ],
      },
    });
  });

  it('fails the whole list when one middle rate is not four-decimal', async () => {
    const outcome = await createNbsFetcher(fakeFetch(INDEX, LIST_BAD_RATE))(DAY, signal());
    expect(outcome).toEqual({ kind: 'failed', reason: 'unparseable' });
  });

  it('fails a page with no XML link, rather than returning an empty list', async () => {
    const seen: string[] = [];
    const outcome = await createNbsFetcher(fakeFetch(INDEX_NO_XML, LIST, seen))(DAY, signal());
    expect(outcome).toEqual({ kind: 'failed', reason: 'unparseable' });
    expect(seen).toHaveLength(1);
  });

  it('fails a list with a unit that is not a positive integer', async () => {
    const list = LIST.replace('<Unit>100</Unit>', '<Unit>0</Unit>');
    const outcome = await createNbsFetcher(fakeFetch(INDEX, list))(DAY, signal());
    expect(outcome).toEqual({ kind: 'failed', reason: 'unparseable' });
  });

  it.each<[string, () => Response | Promise<Response>, string]>([
    ['a non-2xx status', () => new Response('x', { status: 503 }), 'http'],
    ['an empty body', () => new Response(''), 'empty'],
    ['a network error', () => Promise.reject(new TypeError('fetch failed')), 'network'],
  ])('reports %s as %s', async (_, answer, reason) => {
    const outcome = await createNbsFetcher(async () => answer())(DAY, signal());
    expect(outcome).toEqual({ kind: 'failed', reason });
  });
});
