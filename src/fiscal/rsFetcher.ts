import {
  parseRsSpecifications,
  parseRsToken,
  parseRsVerify,
} from '../domain/receipts/rsResponse.js';
import type { FetchFailure, FetchOutcome, ReceiptFetcher } from '../services/fetchDueReceipt.js';

// The bot names itself honestly to the tax sites (Plan 0014 risks: rate limiting).
export const USER_AGENT = 'personal-expenses-bot (receipt line items for its own user)';

export type Fetch = typeof fetch;

type TextResult =
  | { readonly kind: 'ok'; readonly body: string }
  | { readonly kind: 'failed'; readonly reason: FetchFailure };

// One request's body as text. A non-2xx status, an empty body, a network error or the abort
// signal firing (the worker's timeout) is a failure; the URL never reaches the result.
export async function requestText(
  fetchImpl: Fetch,
  url: string,
  init: { readonly method?: string; readonly accept: string; readonly form?: URLSearchParams },
  signal: AbortSignal,
): Promise<TextResult> {
  try {
    const response = await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: {
        Accept: init.accept,
        'User-Agent': USER_AGENT,
        ...(init.form === undefined
          ? {}
          : { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }),
      },
      ...(init.form === undefined ? {} : { body: init.form.toString() }),
      signal,
    });
    if (!response.ok) return { kind: 'failed', reason: 'http' };
    const body = await response.text();
    return body.trim() === '' ? { kind: 'failed', reason: 'empty' } : { kind: 'ok', body };
  } catch {
    return { kind: 'failed', reason: signal.aborted ? 'timeout' : 'network' };
  }
}

const SPECIFICATIONS_URL = 'https://suf.purs.gov.rs/specifications';

// Serbia: the verify URL as JSON (shop and total), the verify page's HTML for its token, then the
// `/specifications` POST for the items.
export function createRsFetcher(fetchImpl: Fetch = fetch): ReceiptFetcher {
  return async ({ verifyUrl }, signal): Promise<FetchOutcome> => {
    const verify = await requestText(fetchImpl, verifyUrl, { accept: 'application/json' }, signal);
    if (verify.kind === 'failed') return verify;
    const header = parseRsVerify(verify.body);
    if (header === undefined) return { kind: 'failed', reason: 'unparseable' };

    const page = await requestText(fetchImpl, verifyUrl, { accept: 'text/html' }, signal);
    if (page.kind === 'failed') return page;
    const token = parseRsToken(page.body);
    if (token === undefined) return { kind: 'failed', reason: 'unparseable' };

    const specifications = await requestText(
      fetchImpl,
      SPECIFICATIONS_URL,
      {
        method: 'POST',
        accept: 'application/json',
        form: new URLSearchParams({ invoiceNumber: header.invoiceNumber, token }),
      },
      signal,
    );
    if (specifications.kind === 'failed') return specifications;
    const items = parseRsSpecifications(specifications.body);
    if (items === undefined) return { kind: 'failed', reason: 'unparseable' };

    return {
      kind: 'fetched',
      receipt: { sellerName: header.sellerName, totalMinor: header.totalMinor, items },
    };
  };
}
