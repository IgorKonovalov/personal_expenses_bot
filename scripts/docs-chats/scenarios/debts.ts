import { cut, say, scenario, tap } from '../scenario.js';

export default scenario('debts', { chat: 'private', now: '2026-09-15T10:30:00Z' }, [
  say('/debts'),
  tap('Я дал в долг'),
  say('5000'),
  say('Петя'),
  cut(),
  say('/debts'),
]);
