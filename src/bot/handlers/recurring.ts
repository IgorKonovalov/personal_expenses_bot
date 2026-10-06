import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { Expense } from '../../db/expenses.js';
import type { Ledger } from '../../db/ledgers.js';
import type { RecurringRule, RuleId, RuleMode } from '../../db/recurring.js';
import type { User } from '../../db/users.js';
import type { CurrencyCode } from '../../domain/currencies.js';
import type { Money } from '../../domain/money.js';
import type { Schedule } from '../../domain/schedule.js';
import { localDateOf, parseLocalDate, type LocalDate } from '../../domain/time.js';
import {
  setAnchor,
  type RecurringAskScreen,
  type RecurringScreen,
} from '../../services/flowSessions.js';
import { effectiveTimezone } from '../../services/recordExpense.js';
import {
  answerAsk,
  askTarget,
  changeRuleMode,
  createRuleFromExpense,
  deleteRule,
  listRules,
  ownRule,
  repeatOptions,
  startAskAmount,
  type AnswerAskResult,
  type AskRefusal,
  type AskTarget,
  type RepeatRefusal,
  type ScheduleChoice,
} from '../../services/recurring.js';
import { resolveUserTimezone } from '../../services/settings.js';
import type { HandlerDeps } from '../bot.js';
import {
  ASK_AMOUNT,
  ASK_RECORD,
  ASK_SKIP,
  RECURRING_LIST,
  REPEAT_EXPENSE,
  REPEAT_SCHEDULE,
  RULE_DELETE,
  RULE_DELETE_CONFIRM,
  RULE_MODE,
  RULE_OPEN,
  askData,
  repeatScheduleData,
  ruleModeData,
  ruleOpenData,
  showExpenseData,
  undoExpenseData,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml, joinHtml, type Html } from '../render/html.js';
import {
  backRow,
  cancelRow,
  renderAnchor,
  requireScreen,
  showScreen,
  type ScreenTap,
  type ScreenView,
} from '../screens.js';
import { cardView, expenseIdOf, recordedCard } from './card.js';
import { ensureUser } from './start.js';

// Recurring expenses (Plan 0025): [Повторять] on an expense card turns the card into a schedule
// picker, and a schedule makes the rule; /recurring lists the user's rules. Like every card
// action these work on any card however old: the expense's stored state is the guard.

const refusalToast: Record<RepeatRefusal['kind'], string> = {
  notFound: messages.expenseNotFound,
  forbidden: messages.repeatForbidden,
  deleted: messages.expenseDeletedToast,
  unavailable: messages.repeatUnavailable,
  locked: messages.ledgerLockedToast,
};

const askRefusalToast: Record<Exclude<AskRefusal['kind'], 'answered'>, string> = {
  notFound: messages.ruleGoneToast,
  forbidden: messages.askForbidden,
};

function listItem(rule: RecurringRule): RuleListItem | undefined {
  if (rule.template === null) return undefined;
  return {
    id: rule.id,
    mode: rule.mode,
    description: rule.template.description,
    money: { amountMinor: rule.template.amountMinor, currency: rule.template.currency },
    schedule: rule.schedule,
    nextDueOn: rule.nextDueOn,
  };
}

interface RuleListItem {
  readonly id: RuleId;
  readonly mode: RuleMode;
  readonly description: string;
  readonly money: Money;
  readonly schedule: Schedule;
  readonly nextDueOn: LocalDate;
}

function userToday(deps: HandlerDeps, user: User): LocalDate {
  return localDateOf(deps.now(), resolveUserTimezone(deps, user));
}

// The list, a button per rule, with a header line above when something just changed.
export function recurringListView(deps: HandlerDeps, user: User, header?: Html): ScreenView {
  const items = listRules(deps, user).flatMap(({ rule }) => listItem(rule) ?? []);
  const list = messages.recurringList({ rules: items, today: userToday(deps, user) });
  return {
    text: header === undefined ? list : joinHtml([header, list], '\n\n'),
    markup: InlineKeyboard.from(
      items.map((item) => [InlineKeyboard.text(messages.ruleButton(item), ruleOpenData(item.id))]),
    ),
  };
}

