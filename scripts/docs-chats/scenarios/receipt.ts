import { buildRsUrl } from '../../../src/domain/receipts/testing/buildRsVl.js';
import { say, scenario } from '../scenario.js';

// A synthetic receipt: its signature and data are filler bytes, and its total is made up.
const link = buildRsUrl({ rawTotal: 18_740_000n, issuedMs: Date.parse('2026-09-15T09:12:00Z') });

export default scenario('receipt', { chat: 'private', now: '2026-09-15T10:30:00Z' }, [
  say(link, { shown: 'https://suf.purs.gov.rs/v/?vl=…' }),
  say(link, { shown: 'https://suf.purs.gov.rs/v/?vl=…' }),
]);
