import { say, scenario } from '../scenario.js';

export default scenario('debts-split', { chat: 'private', now: '2026-09-15T10:30:00Z' }, [
  say('1000 кафе /3'),
]);