// One rule's screen, or undefined once it is gone.
export function ruleView(deps: HandlerDeps, user: User, ruleId: RuleId): ScreenView | undefined {
  const rule = ownRule(deps, user, ruleId);
  const item = rule === undefined ? undefined : listItem(rule);
  if (item === undefined) return undefined;
  const nextMode = item.mode === 'auto' ? 'ask' : 'auto';
  return {
    text: messages.recurringRuleScreen({
      rule: item,
      mode: item.mode,
      today: userToday(deps, user),
    }),
    markup: InlineKeyboard.from([
      [
        InlineKeyboard.text(
          nextMode === 'ask' ? messages.ruleAskModeButton : messages.ruleAutoModeButton,
          ruleModeData(nextMode),
        ),
      ],
      [InlineKeyboard.text(messages.ruleDeleteButton, RULE_DELETE)],
      backRow(RECURRING_LIST),
    ]),
  };
}

// The anchor's /recurring screen re-rendered: the rule's, else the list.
export function recurringScreenFor(
  deps: HandlerDeps,
  user: User,
  screen: RecurringScreen,
): ScreenView {
  const rule = screen.ruleId === undefined ? undefined : ruleView(deps, user, screen.ruleId);
  return rule ?? recurringListView(deps, user);
}

// An `ask` occurrence's prompt: [Записать <money>], [Другая сумма], [Пропустить].
export function askCard(
  target: Pick<AskTarget, 'rule' | 'template'>,
  dueOn: LocalDate,
  today: LocalDate,
): ScreenView {
  const { rule, template } = target;
  const money = { amountMinor: template.amountMinor, currency: template.currency };
  return {
    text: messages.recurringAsk({ description: template.description, money, dueOn, today }),
    markup: InlineKeyboard.from([
      [InlineKeyboard.text(messages.askRecordButton(money), askData('ok', rule.id, dueOn))],
      [
        InlineKeyboard.text(messages.askAmountButton, askData('amt', rule.id, dueOn)),
        InlineKeyboard.text(messages.askSkipButton, askData('skip', rule.id, dueOn)),
      ],
    ]),
  };
}

// An occurrence recorded, as the scheduler posts it: the confirmation marked recurring, with
// [Удалить].
export function recurringRecordedCard(
  deps: HandlerDeps,
  author: User,
  { expense, ledger }: { readonly expense: Expense; readonly ledger: Ledger },
  now: Date = deps.now(),
): ScreenView {
  const sentOn = localDateOf(now, effectiveTimezone(deps, author, ledger));
  return {
    text: messages.recurringRecorded({ expense, ledger, sentOn }),
    markup: new InlineKeyboard().text(messages.undoButton, undoExpenseData(expense.id)),
  };
}

function ledgerToday(deps: HandlerDeps, user: User, ledger: Ledger): LocalDate {
  return localDateOf(deps.now(), effectiveTimezone(deps, user, ledger));
}

// The ask prompt as stored now: its buttons while still asked, else what it became.
export function askScreenFor(
  deps: HandlerDeps,
  user: User,
  screen: RecurringAskScreen,
): ScreenView | undefined {
  const target = askTarget(deps, { user, ruleId: screen.ruleId, dueOn: screen.dueOn });
  if (target.kind !== 'asked') return undefined;
  return askCard(target, screen.dueOn, ledgerToday(deps, user, target.ledger));
}

// [Другая сумма]'s prompt in the ask prompt, with a refusal line above it when an answer failed.
export function askAmountView(currency: CurrencyCode, refused = false): ScreenView {
  const prompt = messages.askAmountPrompt(currency);
  return {
    text: refused ? joinHtml([messages.askAmountRefused, prompt], '\n') : prompt,
    markup: InlineKeyboard.from([cancelRow()]),
  };
}

interface RecurringTap extends ScreenTap {
  readonly screen: RecurringScreen;
}

async function recurringTap(ctx: Context, deps: HandlerDeps): Promise<RecurringTap | undefined> {
  const tap = await requireScreen(ctx, deps);
  if (tap === undefined) return undefined;
  const { screen } = tap.anchor;
  if (screen.name !== 'recurring') {
    await ctx.answerCallbackQuery({ text: messages.staleScreen });
    return undefined;
  }
  return { ...tap, screen };
}

