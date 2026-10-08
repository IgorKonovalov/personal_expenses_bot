import { say, scenario, tap } from '../scenario.js';

export default scenario(
  'group',
  { chat: 'group', members: ['Анна', 'Борис'], now: '2026-09-15T10:30:00Z' },
  [
    say('450 кафе', { from: 'Анна' }),
    say('Чайник 3200', { from: 'Борис' }),
    tap('Записать', { from: 'Борис' }),
    say('/month', { from: 'Анна' }),
    say('/settle', { from: 'Анна' }),
  ],
);
