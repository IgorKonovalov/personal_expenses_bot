import { InlineKeyboard, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { User } from '../../db/users.js';
import { sumByCurrency } from '../../domain/aggregate.js';
import { setAnchor, type ScreenAnchor } from '../../services/flowSessions.js';
import type { Batch } from '../../services/recordExpenseLines.js';
import type { HandlerDeps } from '../bot.js';
import { drillExpenseData } from '../callbackData.js';
import { messages } from '../messages.js';
import { renderAnchor, showScreen, type ScreenView } from '../screens.js';

// A multi-line message's batch card (ADR-0049): one message for every expense the message
// recorded, a list screen in the anchor (ADR-0011). A number opens that expense's card in place
// through the drill-down's `drl:e`, and its [« Назад] redraws the batch from its keys (drill.ts).

// Number buttons per row under the batch.
const NUMBERS_PER_ROW = 4;

function batchView(batch: Batch): ScreenView {
  const live = batch.expenses.filter((expense) => expense.deletedAt === null);
  const totals = [
    ...sumByCurrency(
      live.map((expense) => ({ amountMinor: expense.amountMinor, currency: expense.currency })),
    ),
  ].map(([currency, amountMinor]) => ({ currency, amountMinor }));
  const numbers = batch.expenses.map((expense, index) =>
    InlineKeyboard.text(messages.drillNumberButton(index + 1), drillExpenseData(expense.id)),
  );
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < numbers.length; i += NUMBERS_PER_ROW) {
    rows.push(numbers.slice(i, i + NUMBERS_PER_ROW));
  }
  return {
    text: messages.batchCard({
      ledger: batch.ledger,
      totals,
      lines: batch.expenses.map((expense, index) => ({
        n: index + 1,
        money: { amountMinor: expense.amountMinor, currency: expense.currency },
        description: expense.description,
        category: expense.category?.name ?? null,
        occurredOn: expense.occurredOn,
        sentOn: batch.sentOn,
        deleted: expense.deletedAt !== null,
      })),
    }),
    markup: InlineKeyboard.from(rows),
  };
}

function batchScreen(batch: Batch) {
  return { name: 'batch', ledgerId: batch.ledger.id, sourceKey: batch.sourceKey } as const;
}

// The batch as a new message, which becomes the user's anchor.
export async function sendBatch(
  ctx: Context,
  deps: HandlerDeps,
  user: User,
  batch: Batch,
): Promise<void> {
  await showScreen(ctx, deps, user, batchScreen(batch), batchView(batch));
}

// The batch redrawn into the anchor, which shows it again.
export async function showBatch(
  ctx: Context,
  deps: HandlerDeps,
  target: { readonly user: User; readonly anchor: ScreenAnchor },
  batch: Batch,
): Promise<void> {
  await renderAnchor(ctx, target.anchor, batchView(batch));
  setAnchor(deps, target.user, { ...target.anchor, screen: batchScreen(batch) });
}
