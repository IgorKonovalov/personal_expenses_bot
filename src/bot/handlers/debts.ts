import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { DebtPersonId } from '../../db/debts.js';
import type { User } from '../../db/users.js';
import {
  answerDebtAmount,
  answerDebtPersonName,
  debtCurrency,
  debtLines,
  debtPeople,
  pickDebtPerson,
  startDebt,
  type DebtRecorded,
} from '../../services/debts.js';
import {
  currentFlow,
  setAnchor,
  type DebtAmountFlow,
  type DebtPersonFlow,
  type ScreenAnchor,
} from '../../services/flowSessions.js';
import type { HandlerDeps } from '../bot.js';
import {
  DEBT_NEW,
  DEBT_PAGE,
  DEBT_PICK,
  debtDeleteData,
  debtNewData,
  debtPageData,
  debtPickData,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { joinHtml, replyHtml, type Html } from '../render/html.js';
import { pageOf, pagerRow } from '../nav.js';
import {
  cancelRow,
  renderAnchor,
  requireScreen,
  showScreen,
  type ScreenTap,
  type ScreenView,
} from '../screens.js';
import { ensureUser } from './start.js';

// /debts (Plan 0013, ADR-0030): who owes the user and whom the user owes, per person and
// currency. [Я дал в долг] and [Я взял в долг] ask for the amount, then the person, in the
// screen's anchor. Debts are private: the screen exists only in the DM.

// The debts list with its two buttons.
export function debtsListView(deps: HandlerDeps, user: User): ScreenView {
  return {
    text: messages.debtsScreen(debtLines(deps, user)),
    markup: InlineKeyboard.from([
      [
        InlineKeyboard.text(messages.lendButton, debtNewData('lend')),
        InlineKeyboard.text(messages.borrowButton, debtNewData('borrow')),
      ],
    ]),
  };
}

// The anchor's /debts screen re-rendered, e.g. after a cancel.
export function debtsScreenFor(deps: HandlerDeps, user: User): ScreenView {
  return debtsListView(deps, user);
}

function withRefusal(prompt: Html, refusal: Html | undefined): Html {
  return refusal === undefined ? prompt : joinHtml([refusal, prompt], '\n');
}

function amountPromptView(
  deps: HandlerDeps,
  user: User,
  flow: DebtAmountFlow,
  refusal?: Html,
): ScreenView {
  return {
    text: withRefusal(messages.debtAmountPrompt(flow.direction, debtCurrency(deps, user)), refusal),
    markup: InlineKeyboard.from([cancelRow()]),
  };
}

// The person picker: a button per known person, two per row and 8 per page, then [Отмена].
function personPickerView(
  deps: HandlerDeps,
  user: User,
  flow: DebtPersonFlow,
  page = 1,
  refusal?: Html,
): ScreenView {
  const shown = pageOf(debtPeople(deps, user), page);
  const choices = shown.items.map((person) =>
    InlineKeyboard.text(person.name, debtPickData(person.id)),
  );
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < choices.length; i += 2) rows.push(choices.slice(i, i + 2));
  const pager = pagerRow(shown, debtPageData);
  if (pager.length > 0) rows.push(pager);
  rows.push(cancelRow());
  const money = { amountMinor: flow.amountMinor, currency: flow.currency };
  return {
    text: withRefusal(messages.debtPersonPrompt(flow.direction, money), refusal),
    markup: InlineKeyboard.from(rows),
  };
}

// A recorded operation's confirmation, with [Удалить].
function recordedView(result: DebtRecorded): ScreenView {
  const { op, person, balance } = result;
  return {
    text: messages.debtRecorded({
      kind: op.kind,
      money: { amountMinor: op.amountMinor, currency: op.currency },
      balance: { ...balance, name: person.name },
    }),
    markup: new InlineKeyboard().text(messages.undoButton, debtDeleteData(op.id)),
  };
}

async function show(ctx: Context, anchor: ScreenAnchor | undefined, view: ScreenView) {
  if (anchor === undefined) {
    await replyHtml(ctx, view.text, { reply_markup: view.markup });
    return;
  }
  await renderAnchor(ctx, anchor, view);
}

