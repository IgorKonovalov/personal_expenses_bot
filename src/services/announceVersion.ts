import { getAppState, setAppState } from '../db/appState.js';
import type { Db } from '../db/connection.js';
import type { Logger } from '../logger.js';

// Tells the admin about the running version once (ADR-0013). The version is recorded only after
// `send` resolves, so delivery is at-least-once: a crash between the two repeats the message on
// the next boot, and a failed send is retried then. The body type belongs to the caller; this
// service only picks it out of the map.
export interface AnnounceDeps<Body> {
  readonly db: Db;
  readonly logger: Logger;
  readonly announcements: Readonly<Record<string, Body>>;
  readonly send: (version: string, body: Body) => Promise<void>;
}

export type AnnounceOutcome = 'announced' | 'unchanged' | 'missing' | 'failed';

// Never throws: boot must not depend on Telegram. Logs carry the version and an error name,
// never the announcement text.
export async function announceVersion<Body>(
  deps: AnnounceDeps<Body>,
  current: string,
): Promise<AnnounceOutcome> {
  const { db, logger } = deps;
  try {
    const previous = getAppState(db, 'last_announced_version');
    if (previous === current) return 'unchanged';

    const body = deps.announcements[current];
    if (body === undefined) {
      logger.error({ version: current }, 'no version announcement for the running version');
      return 'missing';
    }

    try {
      await deps.send(current, body);
    } catch (error) {
      logger.warn({ version: current, err: errorName(error) }, 'version announcement not sent');
      return 'failed';
    }

    setAppState(db, 'last_announced_version', current);
    logger.info({ version: current, previous: previous ?? null }, 'version announced');
    return 'announced';
  } catch (error) {
    logger.error({ version: current, err: errorName(error) }, 'version announcement failed');
    return 'failed';
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
