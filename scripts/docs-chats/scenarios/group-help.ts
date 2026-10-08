import { cut, say, scenario } from '../scenario.js';

export default scenario(
  'group-help',
  { chat: 'group', members: ['Анна', 'Борис'], now: '2026-09-15T10:30:00Z' },
  [cut(), say('/help', { from: 'Борис' })],
);
