import { pino, type DestinationStream, type Level, type Logger } from 'pino';

export type { Logger };

// Log lines carry ids only. Amounts, descriptions and names stay at debug or below.
export function createLogger(level: Level | 'silent', destination?: DestinationStream): Logger {
  return destination === undefined ? pino({ level }) : pino({ level }, destination);
}
