// The scenario API for the docs site's chats (ADR-0048): a short script of user actions, run
// through the real bot in memory. Inputs are invented, never taken from anyone's data.
import type { Message } from 'grammy/types';
import type { Db } from '../../src/db/connection.js';
import {
  type ApiCall,
  GROUP_ID,
  SECOND_ALLOWED_ID,
  callbackUpdate,
  createTestBot,
  groupTextUpdate,
  myChatMemberUpdate,
  textUpdate,
  withMessageIds,
} from '../../src/bot/testHarness.js';
import { createRecorder, type Transcript } from './recorder.js';

export interface ScenarioOptions {
  // A private chat with the bot, or a group the first of `members` added it to.
  readonly chat: 'private' | 'group';
  // Pins the bot's clock, so "today" in the pictures is a fixed day.
  readonly now: string;
  // Sets WEBAPP_URL, so the chart buttons appear.
  readonly webapp?: boolean;
  // First contact (the welcome and the settings check) on the user's first message.
  readonly onboarding?: boolean;
  // Runs on the in-memory database before the first step, e.g. to store an NBS rate list.
  readonly setup?: (db: Db) => void;
  // A group's members by invented first name; the first one adds the bot.
  readonly members?: readonly string[];
}

export type Step =
  | {
      readonly kind: 'say';
      readonly text: string;
      // What the user bubble shows instead of `text`, e.g. a long link cut short.
      readonly shown?: string;
      // In a group: the member who sends it (default: the first).
      readonly from?: string;
    }
  | { readonly kind: 'tap'; readonly label: string; readonly from?: string }
  // Clears the picture drawn so far; the bot's state and the bottom keyboard stay.
  | { readonly kind: 'cut' };

export interface Scenario {
  readonly name: string;
  readonly options: ScenarioOptions;
  readonly steps: readonly Step[];
}

// The Mini App's published address: the root the docs site sits beside.
export const WEBAPP_URL = 'https://igorkonovalov.github.io/personal_expenses_bot/';

// The reader: an invited user, not the admin, so no admin-only buttons or notices show.
const USER_ID = SECOND_ALLOWED_ID;
// Telegram ids for the group's other members, made up.
const FIRST_MEMBER_ID = 3001;

export function scenario(name: string, options: ScenarioOptions, steps: readonly Step[]): Scenario {
  return { name, options, steps };
}

export function say(text: string, more: { shown?: string; from?: string } = {}): Step {
  return { kind: 'say', text, ...more };
}

export function tap(label: string, more: { from?: string } = {}): Step {
  return { kind: 'tap', label, ...more };
}

export function cut(): Step {
  return { kind: 'cut' };
}

export async function runScenario({ name, options, steps }: Scenario): Promise<Transcript> {
  const now = new Date(options.now);
  const { bot, calls, db } = createTestBot({
    now,
    ...(options.webapp === true ? { webappUrl: WEBAPP_URL } : {}),
    ...(options.onboarding === true ? { onboarding: true } : {}),
  });
  withMessageIds(bot);
  options.setup?.(db);
  const group = options.chat === 'group';
  const chatId = group ? GROUP_ID : USER_ID;
  const members = options.members ?? [];
  const memberId = (who: string | undefined): number => {
    if (!group || who === undefined) return USER_ID;
    const at = members.indexOf(who);
    if (at === -1) throw new Error(`scenario ${name}: ${who} is not a member`);
    return at === 0 ? USER_ID : FIRST_MEMBER_ID + at;
  };
  const recorder = createRecorder(chatId);
  let updateId = 0;
  let userMessageId = 0;
  // The user messages sent so far, by message id.
  const sent = new Map<number, Message>();

  if (group) {
    const [adder] = members;
    if (adder === undefined) throw new Error(`scenario ${name}: a group needs members`);
    // The adder is admitted on a private /start, then adds the bot; only the group's chat is kept.
    await bot.handleUpdate(textUpdate({ updateId: ++updateId, text: '/start', fromId: USER_ID }));
    const before = calls.length;
    await bot.handleUpdate(
      myChatMemberUpdate({
        updateId: ++updateId,
        fromId: USER_ID,
        oldStatus: 'left',
        newStatus: 'member',
      }),
    );
    recorder.apply(calls.slice(before));
  }

  for (const step of steps) {
    if (step.kind === 'cut') {
      recorder.cut();
      continue;
    }
    const before = calls.length;
    updateId += 1;
    const fromId = memberId(step.from);
    const firstName = group ? (step.from ?? members[0]) : undefined;
    if (step.kind === 'say') {
      userMessageId += 1;
      recorder.user(step.shown ?? step.text, userMessageId, firstName);
      const message = { updateId, text: step.text, fromId, messageId: userMessageId, date: now };
      const update =
        firstName === undefined ? textUpdate(message) : groupTextUpdate({ ...message, firstName });
      if (update.message !== undefined) sent.set(userMessageId, update.message);
      await bot.handleUpdate(update);
      recorder.apply(calls.slice(before));
    } else {
      const target = recorder.target(step.label);
      if (target === undefined) {
        throw new Error(`scenario ${name}: no button «${step.label}» in the latest bot message`);
      }
      const update = callbackUpdate({
        updateId,
        data: target.data,
        fromId,
        messageId: target.messageId,
        ...(group ? { chatId } : {}),
      });
      // A message sent as a reply carries the message it answers, as Telegram delivers it.
      const original = target.replyTo === undefined ? undefined : sent.get(target.replyTo);
      const message = update.callback_query?.message;
      if (original !== undefined && message !== undefined) {
        Object.assign(message, { reply_to_message: original });
      }
      if (firstName !== undefined && update.callback_query !== undefined) {
        Object.assign(update.callback_query.from, { first_name: firstName });
      }
      await bot.handleUpdate(update);
      recorder.apply(calls.slice(before), target.messageId);
    }
    expectReply(name, step, chatId, calls.slice(before));
  }
  return recorder.transcript(name);
}

// Throws unless the bot sent something to the chat after `step`: any call to it, a reaction
// included, or a callback answer with a toast. A step with no reply is a broken scenario, and
// it fails `docs:chats`.
export function expectReply(
  name: string,
  step: Step,
  chatId: number,
  calls: readonly ApiCall[],
): void {
  const replied = calls.some(({ method, payload }) => {
    const { chat_id, text } = payload as { chat_id?: number; text?: string };
    return chat_id === chatId || (method === 'answerCallbackQuery' && (text ?? '') !== '');
  });
  if (!replied) {
    const what =
      step.kind === 'say'
        ? `say «${step.text}»`
        : step.kind === 'tap'
          ? `tap «${step.label}»`
          : 'cut';
    throw new Error(`scenario ${name}: the bot sent nothing after ${what}`);
  }
}
