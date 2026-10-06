// A kind of scheduled job (ADR-0031). `due` returns the occurrences whose local due instant has
// passed by `now`; `fire` runs one. A provider makes each occurrence happen once: it claims the
// occurrence's key in the transaction that does the work, so firing one twice does nothing.
export interface Provider<T> {
  // For logs.
  readonly name: string;
  readonly due: (now: Date) => readonly T[];
  readonly fire: (occurrence: T, now: Date) => Promise<void>;
}

// A provider with its occurrence type closed over, so providers of different kinds share one
// list in the worker.
export interface RegisteredProvider {
  readonly name: string;
  // Fires every due occurrence; one that throws is reported and the rest still run.
  readonly tick: (now: Date, onError: (error: unknown) => void) => Promise<void>;
}

export function register<T>(provider: Provider<T>): RegisteredProvider {
  return {
    name: provider.name,
    tick: async (now, onError) => {
      for (const occurrence of provider.due(now)) {
        try {
          await provider.fire(occurrence, now);
        } catch (error) {
          onError(error);
        }
      }
    },
  };
}
