// `pnpm products:coverage [path]` (Plan 0036 Phase 5): the product coverage report for a copy of
// the production database, printed to this terminal only. The file is opened read-only.
// DATABASE_PATH or ./data/bot.sqlite when no path is given.
import Database from 'better-sqlite3';
import { coverage, formatCoverage } from '../src/tools/productsCoverage.js';

const path = process.argv[2] ?? process.env.DATABASE_PATH ?? './data/bot.sqlite';
const db = new Database(path, { readonly: true, fileMustExist: true });
try {
  console.log(formatCoverage(coverage(db)));
} finally {
  db.close();
}
