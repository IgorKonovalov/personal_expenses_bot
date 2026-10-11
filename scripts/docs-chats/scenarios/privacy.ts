import { say, scenario, tap } from '../scenario.js';

export default scenario('privacy', { chat: 'private', now: '2026-09-15T10:30:00Z' }, [
  say('/settings'),
  tap('Аккаунт и данные'),
  tap('Приватность'),
]);
