import {
  findActiveLedger,
  findMemberStickyTag,
  setMemberStickyTag,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import type { User, UserId } from '../db/users.js';
import { toTagName, uniqueTags, type TagName } from '../domain/tags.js';
import type { RecordDeps } from './recordExpense.js';

// The sticky tag (ADR-0029): `/tag отпуск` adds #отпуск to every expense one member records into
// one ledger until it is cleared. Set-to-value throughout, so a repeated command or tap converges.

type Deps = Pick<RecordDeps, 'db'>;

// The member's sticky tag in the ledger; undefined for none.
export function stickyTagOf(deps: Deps, ledgerId: LedgerId, userId: UserId): TagName | undefined {
  const stored = findMemberStickyTag(deps.db, ledgerId, userId);
  return stored === undefined ? undefined : toTagName(stored);
}

// An expense's tags: the text's own first, then the sticky tag when it isn't among them.
export function withStickyTag(
  tags: readonly TagName[],
  sticky: TagName | undefined,
): readonly TagName[] {
  return sticky === undefined ? tags : uniqueTags([...tags, sticky]);
}

export type SetStickyTagResult =
  | { readonly kind: 'set'; readonly ledger: Ledger; readonly name: TagName }
  // `#` alone, two words, or anything but 1-32 letters, digits or `_`.
  | { readonly kind: 'invalid' };

// `/tag отпуск` or `/tag #отпуск`: the sticky tag of the user's active ledger.
export function setStickyTag(deps: Deps, user: User, text: string): SetStickyTagResult {
  const word = text.trim();
  const name = toTagName(word.startsWith('#') ? word.slice(1) : word);
  if (name === undefined) return { kind: 'invalid' };
  const ledger = activeLedger(deps, user);
  setMemberStickyTag(deps.db, ledger.id, user.id, name);
  return { kind: 'set', ledger, name };
}

// The user's sticky tag in the active ledger, for `/tag` with no argument.
export function currentStickyTag(
  deps: Deps,
  user: User,
): { readonly ledger: Ledger; readonly name: TagName | undefined } {
  const ledger = activeLedger(deps, user);
  return { ledger, name: stickyTagOf(deps, ledger.id, user.id) };
}

// Clears the sticky tag of the user's active ledger; a second clear writes nothing.
export function clearStickyTag(deps: Deps, user: User): void {
  setMemberStickyTag(deps.db, activeLedger(deps, user).id, user.id, null);
}

function activeLedger({ db }: Deps, user: User): Ledger {
  const ledger = findActiveLedger(db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
  return ledger;
}
