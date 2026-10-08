import type { LocalDate } from '../../../src/domain/time.js';
import { setFxDay, storeFxList } from '../../../src/db/fxRates.js';
import { say, scenario } from '../scenario.js';

// A made-up NBS list for the day: the generator never reaches the network.
const day = '2026-09-15' as LocalDate;
const fetchedAt = new Date('2026-09-15T07:00:00Z');

export default scenario(
  'currency',
  {
    chat: 'private',
    now: '2026-09-15T10:30:00Z',
    setup: (db) => {
      storeFxList(
        db,
        { listDate: day, listNumber: 1, rates: [{ currency: 'EUR', unit: 1, middleE4: 1172000 }] },
        fetchedAt,
      );
      setFxDay(db, day, day, fetchedAt);
    },
  },
  [say('2300 продукты'), say('12,50 EUR такси'), say('5000 тенге сувениры'), say('/today')],
);
