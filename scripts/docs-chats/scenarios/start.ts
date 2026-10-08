import { say, scenario, tap } from '../scenario.js';

export default scenario(
  'start',
  { chat: 'private', onboarding: true, now: '2026-09-15T10:30:00Z' },
  [say('/start'), tap('Да, всё верно')],
);
