// `pnpm bench:prices [items]` (Plan 0038 Phase 1): times the /prices list and product views over
// one synthetic user in an in-memory database. Item names are invented grocery strings, drawn
// from a fixed seed, so two runs build the same data. Prints to this terminal only; nothing in
// the gate reads these timings.
import { performance } from 'node:perf_hooks';
import { openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { insertReceiptItems } from '../src/db/receiptItems.js';
import { markReceiptFetched } from '../src/db/receipts.js';
import { createLogger } from '../src/logger.js';
import { createLedgerKeyring, isLocked } from '../src/services/ledgerKeys.js';
import { activeProductList, ledgerProduct } from '../src/services/productPrices.js';
import { provisionUser } from '../src/services/provisionUser.js';
import { recordReceipt } from '../src/services/recordReceipt.js';

const NOW = new Date('2026-10-06T10:00:00Z');
const ITEMS_PER_RECEIPT = 15;
const DAYS = 730;
const WARM_RUNS = 5;

const items = Number.parseInt(process.argv[2] ?? '20000', 10);
if (!Number.isInteger(items) || items < 1) throw new Error('usage: bench:prices <items>');

const BASES = [
  'MLEKO',
  'HLEB BELI',
  'BANANA',
  'JOGURT',
  'KEFIR',
  'PAVLAKA',
  'SIR GAUDA',
  'PUTER',
  'JAJA',
  'BRASNO T400',
  'SECER',
  'PIRINAC',
  'ULJE SUNCOKRET',
  'KAFA MLEVENA',
  'PILECI FILE',
  'SUNKA',
  'KROMPIR',
  'LUK CRNI',
  'SARGAREPA',
  'JABUKA',
  'VODA NEGAZ',
  'SOK NARANDZA',
  'PIVO',
  'KESA',
  'CIPS SLANI',
];
const BRANDS = [
  'IMLEK',
  'SVETLO',
  'DOBRO',
  'NAS IZBOR',
  'ZLATNO',
  'POLJE',
  'SELO',
  'DOMACE',
  'BRDO',
  'REKA',
  'SUNCE',
  'VRT',
  'FARMA',
  'KLAS',
  'IZVOR',
];
const SIZES = ['1L', '0,5L', '500G', '1KG', '200G', '2L', '/KG', '330ML'];

// About 3,000 distinct names at the full pool.
const NAMES = Array.from({ length: BASES.length * BRANDS.length * SIZES.length }, (_, i) => {
  const base = BASES[i % BASES.length];
  const brand = BRANDS[Math.floor(i / BASES.length) % BRANDS.length];
  const size = SIZES[Math.floor(i / (BASES.length * BRANDS.length)) % SIZES.length];
  return `${base} ${brand} ${size}`;
});

// A fixed-seed linear congruential generator: the same data every run.
let seed = 38;
function next(bound: number): number {
  seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
  return (seed >>> 8) % bound;
}

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
const { user, ledger } = provisionUser(deps, {
  provider: 'telegram',
  externalId: '1001',
  defaultTimezone: 'Europe/Belgrade',
  defaultCurrency: 'RSD',
  now: NOW,
});

const used = new Set<string>();
db.transaction(() => {
  for (let fiscal = 0, left = items; left > 0; fiscal++, left -= ITEMS_PER_RECEIPT) {
    const lines = Array.from({ length: Math.min(ITEMS_PER_RECEIPT, left) }, () => {
      const name = NAMES[next(NAMES.length)] ?? 'KESA';
      used.add(name);
      return { name, quantity: '1', totalMinor: 5_000 + next(45_000) };
    });
    const instant = new Date(NOW.getTime() - (1 + next(DAYS)) * 86_400_000);
    const result = recordReceipt(deps, {
      user,
      receipt: {
        country: 'RS',
        fiscalId: `BENCH-${fiscal}`,
        merchantKey: 'rs:bench',
        totalMinor: lines.reduce((sum, line) => sum + line.totalMinor, 0),
        currency: 'RSD',
        issuedAt: instant,
        verifyUrl: `https://example.test/v/${fiscal}`,
      },
      placeholder: 'Чек',
      occurredAt: instant,
      now: NOW,
    });
    if (result.kind !== 'recorded') throw new Error(`receipt not recorded: ${result.kind}`);
    markReceiptFetched(db, result.receipt.id, 'Bench Market');
    insertReceiptItems(db, result.receipt.id, lines);
  }
})();

// One cold run, then the mean of WARM_RUNS warm runs, in ms.
function time(run: () => unknown): { cold: number; warm: number } {
  const once = () => {
    const start = performance.now();
    const value = run();
    if (value === undefined || (typeof value === 'object' && value !== null && isLocked(value))) {
      throw new Error('the view did not open');
    }
    return performance.now() - start;
  };
  const cold = once();
  let warm = 0;
  for (let i = 0; i < WARM_RUNS; i++) warm += once();
  return { cold, warm: warm / WARM_RUNS };
}

const list = time(() => activeProductList(deps, user, NOW));
const product = time(() => ledgerProduct(deps, { user, ledgerId: ledger.id, ref: 'b:milk' }));

const ms = (value: number) => `${value.toFixed(1)} ms`;
console.log(`items:          ${items}`);
console.log(`distinct names: ${used.size}`);
console.log(`list view:      cold ${ms(list.cold)}, warm ${ms(list.warm)} (mean of ${WARM_RUNS})`);
console.log(
  `product view:   cold ${ms(product.cold)}, warm ${ms(product.warm)} (mean of ${WARM_RUNS})`,
);
db.close();