async function showRecurring(
  ctx: Context,
  deps: HandlerDeps,
  tap: ScreenTap,
  screen: RecurringScreen,
  view: ScreenView,
): Promise<void> {
  setAnchor(deps, tap.user, { ...tap.anchor, screen });
  await renderAnchor(ctx, { ...tap.anchor, screen }, view);
}

// What a tapped ask prompt says once answered.
async function answerAskTap(
  ctx: Context & { match: string | RegExpMatchArray },
  deps: HandlerDeps,
  answer: { readonly kind: 'record' } | { readonly kind: 'skip' },
): Promise<void> {
  const ruleId = ctx.match[1] as RuleId | undefined;
  const dueOn = parseLocalDate(ctx.match[2] ?? '');
  if (ruleId === undefined || dueOn === undefined || ctx.from === undefined) return;
  const now = deps.now();
  const user = ensureUser(deps, ctx.from.id, now);
  const result = answerAsk(deps, { user, ruleId, dueOn, now, answer });
  await showAskResult(ctx, deps, user, result);
}

export async function showAskResult(
  ctx: Context,
  deps: HandlerDeps,
  user: User,
  result: AnswerAskResult,
): Promise<void> {
  switch (result.kind) {
    case 'recorded': {
      await ctx.answerCallbackQuery({ text: messages.askRecordedToast });
      const card = recurringRecordedCard(deps, user, result);
      await editHtml(ctx, card.text, { reply_markup: card.markup });
      return;
    }
    case 'skipped':
      await ctx.answerCallbackQuery();
      await editHtml(ctx, messages.recurringSkipped(result.rule.template?.description ?? ''));
      return;
    case 'answered':
      await ctx.answerCallbackQuery({ text: messages.askAnswered });
      return;
    default:
      await ctx.answerCallbackQuery({ text: askRefusalToast[result.kind] });
      return;
  }
}

