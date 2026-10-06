import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { DebtOpId, DebtPersonId } from '../../db/debts.js';
import type { User } from '../../db/users.js';
import { toCurrencyCode } from '../../domain/currencies.js';
import type { Money } from '../../domain/money.js';
import {
  answerDebtAmount,
  answerDebtPersonName,
  answerRepayAmount,
  debtCurrency,
  debtLines,
  debtPeople,
  deleteDebtOp,
  personCard,
  pickDebtPerson,
  repayAll,
  startDebt,
  startRepay,
  type DebtRecorded,
  type RepayDirection,
  type RepayStart,
} from '../../services/debts.js';
import {
  currentFlow,
  setAnchor,
  type DebtAmountFlow,
  type DebtPersonFlow,
  type DebtRepayFlow,
  type DebtsScreen,
  type ScreenAnchor,
} from '../../services/flowSessions.js';
import type { HandlerDeps } from '../bot.js';
import {
  DEBTS_LIST,
  DEBT_DELETE,
  DEBT_NEW,
  DEBT_PAGE,
  DEBT_PERSON,
  DEBT_PICK,
  DEBT_REPAY,
  DEBT_REPAY_ALL,
  DEBT_REPAY_CURRENCY,
  debtDeleteData,
  debtNewData,
  debtPageData,
  debtPersonData,
  debtPickData,
  debtRepayCurrencyData,
  debtRepayData,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml, joinHtml, replyHtml, type Html } from '../render/html.js';
