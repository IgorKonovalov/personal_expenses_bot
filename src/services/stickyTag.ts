import {
  findActiveLedger,
  findMemberStickyTag,
  setMemberStickyTag,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import type { User, UserId } from '../db/users.js';
import { toTagName, uniqueTags, type TagName } from '../domain/tags.js';
import { isSealedLedger, type KeyDeps, type LedgerKeyring } from './ledgerKeys.js';
import type { RecordDeps } from './recordExpense.js';

// The sticky tag (ADR-0029): `/tag отпуск` adds #отпуск to every expense one member records into
// one ledger until it is cleared. Set-to-value throughout, so a repeated command or tap converges.
// A plaintext ledger keeps it in ledger_members.sticky_tag. A sealed ledger (ADR-0020) never
// writes it there: it lives in memory beside the process's keyring, so a restart, which builds a
// new keyring, forgets it. Without a keyring a sealed ledger has none.

type Deps = Pick<RecordDeps, 'db'> & Partial<Pick<KeyDeps, 'keys'>>;

const sealedStickyTags = new WeakMap<LedgerKeyring, Map<string, TagName>>();

function sealedStore(deps: Deps): Map<string, TagName> | undefined {
  if (deps.keys === undefined) return undefined;
  const store = sealedStickyTags.get(deps.keys) ?? new Map<string, TagName>();
  sealedStickyTags.set(deps.keys, store);
  return store;
}

const memberKey = (ledgerId: LedgerId, userId: UserId) => `${ledgerId}:${userId}`;

// The member's sticky tag in the ledger; undefined for none.
export function stickyTagOf(deps: Deps, ledgerId: LedgerId, userId: UserId): TagName | undefined {
  if (isSealedLedger(deps, ledgerId)) return sealedStore(deps)?.get(memberKey(ledgerId, userId));
  const stored = findMemberStickyTag(deps.db, ledgerId, userId);
  return stored === undefined ? undefined : toTagName(stored);
}

function storeStickyTag(
  deps: Deps,
  ledgerId: LedgerId,
  userId: UserId,
  name: TagName | null,
): void {
  if (!isSealedLedger(deps, ledgerId)) {
    setMemberStickyTag(deps.db, ledgerId, userId, name);
    return;
  }
  const store = sealedStore(deps);
  if (name === null) store?.delete(memberKey(ledgerId, userId));
  else store?.set(memberKey(ledgerId, userId), name);
}

// An expense's tags: the text's own first, then the sticky tag when it isn't among them.
export function withStickyTag(
  tags: readonly TagName[],
  sticky: TagName | undefined,
): readonly TagName[] {
  return sticky === undefined ? tags : uniqueTags([...tags, sticky]);
}

export type SetStickyTagResult =
  | {
      readonly kind: 'set';
      readonly ledger: Ledger;
      readonly name: TagName;
      // Held in memory only, until the bot restarts.
      readonly sealed: boolean;
    }
  // `#` alone, two words, or anything but 1-32 letters, digits or `_`.
  | { readonly kind: 'invalid' };

// `/tag отпуск` or `/tag #отпуск`: the sticky tag of the user's active ledger.
export function setStickyTag(deps: Deps, user: User, text: string): SetStickyTagResult {
  const ledger = activeLedger(deps, user);
  const name = setLedgerStickyTag(deps, { ledgerId: ledger.id, userId: user.id, text });
  return name === undefined
    ? { kind: 'invalid' }
    : { kind: 'set', ledger, name, sealed: isSealedLedger(deps, ledger.id) };
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
  storeStickyTag(deps, activeLedger(deps, user).id, user.id, null);
}

// The group forms (ADR-0014): the bound ledger's sticky tag of the member who sent the command.
export function setLedgerStickyTag(
  deps: Deps,
  input: { readonly ledgerId: LedgerId; readonly userId: UserId; readonly text: string },
): TagName | undefined {
  const word = input.text.trim();
  const name = toTagName(word.startsWith('#') ? word.slice(1) : word);
  if (name !== undefined) storeStickyTag(deps, input.ledgerId, input.userId, name);
  return name;
}

export function clearLedgerStickyTag(deps: Deps, ledgerId: LedgerId, userId: UserId): void {
  storeStickyTag(deps, ledgerId, userId, null);
}

function activeLedger({ db }: Deps, user: User): Ledger {
  const ledger = findActiveLedger(db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
  return ledger;
}
