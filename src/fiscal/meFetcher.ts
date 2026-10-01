import { parseMeVerify } from '../domain/receipts/meResponse.js';
import type { FetchOutcome, ReceiptFetcher } from '../services/fetchDueReceipt.js';
import { requestText, type Fetch } from './rsFetcher.js';

const VERIFY_INVOICE_URL = 'https://mapr.tax.gov.me/ic/api/verifyInvoice';

// Montenegro: one `verifyInvoice` POST with the iic, the creation instant and the seller's tin,
// read back from the stored verify URL's hash fragment.
export function createMeFetcher(fetchImpl: Fetch = fetch): ReceiptFetcher {
  return async ({ verifyUrl }, signal): Promise<FetchOutcome> => {
    const hash = new URL(verifyUrl).hash;
    const params = new URLSearchParams(hash.slice(hash.indexOf('?') + 1));
    const iic = params.get('iic');
    const crtd = params.get('crtd');
    const tin = params.get('tin');
    if (iic === null || crtd === null || tin === null) {
      return { kind: 'failed', reason: 'unparseable' };
    }

    const response = await requestText(
      fetchImpl,
      VERIFY_INVOICE_URL,
      {
        method: 'POST',
        accept: 'application/json',
        form: new URLSearchParams({ iic, dateTimeCreated: crtd, tin }),
      },
      signal,
    );
    if (response.kind === 'failed') return response;
    const receipt = parseMeVerify(response.body);
    return receipt === undefined
      ? { kind: 'failed', reason: 'unparseable' }
      : { kind: 'fetched', receipt };
  };
}
