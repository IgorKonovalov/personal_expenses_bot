import { say, scenario, tap } from '../scenario.js';

export default scenario('tags', { chat: 'private', now: '2026-09-15T10:30:00Z' }, [
  say('/tag отпуск'),
  say('450 кофе'),
  say('3200 ужин'),
  say('/tags'),
  tap('#отпуск'),
]);
