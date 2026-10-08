import { buildKoriscenjeSms } from '../../../src/domain/bankSms/testing/buildKoriscenjeSms.js';
import { say, scenario } from '../scenario.js';

// A made-up card, merchant and balance.
const sms = buildKoriscenjeSms({
  datum: '15.09.2026 12:05:00',
  iznos: '1.480,00 RSD',
  raspolozivo: '52.300,00 RSD',
  mesto: 'PEKARA PRIMER BEOGRAD RS',
});

export default scenario('sms', { chat: 'private', now: '2026-09-15T10:30:00Z' }, [say(sms)]);
