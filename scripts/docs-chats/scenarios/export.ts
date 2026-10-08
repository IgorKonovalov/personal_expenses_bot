import { say, scenario, tap } from '../scenario.js';

export default scenario('export', { chat: 'private', now: '2026-09-15T10:30:00Z' }, [
  say('450 кофе'),
  say('/export'),
  tap('Этот месяц'),
  tap('CSV'),
]);
