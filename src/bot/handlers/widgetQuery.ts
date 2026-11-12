import type { Composer, Context } from 'grammy';
import { findCategory, type CategoryId } from '../../db/categories.js';
import type { LedgerId } from '../../db/ledgers.js';
import { findUserByIdentity } from '../../db/users.js';
import { parsePeriod } from '../../domain/periods.js';
import { encodeDrill, encodeDrillError } from '../../domain/widgetData.js';
import { accessOf } from '../../services/admission.js';
import { isLocked } from '../../services/ledgerKeys.js';
import { ledgerPeriodSummary } from '../../services/periodSummary.js';
import { periodTrend } from '../../services/periodTrend.js';
import type { AdminDeps } from '../bot.js';
import { messages } from '../messages.js';
import { answerWidgetQuery, widgetQueryOf } from '../widgetApi.js';

// A donut's drill-down request (ADR-0053): `d:<period key>:<ledger id>:<category id | n>`, n for
// the expenses without a category. The data is untrusted, like callback data. The answer is the
// category's converted total in the requested period and the ones before it, read live, or an
// error's text; it changes nothing in the database.
const DRILL = /^d:(\d{4}-\d{2}(?:-\d{2})?):([0-9a-f-]{36}):(\d{1,16}|n)$/;

// Mounted ahead of the access gate (src/bot/bot.ts): grammY 1.46.0 doesn't know `widget_query`,
// so `ctx.from` is undefined for it and the gate would drop it. The sender is read off the raw
// update and admitted here by the gate's own rule. Every other update passes through.
export function registerWidgetQuery(dm: Composer<Context>, deps: AdminDeps): void {
  dm.use(async (ctx, next) => {
    const query = widgetQueryOf(ctx.update);
    if (query === undefined) {
      await next();
      return;
    }
    const { answer, outcome } = drillAnswer(deps, query.from.id, query.data);
    deps.logger.info({ updateId: ctx.update.update_id, outcome }, 'widget query answered');
    await answerWidgetQuery(ctx.api, query.id, answer);
  });
}

type Outcome = 'data' | 'unavailable' | 'locked';

function drillAnswer(
  deps: AdminDeps,
  telegramId: number,
  data: string,
): { readonly answer: string; readonly outcome: Outcome } {
  const unavailable = {
    answer: encodeDrillError(messages.widgetUnavailable),
    outcome: 'unavailable',
  } as const;
  if (accessOf(deps, telegramId) !== 'admitted') return unavailable;
  const match = DRILL.exec(data);
  const [, key = '', rawLedgerId = '', rawCategory = ''] = match ?? [];
  const period = parsePeriod(key.length === 7 ? 'month' : 'week', key);
  const user = findUserByIdentity(deps.db, 'telegram', String(telegramId));
  if (match === null || period === undefined || user === undefined) return unavailable;
  const ledgerId = rawLedgerId as LedgerId;
  const now = deps.now();
  // The same read the summary screen pages with: undefined unless the user is a member and the
  // period has begun.
  const shown = ledgerPeriodSummary(deps, { user, ledgerId, period, now });
  if (shown === undefined) return unavailable;
  if (isLocked(shown)) {
    return { answer: encodeDrillError(messages.widgetLocked), outcome: 'locked' };
  }
  let categoryId: number | null = null;
  let category: string | null = null;
  if (rawCategory !== 'n') {
    const found = findCategory(deps.db, ledgerId, Number(rawCategory) as CategoryId);
    if (found === undefined) return unavailable;
    categoryId = found.id;
    category = found.name;
  }
  const trend = periodTrend(deps, { user, ledgerId, period, now });
  if (trend === undefined) return unavailable;
  const answer = encodeDrill(
    messages.widgetDrill({
      category,
      currency: shown.ledger.defaultCurrency,
      points: trend.map((point) => ({
        period: point.period,
        amountMinor: point.lines.find((line) => line.categoryId === categoryId)?.amountMinor ?? 0,
      })),
    }),
  );
  return { answer, outcome: 'data' };
}