import { pageOf, pagerRow } from '../nav.js';
import {
  backRow,
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

// The debts list: a button per person on it, two per row, then the two new-loan buttons.
export function debtsListView(deps: HandlerDeps, user: User): ScreenView {
  const lines = debtLines(deps, user);
  const people = [...new Map(lines.map((line) => [line.personId, line.name])).entries()];
  const buttons = people.map(([id, name]) => InlineKeyboard.text(name, debtPersonData(id)));
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return {
    text: messages.debtsScreen(lines),
    markup: InlineKeyboard.from([
      ...rows,
      [
        InlineKeyboard.text(messages.lendButton, debtNewData('lend')),
        InlineKeyboard.text(messages.borrowButton, debtNewData('borrow')),
      ],
    ]),
  };
}

// A person's card: [Мне вернули] while they owe the user something, [Я вернул] while the user
// owes them something, and [« Назад]. Undefined for a person who isn't the user's.
function personCardView(
  deps: HandlerDeps,
  user: User,
  personId: DebtPersonId,
): ScreenView | undefined {
  const card = personCard(deps, user, personId);
  if (card === undefined) return undefined;
  const repay = [
    ...(card.balances.some((b) => b.amountMinor > 0)
      ? [InlineKeyboard.text(messages.repaidToMeButton, debtRepayData(personId, 'toMe'))]
      : []),
    ...(card.balances.some((b) => b.amountMinor < 0)
      ? [InlineKeyboard.text(messages.iRepaidButton, debtRepayData(personId, 'byMe'))]
      : []),
  ];
  return {
    text: messages.debtCard({
      name: card.person.name,
      balances: card.balances,
      history: card.history.map((op) => ({
        kind: op.kind,
        money: { amountMinor: op.amountMinor, currency: op.currency },
        occurredOn: op.occurredOn,
      })),
    }),
    markup: InlineKeyboard.from([...(repay.length === 0 ? [] : [repay]), backRow(DEBTS_LIST)]),
  };
}

// The anchor's /debts screen re-rendered, e.g. after a cancel: the person's card, else the list.
export function debtsScreenFor(deps: HandlerDeps, user: User, screen: DebtsScreen): ScreenView {
  const card =
    screen.personId === undefined ? undefined : personCardView(deps, user, screen.personId);
  return card ?? debtsListView(deps, user);
}

function repayAmountView(balance: Money, refusal?: Html): ScreenView {
  return {
    text: withRefusal(messages.repayAmountPrompt(balance), refusal),
    markup: InlineKeyboard.from([
      [InlineKeyboard.text(messages.repayAllButton, DEBT_REPAY_ALL)],
      cancelRow(),
    ]),
  };
}

const repayRefusal = {
  invalid: () => messages.debtAmountRefused,
  wrongCurrency: (balance: Money) => messages.debtWrongCurrency(balance.currency),
  tooMuch: (balance: Money) => messages.debtTooMuch(balance),
} as const;

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
    readonly flow: DebtAmountFlow | DebtPersonFlow | DebtRepayFlow;
    readonly text: string;
    readonly inputKey: string;
  },
): Promise<void> {
  const { user, flow } = input;
  const now = deps.now();
  if (flow.kind === 'debtRepay') {
    const result = answerRepayAmount(deps, { ...input, flow, now });
    if (result.kind === 'gone') {
      if (anchor?.screen.name === 'debts') {
        await renderAnchor(ctx, anchor, debtsScreenFor(deps, user, anchor.screen));
      }
      return;
    }
    await show(
      ctx,
      anchor,
      result.kind === 'refused'
        ? repayAmountView(result.balance, repayRefusal[result.reason](result.balance))
        : recordedView(result),
    );
    return;
  }
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

async function showDebts(
  ctx: Context,
  deps: HandlerDeps,
  tap: ScreenTap,
  screen: DebtsScreen,
  view: ScreenView,
): Promise<void> {
  setAnchor(deps, tap.user, { ...tap.anchor, screen });
  await renderAnchor(ctx, { ...tap.anchor, screen }, view);
}

// The repayment's next step in the card's anchor: the currency picker, or the amount prompt.
async function showRepayStart(
  ctx: Context,
  tap: ScreenTap,
  personId: DebtPersonId,
  direction: RepayDirection,
  start: RepayStart,
): Promise<void> {
  if (start.kind === 'nothing') {
    await ctx.answerCallbackQuery({ text: messages.staleScreen });
    return;
  }
  await ctx.answerCallbackQuery();
  if (start.kind === 'askAmount') {
    await renderAnchor(ctx, tap.anchor, repayAmountView(start.balance));
    return;
  }
  await renderAnchor(ctx, tap.anchor, {
    text: messages.repayCurrencyPrompt(direction),
    markup: InlineKeyboard.from([
      ...start.balances.map((balance) => [
        InlineKeyboard.text(
          messages.repayCurrencyButton(balance),
          debtRepayCurrencyData(personId, balance.currency),
        ),
      ]),
      backRow(debtPersonData(personId)),
    ]),
  });
}

export function registerDebts(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.callbackQuery(DEBTS_LIST, async (ctx) => {
    const tap = await debtsTap(ctx, deps);
    if (tap === undefined) return;
    await ctx.answerCallbackQuery();
    await showDebts(ctx, deps, tap, { name: 'debts' }, debtsListView(deps, tap.user));
  });

  bot.callbackQuery(DEBT_PERSON, async (ctx) => {
    const tap = await debtsTap(ctx, deps);
    if (tap === undefined) return;
    const personId = Number(ctx.match[1]) as DebtPersonId;
    const view = personCardView(deps, tap.user, personId);
    if (view === undefined) {
      await ctx.answerCallbackQuery({ text: messages.debtNotFound });
      return;
    }
    await ctx.answerCallbackQuery();
    await showDebts(ctx, deps, tap, { name: 'debts', personId }, view);
  });

  bot.callbackQuery(DEBT_REPAY, async (ctx) => {
    const tap = await debtsTap(ctx, deps);
    if (tap === undefined) return;
    const personId = Number(ctx.match[1]) as DebtPersonId;
    const direction = ctx.match[2] === 't' ? 'toMe' : 'byMe';
    const start = startRepay(deps, { user: tap.user, personId, direction, now: deps.now() });
    setAnchor(deps, tap.user, { ...tap.anchor, screen: { name: 'debts', personId } });
    await showRepayStart(ctx, tap, personId, direction, start);
  });

  bot.callbackQuery(DEBT_REPAY_CURRENCY, async (ctx) => {
    const tap = await debtsTap(ctx, deps);
    const currency = toCurrencyCode(ctx.match[2] ?? '');
    if (tap === undefined || currency === undefined) return;
    const personId = Number(ctx.match[1]) as DebtPersonId;
    const owedToMe = personCard(deps, tap.user, personId)?.balances.find(
      (b) => b.currency === currency,
    );
    const direction = (owedToMe?.amountMinor ?? 0) > 0 ? 'toMe' : 'byMe';
    const start = startRepay(deps, {
      user: tap.user,
      personId,
      direction,
      currency,
      now: deps.now(),
    });
    await showRepayStart(ctx, tap, personId, direction, start);
  });

  bot.callbackQuery(DEBT_REPAY_ALL, async (ctx) => {
    const tap = await debtsTap(ctx, deps);
    if (tap === undefined) return;
    const result = repayAll(deps, {
      user: tap.user,
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

  // Works on any confirmation, however old: the operation's deleted_at is the guard.
  bot.callbackQuery(DEBT_DELETE, async (ctx) => {
    const opId = ctx.match[1] as DebtOpId | undefined;
    if (opId === undefined) return;
    const user = ensureUser(deps, ctx.from.id, deps.now());
    const result = deleteDebtOp(deps, { user, opId, now: deps.now() });
    if (result.kind !== 'deleted') {
      await ctx.answerCallbackQuery({
        text:
          result.kind === 'alreadyDeleted' ? messages.debtAlreadyDeleted : messages.debtNotFound,
      });
      return;
    }
    await ctx.answerCallbackQuery({ text: messages.debtDeletedToast });
    const { op, person, balance } = result;
    await editHtml(
      ctx,
      messages.debtDeleted({
        kind: op.kind,
        money: { amountMinor: op.amountMinor, currency: op.currency },
        balance: { ...balance, name: person.name },
      }),
    );
  });

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
