# ADR-0048: A Russian docs site beside the Mini App, with its chat pictures generated from the real bot

> **Status:** accepted (2026-10-08)
> **Date:** 2026-10-07
> **Related plan(s):** [Plan 0047](../plans/done/0047-docs-site.md)

## Context

The bot's interface has outgrown the one place it is described. The user reference is the
`## Using the bot` section of `README.md`: English prose, around 400 lines, read on GitHub. The
people who use the bot read Russian, every string they see is Russian (`src/bot/messages.ts`),
and `/help` is a single long message that can't show a keyboard, a card or a flow. Invited users
need a guide in their language, with pictures of what they will see in the chat.

Pictures of a chat are the hard part. The copy changes in most plans: version announcements,
reworded buttons, new lines on a card. A phone screenshot is stale after the next copy change,
only a human can retake it, and it risks showing real data (CLAUDE.md, "Expense data is
private"). But `src/bot/testHarness.ts` already drives the real bot in memory, with an injected
clock and deterministic ids, and records every Bot API call with its HTML text and keyboard. A
picture made from that recording is a function of the code, so it can be regenerated at every
build.

Hosting is constrained by what already exists. The repository's one GitHub Pages site serves the
Mini App (ADR-0025) at `https://igorkonovalov.github.io/personal_expenses_bot/`. `WEBAPP_URL`
on the VPS points there, and every chart and scan button already sent in a chat carries that URL
plus a `#fragment`. A repository has one Pages deployment, so the docs have to share its build
artifact, and the Mini App must keep its address.

The sibling Ritmolux project answered the generator question with Astro Starlight (its
ADR-0154): search, sidebar and a built-in Russian UI locale, in a package of its own that ships
nothing to production.

## Decision

We publish a user guide in Russian, with a separate «Как это устроено» section on the
architecture, as an **Astro Starlight** site in `site/`. It is a standalone pnpm project with its
own lockfile and the same release-age cooldown, and it never enters the bot's image. It deploys
at **`/personal_expenses_bot/docs/`**, in the **same Pages artifact as the Mini App**, which
stays at the root. The Mini App page sends a visitor who arrives without a payload fragment to
`./docs/`.

**Every chat picture is generated, never drawn or photographed.** A scenario is a short script
of user actions: send text, tap a button by its label. A generator runs it through the real bot
via the test harness and writes a transcript of what the bot sent, with edits and deletions
applied. The site draws the transcript as Telegram-style bubbles in HTML/CSS. Transcripts are
generated at build time and are not committed, so a page can't show copy the bot no longer
sends. A scenario step that gets no reply fails the build. **Mini App charts are the real page in
an iframe**, opened with the `#z=` fragment from the chart button the scenario recorded.

The architecture pages are written by hand in Russian. They link to the English ADRs and plans on
GitHub and don't copy them. `docs/` stays the working record and is not published.

## Consequences

### Positive

- **A picture can't drift from the bot.** When a plan rewords a button, the next Pages build
  shows the new label. The copy has one source, `messages.ts`, and the site reads it through the
  bot instead of through a second copy.
- **No real data can reach a picture.** Transcripts come from an in-memory database seeded only
  by the scenario's own invented inputs.
- **The chart demos are the real Mini App,** interactive in the reader's browser, and their
  payload is the one the bot builds for that scenario.
- **The Mini App's URL doesn't change,** so nothing on the VPS changes and no button already sent
  breaks.

### Negative

- **A second npm toolchain.** Starlight brings Astro, its bundler and image tooling: a lockfile
  to keep under the cooldown, and a build that can break for reasons unrelated to any doc. It is
  bounded because it ships nothing to the bot, but the upkeep is real.
- **The prose can still go stale.** Only the bubbles are generated. A page that says "three
  buttons" while the generated chat shows four is wrong, and no gate catches it. The command
  coverage gate (Plan 0047) catches only a command that no page mentions.
- **The bubbles imitate Telegram without being Telegram.** Fonts, spacing and keyboard layout are
  approximations, and a feature that renders differently on a real client (expandable
  blockquotes, spoilers, long keyboards) can look right on the site and wrong on a phone.
- **Scenarios that need the network don't run.** A receipt fetch from the tax site, or a rate
  from the NBS, has to come from a test fake, or that page goes without a generated picture.
- **The Mini App and the docs deploy together.** Every docs edit republishes the Mini App, and a
  broken docs build blocks a Mini App fix from reaching Pages.
- **The Pages build now needs the bot's dev dependencies,** including the native `better-sqlite3`,
  because the generator runs the bot.

## Alternatives considered

### Alternative A: real screenshots from a test account

The most authentic look. It lost on upkeep: copy changes in most plans, every picture it touches
needs a human with a phone to retake it, and nothing tells you which pictures are stale. It also
puts the privacy rule in a human's hands, one capture at a time.

### Alternative B: hand-written chat mockups in the pages

A bubble component, with each page typing out the bot's messages inline. Cheap, and needs no
generator. It lost because it is a second copy of `messages.ts` that drifts silently, which is
the same failure as real screenshots without even the authenticity.

### Alternative C: the docs at the root and the Mini App moved to `/app/`

Gives the docs the clean URL. It lost because it changes `WEBAPP_URL` on the VPS in step with a
Pages deploy, and every chart button already sent (root URL plus `#z=`) would need a redirect
shim in the docs' home page, kept forever.

### Alternative D: a separate docs repository with its own Pages site

No coupling between the docs build and the Mini App. It lost because the generator needs the
bot's code: the docs repository would have to vendor or fetch the bot to make its pictures, which
brings back the drift this decision exists to remove.

VitePress (lighter, with search and i18n) was weighed against Starlight and lost only on
consistency with Ritmolux. If the Astro toolchain becomes a burden, it is the migration target.
