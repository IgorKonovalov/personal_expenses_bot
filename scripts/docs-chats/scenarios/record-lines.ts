import { say, scenario } from '../scenario.js';

export default scenario('record-lines', { chat: 'private', now: '2026-09-15T10:30:00Z' }, [
  say('450 кофе\n1200 такси\n12 eur обед'),
]);
