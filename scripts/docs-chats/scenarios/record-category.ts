import { say, scenario, tap } from '../scenario.js';

export default scenario('record-category', { chat: 'private', now: '2026-09-15T10:30:00Z' }, [
  say('900 подарок'),
  tap('Категория'),
]);
