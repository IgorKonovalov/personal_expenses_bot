import { fetchRates, type FetchRatesDeps } from '../services/fetchRates.js';

// The NBS rate worker (ADR-0022): a tick at start, then hourly. An in-flight guard keeps ticks
// from overlapping, and errors are caught and logged per tick.

const TICK_MS = 60 * 60 * 1000;

export interface RateWorkerDeps extends FetchRatesDeps {
  readonly now: () => Date;
}

export interface RateWorker {
  // Runs a tick now unless one is in flight.
  readonly kick: () => void;
  // Stops the timer, aborts the fetch in flight and resolves once the tick has settled.
  readonly stop: () => Promise<void>;
}

export function startRateWorker(deps: RateWorkerDeps): RateWorker {
  const { logger } = deps;
  const stopping = new AbortController();
  let inFlight: Promise<void> | undefined;

  const kick = (): void => {
    if (inFlight !== undefined || stopping.signal.aborted) return;
    inFlight = fetchRates(deps, { now: deps.now(), signal: stopping.signal })
      .then(({ fetched, failed }) => {
        if (fetched + failed > 0) logger.info({ fetched, failed }, 'fx tick done');
      })
      .catch((error: unknown) => {
        logger.error(
          { err: error instanceof Error ? error.name : typeof error },
          'fx worker tick failed',
        );
      })
      .finally(() => {
        inFlight = undefined;
      });
  };

  const timer = setInterval(kick, TICK_MS);
  kick();
  return {
    kick,
    stop: async () => {
      clearInterval(timer);
      stopping.abort();
      await inFlight;
    },
  };
}
