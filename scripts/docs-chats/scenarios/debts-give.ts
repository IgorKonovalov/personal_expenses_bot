import { say, scenario, tap } from '../scenario.js';

export default scenario('debts-give', { chat: 'private', now: '2026-09-15T10:30:00Z' }, [
  say('/debts'),
  tap('Я дал в долг'),
]);
