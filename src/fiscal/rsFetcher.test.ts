import { describe, expect, it } from 'vitest';
import { createRsFetcher, USER_AGENT, type Fetch } from './rsFetcher.js';

// Synthetic SUF answers; the injected fetch serves them, so nothing reaches the network.
const VERIFY_URL = 'https://suf.purs.gov.rs/v/?vl=synthetic';
const VERIFY_JSON = `{"invoiceRequest":{"businessName":"Test DOO","locationName":"Test Prodavnica"},"invoiceResult":{"invoiceNumber":"AAAA1111-AAAA1111-16898","totalAmount":829.12}}`;
const VERIFY_HTML = "<html><script>viewModel.Token('tok-1');</script></html>";
const SPECIFICATIONS = `{"success":true,"items":[{"name":"Hleb","quantity":0.535,"total":799.99},{"name":"Kesa","quantity":1,"total":29.13}]}`;

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly accept: string | null;
  readonly userAgent: string | null;
  readonly body: string | null;
}

function fakeFetch(answer: (seen: Seen) => Response, seen: Seen[] = []): Fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    const request: Seen = {
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? 'GET',
      accept: headers.get('Accept'),
      userAgent: headers.get('User-Agent'),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    seen.push(request);
    return Promise.resolve(answer(request));
  };
}

function suf(seen: Seen): Response {
  if (seen.url === VERIFY_URL && seen.accept === 'application/json')
    return new Response(VERIFY_JSON);
  if (seen.url === VERIFY_URL) return new Response(VERIFY_HTML);
  return new Response(SPECIFICATIONS);
}

const signal = () => new AbortController().signal;

describe('createRsFetcher', () => {
  it('reads the shop and total, then the token, then the items', async () => {
    const seen: Seen[] = [];
    const fetcher = createRsFetcher(fakeFetch(suf, seen));

    const outcome = await fetcher({ verifyUrl: VERIFY_URL, fiscalId: 'x' }, signal());

    expect(outcome).toEqual({
      kind: 'fetched',
      receipt: {
        sellerName: 'Test Prodavnica',
        totalMinor: 82912,
        items: [
          { name: 'Hleb', quantity: '0.535', totalMinor: 79999 },
          { name: 'Kesa', quantity: '1', totalMinor: 2913 },
        ],
      },
    });
    expect(seen.map(({ url, method, accept }) => ({ url, method, accept }))).toEqual([
      { url: VERIFY_URL, method: 'GET', accept: 'application/json' },
      { url: VERIFY_URL, method: 'GET', accept: 'text/html' },
      { url: 'https://suf.purs.gov.rs/specifications', method: 'POST', accept: 'application/json' },
    ]);
    expect(seen[2]?.body).toBe('invoiceNumber=AAAA1111-AAAA1111-16898&token=tok-1');
    expect(seen.every((s) => s.userAgent === USER_AGENT)).toBe(true);
  });

  it.each([
    ['a non-2xx status', () => new Response('x', { status: 503 }), 'http'],
    ['an empty body', () => new Response(''), 'empty'],
    ['an unparseable body', () => new Response('<html>maintenance</html>'), 'unparseable'],
  ] as const)('fails on %s', async (_name, answer, reason) => {
    const fetcher = createRsFetcher(fakeFetch(answer));

    expect(await fetcher({ verifyUrl: VERIFY_URL, fiscalId: 'x' }, signal())).toEqual({
      kind: 'failed',
      reason,
    });
  });

  it('fails as unparseable when an item total has three fraction digits', async () => {
    const fetcher = createRsFetcher(
      fakeFetch((seen) =>
        seen.method === 'POST'
          ? new Response(SPECIFICATIONS.replace('799.99', '1.005'))
          : suf(seen),
      ),
    );

    expect(await fetcher({ verifyUrl: VERIFY_URL, fiscalId: 'x' }, signal())).toEqual({
      kind: 'failed',
      reason: 'unparseable',
    });
  });

  it('fails as a timeout when the signal aborts', async () => {
    const controller = new AbortController();
    const fetcher = createRsFetcher(() => {
      controller.abort();
      return Promise.reject(new DOMException('This operation was aborted', 'AbortError'));
    });

    expect(await fetcher({ verifyUrl: VERIFY_URL, fiscalId: 'x' }, controller.signal)).toEqual({
      kind: 'failed',
      reason: 'timeout',
    });
  });
});
