import { cut, say, scenario, tap } from '../scenario.js';

export default scenario('budget-set', { chat: 'private', now: '2026-09-15T10:30:00Z' }, [
  say('/budget'),
  tap('Задать лимит'),
  say('60000'),
  cut(),
  say('/budget'),
  tap('Настроить'),
]);
