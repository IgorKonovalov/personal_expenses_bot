import type { Logger } from '../logger.js';
import type { RegisteredProvider } from './types.js';

// The local-time scheduler (ADR-0031): a tick at start, then every minute. An in-flight guard
// keeps ticks from overlapping; each tick asks every provider for its due occurrences and fires
// them. Errors are caught and logged per occurrence and per provider, never thrown.

export const TICK_MS = 60 * 1000;

export interface SchedulerDeps {
  readonly logger: Logger;
  readonly now: () => Date;
  readonly providers: readonly RegisteredProvider[];
}

export interface Scheduler {
  // Runs a tick now unless one is in flight.
  readonly kick: () => void;
  // Stops the timer and resolves once the tick in flight has settled.
  readonly stop: () => Promise<void>;
}

// One tick over every provider at `now`.
export async function runTick(
  { logger, providers }: Pick<SchedulerDeps, 'logger' | 'providers'>,
  now: Date,
): Promise<void> {
  for (const provider of providers) {
    const report = (error: unknown) => {
      logger.error(
        { provider: provider.name, err: error instanceof Error ? error.name : typeof error },
        'scheduled occurrence failed',
      );
    };
    try {
      await provider.tick(now, report);
    } catch (error) {
      report(error);
    }
  }
}

export function startScheduler(deps: SchedulerDeps): Scheduler {
  let stopped = false;
  let inFlight: Promise<void> | undefined;

  const kick = (): void => {
    if (inFlight !== undefined || stopped) return;
    inFlight = runTick(deps, deps.now()).finally(() => {
      inFlight = undefined;
    });
  };

  const timer = setInterval(kick, TICK_MS);
  kick();
  return {
    kick,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
