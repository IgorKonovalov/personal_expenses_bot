import type { Api } from 'grammy';
import { fetchDueReceipt, type FetchDeps } from '../services/fetchDueReceipt.js';
import type { HandlerDeps } from './bot.js';
import { cardFor, cardView } from './handlers/card.js';
import { messages } from './messages.js';
import { editHtmlAt } from './render/html.js';

// The background enrichment of receipts (ADR-0018): a timer drains due receipts one fetch at a
// time, each bounded by a timeout, and edits the card of each receipt that settles. An
// in-flight guard keeps ticks from overlapping. Errors are caught and logged per receipt, since
// the bot's error boundary only wraps updates.

const TICK_MS = 5_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface ReceiptWorkerDeps extends HandlerDeps {
  readonly fetchers: FetchDeps['fetchers'];
}

export interface ReceiptWorker {
  // Runs a drain now unless one is in flight.
  readonly kick: () => void;
  // Stops the timer, aborts the fetch in flight and resolves once the drain has settled.
  readonly stop: () => Promise<void>;
}

// The worker of this process, once started: [Повторить] kicks it without holding a reference.
let running: ReceiptWorker | undefined;

export function kickReceiptWorker(): void {
  running?.kick();
}

export function startReceiptWorker(deps: ReceiptWorkerDeps, api: Api): ReceiptWorker {
  const { logger } = deps;
  const fetchDeps: FetchDeps = { ...deps, placeholder: messages.receiptPlaceholder };
  const stopping = new AbortController();
  let inFlight: Promise<void> | undefined;

  async function drain(): Promise<void> {
    while (!stopping.signal.aborted) {
      const signal = AbortSignal.any([stopping.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
      const result = await fetchDueReceipt(fetchDeps, { now: deps.now(), signal });
      if (result.kind === 'idle') return;
      if (result.kind !== 'settled') continue;
      const { receipt, expense, ledger, author } = result;
      if (receipt.card === null || expense.deletedAt !== null) continue;
      const card = cardFor(cardView(deps, author, { expense, ledger }));
      try {
        await editHtmlAt({ api }, receipt.card, card.text, { reply_markup: card.markup });
      } catch (error) {
        logger.warn(
          { receiptId: receipt.id, err: error instanceof Error ? error.name : typeof error },
          'receipt card edit failed',
        );
      }
    }
  }

  const kick = (): void => {
    if (inFlight !== undefined || stopping.signal.aborted) return;
    inFlight = drain()
      .catch((error: unknown) => {
        logger.error(
          { err: error instanceof Error ? error.name : typeof error },
          'receipt worker drain failed',
        );
      })
      .finally(() => {
        inFlight = undefined;
      });
  };

  const timer = setInterval(kick, TICK_MS);
  const worker: ReceiptWorker = {
    kick,
    stop: async () => {
      clearInterval(timer);
      stopping.abort();
      if (running === worker) running = undefined;
      await inFlight;
    },
  };
  running = worker;
  kick();
  return worker;
}
