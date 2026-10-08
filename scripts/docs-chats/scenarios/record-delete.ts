import { say, scenario, tap } from '../scenario.js';

export default scenario('record-delete', { chat: 'private', now: '2026-09-15T10:30:00Z' }, [
  say('450 кофе'),
  tap('Удалить'),
]);
