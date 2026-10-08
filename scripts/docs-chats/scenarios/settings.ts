import { say, scenario } from '../scenario.js';

export default scenario('settings', { chat: 'private', now: '2026-09-15T10:30:00Z' }, [
  say('/settings'),
]);
