// Test-only: switches encryption on for a user's personal ledger and unlocks it, through the same
// flows the bot runs (ADR-0020). The passphrase is synthetic.
import { findPersonalLedger, type Ledger } from '../../db/ledgers.js';
import type { User } from '../../db/users.js';
import {
  enableEncryption,
  startEnableFlow,
  startUnlockFlow,
  unlockLedger,
  type KeyDeps,
} from '../ledgerKeys.js';

export const TEST_PASSPHRASE = 'correct horse 42';

let inputs = 0;

export async function sealPersonalLedger(deps: KeyDeps, user: User, now: Date): Promise<Ledger> {
  const ledger = findPersonalLedger(deps.db, user.id);
  if (ledger === undefined) throw new Error('setup: no personal ledger');
  if (!startEnableFlow(deps, user, now)) throw new Error('setup: ledger already sealed');
  const enabled = await enableEncryption(deps, {
    user,
    ledgerId: ledger.id,
    passphrase: TEST_PASSPHRASE,
    inputKey: `test:seal:${String(++inputs)}`,
    now,
  });
  if (enabled.kind !== 'enabled') throw new Error(`setup: enable was ${enabled.kind}`);
  return ledger;
}

export async function unlockPersonalLedger(deps: KeyDeps, user: User, now: Date): Promise<void> {
  const ledger = findPersonalLedger(deps.db, user.id);
  if (ledger === undefined) throw new Error('setup: no personal ledger');
  if (startUnlockFlow(deps, user, now) !== 'asked') throw new Error('setup: nothing to unlock');
  const unlocked = await unlockLedger(deps, {
    user,
    ledgerId: ledger.id,
    passphrase: TEST_PASSPHRASE,
    inputKey: `test:unlock:${String(++inputs)}`,
  });
  if (unlocked.kind !== 'unlocked') throw new Error(`setup: unlock was ${unlocked.kind}`);
}
