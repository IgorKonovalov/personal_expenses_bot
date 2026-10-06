import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { softDeleteExpense } from '../db/expenses.js';
import { setFxDay, storeFxList } from '../db/fxRates.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { tagHash, type TagName } from '../domain/tags.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { createLedgerKeyring, type LedgerKeyring } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense, type RecordDeps } from './recordExpense.js';
import { activeLedgerTagReport, activeLedgerTags } from './tagSummary.js';

// Sent 12:00 local on 2026-09-30.
const SENT = new Date('2026-09-30T10:00:00Z');

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let alice: User;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, SENT);
  let n = 0;
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('silent'),
    defaultTimezone: 'Europe/Belgrade',
    keys: createLedgerKeyring(() => SENT),
  };
  alice = provisionUser(deps, {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: SENT,
  }).user;
  // EUR at 117.1234 RSD, in force on the 30th.
  const day = '2026-09-30' as LocalDate;
  storeFxList(
    db,
    { listDate: day, listNumber: 185, rates: [{ currency: 'EUR', unit: 1, middleE4: 1171234 }] },
    SENT,
  );
  setFxDay(db, day, day, SENT);
});

function record(text: string, sourceKey: string) {
  const result = recordExpense(deps, { user: alice, text, sourceKey, occurredAt: SENT, now: SENT });
  if (result.kind !== 'recorded') throw new Error(`not recorded: ${result.kind}`);
  return result.expense;
}

describe('activeLedgerTags', () => {
  it('totals #отпуск at 45000 + 146404 = 191404 RSD', () => {
    record('450 кофе #отпуск', 'tg:1001:1');
    record('12,50 EUR такси #отпуск', 'tg:1001:2');
    record('300 хлеб', 'tg:1001:3');

    const list = activeLedgerTags(deps, alice);

    expect(list).toMatchObject({
      ledger: { id: alice.activeLedgerId },
      tags: [
        {
          name: 'отпуск',
          converted: { amountMinor: 191404, currency: 'RSD' },
          unconverted: [],
          lastOn: '2026-09-30',
        },
      ],
    });
  });

  it('drops a soft-deleted expense, and a tag only it carried', () => {
    record('450 кофе #отпуск', 'tg:1001:1');
    const gone = record('300 такси #отпуск #рим', 'tg:1001:2');
    softDeleteExpense(db, gone.id, SENT);

    const list = activeLedgerTags(deps, alice);

    expect(list).toMatchObject({
      tags: [{ name: 'отпуск', converted: { amountMinor: 45000, currency: 'RSD' } }],
    });
    expect('tags' in list && list.tags).toHaveLength(1);
  });

  it('is empty for a ledger with no tagged expense', () => {
    record('450 кофе', 'tg:1001:1');

    expect(activeLedgerTags(deps, alice)).toMatchObject({ tags: [] });
  });
});

describe('activeLedgerTagReport', () => {
  const hash = (name: string) => tagHash(name as TagName);

  it("reports the tag the hash names, with the list page it's on", () => {
    record('450 кофе #отпуск', 'tg:1001:1');
    record('12,50 EUR такси #отпуск', 'tg:1001:2');
    record('100 хлеб #a', 'tg:1001:3');

    const result = activeLedgerTagReport(deps, { user: alice, hash: hash('отпуск'), pageSize: 1 });

    expect(result).toMatchObject({
      kind: 'report',
      ledger: { id: alice.activeLedgerId },
      report: {
        name: 'отпуск',
        converted: { currency: 'RSD', totalMinor: 191404 },
        count: 2,
        firstOn: '2026-09-30',
        lastOn: '2026-09-30',
      },
      // All three share one instant, so `a` sorts first by name: page 1 at one tag to a page.
      page: 2,
    });
  });

  it('is gone once the only expense with the tag is deleted, with the list as it is now', () => {
    const only = record('300 такси #рим', 'tg:1001:1');
    record('450 кофе #отпуск', 'tg:1001:2');
    softDeleteExpense(db, only.id, SENT);

    expect(
      activeLedgerTagReport(deps, { user: alice, hash: hash('рим'), pageSize: 8 }),
    ).toMatchObject({ kind: 'gone', list: { tags: [{ name: 'отпуск' }] } });
  });
});
