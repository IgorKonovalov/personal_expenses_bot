import { cut, say, scenario } from '../scenario.js';

export default scenario('totals', { chat: 'private', webapp: true, now: '2026-09-15T10:30:00Z' }, [
  say('450 кофе'),
  say('2300 продукты'),
  say('1200 такси'),
  cut(),
  say('/today'),
  say('/month'),
]);