// A typed answer to a debts flow, shown in the anchor: the next step, the step asked again with
// the refusal above it, or the recorded operation.
export async function answerDebtFlow(
  ctx: Context,
  deps: HandlerDeps,
  anchor: ScreenAnchor | undefined,
  input: {
    readonly user: User;
    readonly flow: DebtAmountFlow | DebtPersonFlow;
    readonly text: string;
    readonly inputKey: string;
  },
): Promise<void> {
  const { user, flow } = input;
  const now = deps.now();
  if (flow.kind === 'debtAmount') {
    const result = answerDebtAmount(deps, { ...input, flow, now });
    await show(
      ctx,
      anchor,
      result.kind === 'invalid'
        ? amountPromptView(deps, user, flow, messages.debtAmountRefused)
        : personPickerView(deps, user, result.flow),
    );
    return;
  }
  const result = answerDebtPersonName(deps, { ...input, flow, now });
  await show(
    ctx,
    anchor,
    result.kind === 'invalid'
      ? personPickerView(deps, user, flow, 1, messages.debtPersonRefused[result.reason])
      : recordedView(result),
  );
}

async function debtsTap(ctx: Context, deps: HandlerDeps): Promise<ScreenTap | undefined> {
  const tap = await requireScreen(ctx, deps);
  if (tap === undefined) return undefined;
  if (tap.anchor.screen.name !== 'debts') {
    await ctx.answerCallbackQuery({ text: messages.staleScreen });
    return undefined;
  }
  return tap;
}

// The pending person step of the anchor's flow; a toast once it is gone.
async function personFlowOf(
  ctx: Context,
  deps: HandlerDeps,
  tap: ScreenTap,
): Promise<DebtPersonFlow | undefined> {
  const flow = currentFlow(deps, tap.user, deps.now());
  if (flow?.kind === 'debtPerson') return flow;
  await ctx.answerCallbackQuery({ text: messages.staleScreen });
  return undefined;
}

export function registerDebts(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('debts', async (ctx) => {
    if (ctx.from === undefined) return;
    const user = ensureUser(deps, ctx.from.id, deps.now());
    await showScreen(ctx, deps, user, { name: 'debts' }, debtsListView(deps, user));
  });

  bot.callbackQuery(DEBT_NEW, async (ctx) => {
    const tap = await debtsTap(ctx, deps);
    if (tap === undefined) return;
    const direction = ctx.match[1] === 'b' ? 'borrow' : 'lend';
    const flow = startDebt(deps, tap.user, direction, deps.now());
    setAnchor(deps, tap.user, { ...tap.anchor, screen: { name: 'debts' } });
    await ctx.answerCallbackQuery();
    await renderAnchor(ctx, tap.anchor, amountPromptView(deps, tap.user, flow));
  });

  bot.callbackQuery(DEBT_PAGE, async (ctx) => {
    const tap = await debtsTap(ctx, deps);
    if (tap === undefined) return;
    const flow = await personFlowOf(ctx, deps, tap);
    if (flow === undefined) return;
    await ctx.answerCallbackQuery();
    await renderAnchor(
      ctx,
      tap.anchor,
      personPickerView(deps, tap.user, flow, Number(ctx.match[1])),
    );
  });

  // The flow's completion is the guard: a second tap finds no person step pending, and a
  // redelivered tap finds the operation it recorded.
  bot.callbackQuery(DEBT_PICK, async (ctx) => {
    const tap = await debtsTap(ctx, deps);
    if (tap === undefined) return;
    const result = pickDebtPerson(deps, {
      user: tap.user,
      personId: Number(ctx.match[1]) as DebtPersonId,
      sourceKey: `cb:${ctx.callbackQuery.id}`,
      now: deps.now(),
    });
    if (result.kind === 'stale') {
      await ctx.answerCallbackQuery({ text: messages.staleScreen });
      return;
    }
    await ctx.answerCallbackQuery();
    await renderAnchor(ctx, tap.anchor, recordedView(result));
  });
}
