import { InlineKeyboard, type Api, type Composer, type Context } from 'grammy';
import {
  DONATION_PRESETS,
  STARS_CURRENCY,
  acceptsDonation,
  donationPayload,
  type DonationPreset,
} from '../../domain/donations.js';
import type { Logger } from '../../logger.js';
import { recordDonation } from '../../services/recordDonation.js';
import type { HandlerDeps } from '../bot.js';
import { messages } from '../messages.js';
import { replyHtml, type Html } from '../render/html.js';

// One cached Stars invoice link per preset (ADR-0027). Filled at boot, after the bot exists; a
// preset whose link could not be created is absent.
export type DonationLinks = Map<DonationPreset, string>;

export interface DonateDeps extends HandlerDeps {
  readonly donationLinks: ReadonlyMap<DonationPreset, string>;
  // DONATE_URL: the last button when set.
  readonly donateUrl: string | undefined;
  readonly notifyAdmin: (body: Html) => Promise<void>;
}

// Creates the invoice links into `links`. A failure logs at warn and leaves that preset out, so
// boot continues.
export async function createDonationLinks(
  api: Api,
  logger: Logger,
  links: DonationLinks,
): Promise<void> {
  for (const stars of DONATION_PRESETS) {
    try {
      const link = await api.createInvoiceLink(
        messages.donateInvoiceTitle,
        messages.donateInvoiceDescription,
        donationPayload(stars),
        '',
        STARS_CURRENCY,
        [{ label: messages.donateInvoiceLabel, amount: stars }],
      );
      links.set(stars, link);
    } catch (error) {
      logger.warn(
        { stars, err: error instanceof Error ? error.message : typeof error },
        'createInvoiceLink failed',
      );
    }
  }
}

// /donate, private chats only. Group updates never reach the DM composer (ADR-0014).
export function registerDonate(bot: Composer<Context>, deps: DonateDeps): void {
  bot.command('donate', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const markup = new InlineKeyboard();
    for (const [stars, link] of deps.donationLinks) {
      markup.url(messages.donateStarsButton(stars), link);
    }
    if (deps.donateUrl !== undefined) {
      if (deps.donationLinks.size > 0) markup.row();
      markup.url(messages.donateExternal, deps.donateUrl);
    }
    if (markup.inline_keyboard.flat().length === 0) {
      await replyHtml(ctx, messages.donateUnavailable);
      return;
    }
    await replyHtml(ctx, messages.donate, { reply_markup: markup });
  });
}

// Behind the access middleware: only an admitted user can start a payment. Writes nothing, so a
// repeated query is harmless.
export function registerPreCheckout(bot: Composer<Context>): void {
  bot.on('pre_checkout_query', async (ctx) => {
    const query = ctx.preCheckoutQuery;
    const ok = acceptsDonation({
      currency: query.currency,
      totalAmount: query.total_amount,
      payload: query.invoice_payload,
    });
    await (ok
      ? ctx.answerPreCheckoutQuery(true)
      : ctx.answerPreCheckoutQuery(false, messages.donateRejected));
  });
}

// Before the access middleware: the Stars are already taken, so the payment is recorded even
// for a payer blocked since the pre-checkout. The charge id makes a redelivery record, thank and
// notify the admin once. Logs carry the charge id and the amount, never a name.
export function registerSuccessfulPayment(bot: Composer<Context>, deps: DonateDeps): void {
  bot.on('message:successful_payment', async (ctx) => {
    const payment = ctx.message.successful_payment;
    const chargeId = payment.telegram_payment_charge_id;
    const result = recordDonation(deps, {
      telegramUserId: ctx.from.id,
      stars: payment.total_amount,
      chargeId,
      now: deps.now(),
    });
    if (result.kind === 'duplicate') return;
    if (result.kind === 'unknownPayer') {
      deps.logger.warn({ chargeId }, 'donation from a payer with no user, not recorded');
      await replyHtml(ctx, messages.donateThanks);
      return;
    }
    const stars = payment.total_amount;
    deps.logger.info({ chargeId, stars }, 'donation recorded');
    await replyHtml(ctx, messages.donateThanks);
    // A refused notice (the admin never pressed /start) costs only the notice.
    try {
      await deps.notifyAdmin(messages.adminDonation({ stars, userId: result.userId, chargeId }));
    } catch (error) {
      deps.logger.warn(
        { chargeId, err: error instanceof Error ? error.message : typeof error },
        'admin donation notice failed',
      );
    }
  });
}
