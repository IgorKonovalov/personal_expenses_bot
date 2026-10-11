# ADR-0050: A second navigation level: a ☰ Меню hub edited in place, and /help as topics

> **Status:** accepted (2026-10-11)
> **Date:** 2026-10-11
> **Related plan(s):** [Plan 0049](../plans/done/0049-menu-hub-and-deeper-screens.md)

## Context

ADR-0011 put every feature one tap from a persistent reply-keyboard bar. Plan 0034 then added
[☰ Ещё], an inline screen with one button per command the bar lacks, and pinned that a tap there
"answers exactly as the typed command does": it sends a **new** message. Features kept arriving,
so the private chat now has eight bar buttons, four to a row, and «Ещё» lists more than ten
commands on one level, plus six admin buttons for the admin. A ux-telegram review (2026-10-11)
walked the result:

- Four reply buttons to a row likely truncate «⚙️ Настройки» on a phone about 360 px wide.
- «Ещё» is a launcher, not a menu. Each tap leaves «Ещё» behind and posts another message, and
  none of the screens it opens leads back. Three taps leave three messages.
- Rare and everyday items share one level. «Удалить аккаунт» and «Возврат пожертвования» sit
  beside «Долги», the admin rows beside the user's, and the /settings hub runs to eight rows.
- /help is one message of 35 lines, 3,411 of Telegram's 4,096 characters (measured on
  2026-10-11), and every plan adds a paragraph.

ADR-0011 rejected an inline-only `/menu` hub because "the hub scrolls out of view". A hub
behind a bar button doesn't scroll away: the button is always there. So the forces that decided
ADR-0011 still hold, but its layout (decision 1) and its rule that /help carries the bar don't.

## Decision

> The private bar has two rows of three: `[📊 Сегодня] [📅 Неделя] [🗓 Месяц]` /
> `[💰 Бюджет] [📷 Скан] [☰ Меню]`, or `[💰 Бюджет] [☰ Меню]` without the Mini App. [☰ Меню]
> opens a hub, an inline message that is **edited in place**. A hub tap renders its screen into
> the tapped message, which becomes the user's anchor (ADR-0011), with [« Назад] (`more:open`)
> on the screen's bottom row back to the hub. Settings, help, account matters and the admin's
> commands live one level further down. The hub itself holds no state: a tap on any copy of it
> works. A screen opened by its typed command is unchanged. It arrives as a new message with no
> [« Назад] to a hub it never came from.
>
> /help opens the help **screen**: a short core, topic buttons and a link to the guide. Each topic
> is edited in place with [« Назад] to the help screen. The bar now rides only on /start (the
> welcome). The old bar labels («⚙️ Настройки», «❓ Помощь», «☰ Ещё») keep routing, because a
> client keeps showing the bar it was last sent until the bot sends a new one.

Every private command stays reachable by a button, now at any depth (Plan 0034's invariant), and
the "/" command list still names every command. A hub tap answers with the same text as the
typed command, edited into the tapped message, instead of a new message identical to the typed
command's.

## Consequences

### Positive
- The top level drops from eight bar buttons plus «Ещё»'s list to six bar buttons plus a hub of
  about eight. Admin, account and notification items go one level down.
- Browsing the hub leaves one message in the chat, not one per screen.
- Help can grow by topic without nearing 4,096 characters.

### Negative
- Settings and help cost one more tap than before.
- A user whose client still shows the old bar sees the old layout until their next /start. The
  aliases keep it working, but the new layout spreads slowly (ADR-0013 announces only to the
  admin).
- Losing the bar is now repaired only by /start. /help no longer re-sends it.
- Every screen reachable from the hub owes a "came from the hub" mark that survives its own
  pagers and sub-screens, so that [« Назад] appears exactly when the user came from the hub.
  That's one more state to test per screen.
- The Plan 0034 test that a tap equals the typed command is rewritten, not just kept.

## Alternatives considered

### Alternative A: Reorder the flat «Ещё» (Plan 0048 Phase 1)
Put the important buttons first and the rare ones last. It calms the most prominent row but
leaves a launcher that posts a new message per tap, the admin rows, the eight-row settings hub
and the help wall. Plan 0048 ships it as a stopgap. This ADR replaces that layout.

### Alternative B: /help stays a short text that carries the bar
It keeps ADR-0011's "/help restores the menu", but help would then exist twice, as a text on
/help and as topics in the hub, and the two would drift. /start already restores the bar.

### Alternative C: Trim the "/" command list as well
Fewer "/" entries would be calmer, but Plan 0034 chose the full list on purpose, so that typed
discovery works for invited strangers. The user kept that choice (2026-10-11).
