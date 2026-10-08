// The scenario API for the docs site's chats (ADR-0048): a short script of user actions, run
// through the real bot in memory. Inputs are invented, never taken from anyone's data.
import {
  type ApiCall,
  SECOND_ALLOWED_ID,
  callbackUpdate,
  createTestBot,
  textUpdate,
  withMessageIds,
} from '../../src/bot/testHarness.js';
import { createRecorder, type Transcript } from './recorder.js';

export interface ScenarioOptions {
  readonly chat: 'private';
  // Pins the bot's clock, so "today" in the pictures is a fixed day.
  readonly now: string;
  // Sets WEBAPP_URL, so the chart buttons appear.
  readonly webapp?: boolean;
}

export type Step =
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'tap'; readonly label: string };

export interface Scenario {
  readonly name: string;
  readonly options: ScenarioOptions;
  readonly steps: readonly Step[];
}

// The Mini App's published address: the root the docs site sits beside.
export const WEBAPP_URL = 'https://igorkonovalov.github.io/personal_expenses_bot/';

// The reader: an invited user, not the admin, so no admin-only buttons or notices show.
const USER_ID = SECOND_ALLOWED_ID;

export function scenario(name: string, options: ScenarioOptions, steps: readonly Step[]): Scenario {
  return { name, options, steps };
}

export function say(text: string): Step {
  return { kind: 'say', text };
}

export function tap(label: string): Step {
  return { kind: 'tap', label };
}

export async function runScenario({ name, options, steps }: Scenario): Promise<Transcript> {
  const now = new Date(options.now);
  const { bot, calls } = createTestBot({
    now,
    ...(options.webapp === true ? { webappUrl: WEBAPP_URL } : {}),
  });
  withMessageIds(bot);
  const recorder = createRecorder(USER_ID);
  let updateId = 0;
  let userMessageId = 0;
  for (const step of steps) {
    const before = calls.length;
    updateId += 1;
    if (step.kind === 'say') {
      userMessageId += 1;
      recorder.user(step.text, userMessageId);
      await bot.handleUpdate(
        textUpdate({
          updateId,
          text: step.text,
          fromId: USER_ID,
          messageId: userMessageId,
          date: now,
        }),
      );
      recorder.apply(calls.slice(before));
    } else {
      const target = recorder.target(step.label);
      if (target === undefined) {
        throw new Error(`scenario ${name}: no button «${step.label}» in the latest bot message`);
      }
      await bot.handleUpdate(
        callbackUpdate({
          updateId,
          data: target.data,
          fromId: USER_ID,
          messageId: target.messageId,
        }),
      );
      recorder.apply(calls.slice(before), target.messageId);
    }
    expectReply(name, step, USER_ID, calls.slice(before));
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
    const what = step.kind === 'say' ? `say «${step.text}»` : `tap «${step.label}»`;
    throw new Error(`scenario ${name}: the bot sent nothing after ${what}`);
  }
}