export function registerRecurring(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('recurring', async (ctx) => {
    if (ctx.from === undefined) return;
    const user = ensureUser(deps, ctx.from.id, deps.now());
    await showScreen(ctx, deps, user, { name: 'recurring' }, recurringListView(deps, user));
  });

  bot.callbackQuery(RECURRING_LIST, async (ctx) => {
    const tap = await recurringTap(ctx, deps);
    if (tap === undefined) return;
    await ctx.answerCallbackQuery();
    await showRecurring(ctx, deps, tap, { name: 'recurring' }, recurringListView(deps, tap.user));
  });

  bot.callbackQuery(RULE_OPEN, async (ctx) => {
    const tap = await recurringTap(ctx, deps);
    const ruleId = ctx.match[1] as RuleId | undefined;
    if (tap === undefined || ruleId === undefined) return;
    const view = ruleView(deps, tap.user, ruleId);
    if (view === undefined) {
      await ctx.answerCallbackQuery({ text: messages.ruleGoneToast });
      return;
    }
    await ctx.answerCallbackQuery();
    await showRecurring(ctx, deps, tap, { name: 'recurring', ruleId }, view);
  });

  // The mode is in the data: a second tap finds it set.
  bot.callbackQuery(RULE_MODE, async (ctx) => {
    const tap = await recurringTap(ctx, deps);
    const { ruleId } = tap?.screen ?? {};
    if (tap === undefined || ruleId === undefined) return;
    const mode = ctx.match[1] === 'k' ? 'ask' : 'auto';
    const result = changeRuleMode(deps, { user: tap.user, ruleId, mode });
    const view = ruleView(deps, tap.user, ruleId);
    if (result.kind === 'notFound' || view === undefined) {
      await ctx.answerCallbackQuery({ text: messages.ruleGoneToast });
      return;
    }
    await ctx.answerCallbackQuery({ text: messages.ruleModeToast });
    await renderAnchor(ctx, tap.anchor, view);
  });

  bot.callbackQuery(RULE_DELETE, async (ctx) => {
    const tap = await recurringTap(ctx, deps);
    const { ruleId } = tap?.screen ?? {};
    if (tap === undefined || ruleId === undefined) return;
    const rule = ownRule(deps, tap.user, ruleId);
    if (rule === undefined) {
      await ctx.answerCallbackQuery({ text: messages.ruleGoneToast });
      return;
    }
    await ctx.answerCallbackQuery();
    await renderAnchor(ctx, tap.anchor, {
      text: messages.ruleDeleteConfirm(rule.template?.description ?? ''),
      markup: InlineKeyboard.from([
        [InlineKeyboard.text(messages.ruleDeleteConfirmButton, RULE_DELETE_CONFIRM)],
        backRow(ruleOpenData(ruleId)),
      ]),
    });
  });

  bot.callbackQuery(RULE_DELETE_CONFIRM, async (ctx) => {
    const tap = await recurringTap(ctx, deps);
    const { ruleId } = tap?.screen ?? {};
    if (tap === undefined || ruleId === undefined) return;
    const result = deleteRule(deps, { user: tap.user, ruleId, now: deps.now() });
    if (result.kind === 'notFound') {
      await ctx.answerCallbackQuery({ text: messages.ruleGoneToast });
      return;
    }
    await ctx.answerCallbackQuery();
    await showRecurring(
      ctx,
      deps,
      tap,
      { name: 'recurring' },
      recurringListView(deps, tap.user, messages.ruleDeleted),
    );
  });

  bot.callbackQuery(ASK_RECORD, (ctx) => answerAskTap(ctx, deps, { kind: 'record' }));
  bot.callbackQuery(ASK_SKIP, (ctx) => answerAskTap(ctx, deps, { kind: 'skip' }));

  // [Другая сумма]: the prompt becomes the amount prompt and the flow's anchor (ADR-0009).
  bot.callbackQuery(ASK_AMOUNT, async (ctx) => {
    const ruleId = ctx.match[1] as RuleId | undefined;
    const dueOn = parseLocalDate(ctx.match[2] ?? '');
    const prompt = ctx.callbackQuery.message;
    if (ruleId === undefined || dueOn === undefined || prompt === undefined) return;
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const target = startAskAmount(deps, { user, ruleId, dueOn, now });
    if (target.kind !== 'asked') {
      await ctx.answerCallbackQuery({
        text: target.kind === 'answered' ? messages.askAnswered : askRefusalToast[target.kind],
      });
      return;
    }
    setAnchor(deps, user, {
      chatId: prompt.chat.id,
      messageId: prompt.message_id,
      screen: { name: 'recurringAsk', ruleId, dueOn },
    });
    await ctx.answerCallbackQuery();
    const view = askAmountView(target.template.currency);
    await editHtml(ctx, view.text, { reply_markup: view.markup });
  });

  bot.callbackQuery(REPEAT_EXPENSE, async (ctx) => {
    const expenseId = expenseIdOf(ctx.match);
    if (expenseId === undefined) return;
    const user = ensureUser(deps, ctx.from.id, deps.now());
    const found = repeatOptions(deps, { user, expenseId });
    if (found.kind !== 'repeatable') {
      await ctx.answerCallbackQuery({ text: refusalToast[found.kind] });
      return;
    }
    await ctx.answerCallbackQuery();
    await editHtml(ctx, messages.repeatPicker(found), {
      reply_markup: InlineKeyboard.from([
        ...found.schedules.map(({ choice, schedule }) => [
          InlineKeyboard.text(
            messages.scheduleLabel(schedule),
            repeatScheduleData(expenseId, choice),
          ),
        ]),
        backRow(showExpenseData(expenseId)),
      ]),
    });
  });

  // A second tap finds the rule the first one made and shows the same card.
  bot.callbackQuery(REPEAT_SCHEDULE, async (ctx) => {
    const expenseId = expenseIdOf(ctx.match);
    const choice = ctx.match[2] as ScheduleChoice | undefined;
    if (expenseId === undefined || choice === undefined) return;
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const result = createRuleFromExpense(deps, { user, expenseId, choice, now });
    if (result.kind !== 'created') {
      await ctx.answerCallbackQuery({ text: refusalToast[result.kind] });
      return;
    }
    await ctx.answerCallbackQuery();
    const card = recordedCard(cardView(deps, user, result));
    const today = localDateOf(now, effectiveTimezone(deps, user, result.ledger));
    await editHtml(
      ctx,
      joinHtml(
        [
          card.text,
          messages.recurringCreated({
            schedule: result.rule.schedule,
            nextDueOn: result.rule.nextDueOn,
            today,
          }),
        ],
        '\n',
      ),
      { reply_markup: card.markup },
    );
  });
}
