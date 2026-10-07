// `pnpm bench:due [users]` (Plan 0039 Phase 4): times one scheduler tick's `dueSummaries` over
// that many synthetic users with the monthly push on, in an in-memory database, at a fixed `now`
// when every push is due. Every tenth user also has the weekly push and every seventh a payday
// budget, so each code path is exercised. Prints to this terminal only; nothing in the gate reads
// these timings.
import { performance } from 'node:perf_hooks';
import { setBudgetStartDay } from '../src/db/budgets.js';
import { openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { setPushOn } from '../src/db/users.js';
import { createLogger } from '../src/logger.js';
import { createLedgerKeyring } from '../src/services/ledgerKeys.js';
import { dueSummaries } from '../src/services/periodReport.js';
import { provisionUser } from '../src/services/provisionUser.js';

// Monday 5 October 2026, 09:00 in Belgrade: the September push and the week's are both due.
const NOW = new Date('2026-10-05T07:00:00Z');
const WARM_RUNS = 5;

const users = Number.parseInt(process.argv[2] ?? '10000', 10);
if (!Number.isInteger(users) || users < 1) throw new Error('usage: bench:due <users>');

const db = openDatabase(':memory:');
runMigrations(db, NOW);
let n = 0;
const deps = {
  db,
  newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  logger: createLogger('silent'),
  defaultTimezone: 'Europe/Belgrade',
  keys: createLedgerKeyring(() => NOW),
};

const built = performance.now();
db.transaction(() => {
  for (let i = 0; i < users; i++) {
    const { user, ledger } = provisionUser(deps, {
      provider: 'telegram',
      externalId: String(100_000 + i),
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: NOW,
    });
    if (i % 10 === 0) setPushOn(db, user.id, 'weekly', true);
    if (i % 7 === 0) setBudgetStartDay(db, ledger.id, { startDay: 25, currency: 'RSD' }, NOW);
  }
})();
const buildMs = performance.now() - built;

// One cold run, then the mean of WARM_RUNS warm runs, in ms.
let dueCount = 0;
const once = () => {
  const start = performance.now();
  dueCount = dueSummaries(deps, NOW).length;
  return performance.now() - start;
};
const cold = once();
let warm = 0;
for (let i = 0; i < WARM_RUNS; i++) warm += once();

const ms = (value: number) => `${value.toFixed(1)} ms`;
console.log(`users:     ${users} (built in ${ms(buildMs)})`);
console.log(`due:       ${dueCount}`);
console.log(`tick:      cold ${ms(cold)}, warm ${ms(warm / WARM_RUNS)} (mean of ${WARM_RUNS})`);
db.close();
