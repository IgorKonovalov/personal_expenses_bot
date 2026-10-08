import { say, scenario, tap } from '../scenario.js';

export default scenario('recurring', { chat: 'private', now: '2026-09-15T10:30:00Z' }, [
  say('35000 аренда'),
  tap('Повторять'),
  tap('Каждый месяц, 15-го'),
  say('/recurring'),
]);
