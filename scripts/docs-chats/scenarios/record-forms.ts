import { say, scenario } from '../scenario.js';

export default scenario('record-forms', { chat: 'private', now: '2026-09-15T10:30:00Z' }, [
  say('12,50 EUR такси'),
  say('Чайник 3200'),
  say('45к шкаф'),
  say('450 такси вчера'),
]);
