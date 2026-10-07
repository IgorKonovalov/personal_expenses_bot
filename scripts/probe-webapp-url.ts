// `pnpm probe:webapp` (Plan 0041 Phase 3): measures how long a `web_app` button URL real clients
// open. It sends the admin one message with one button per target length of the `z` value, each a
// valid v2 chart payload (ADR-0045) titled «Проба N» whose one-line pie says which size arrived
// whole, padded to its length by an incompressible random string in a section the page skips.
// Reads BOT_TOKEN, ADMIN_TELEGRAM_ID and WEBAPP_URL from the environment. Prints only sizes and
// the Bot API's error descriptions: never the token or a URL.
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { CHART_PAYLOAD_VERSION, type PieSection } from '../src/domain/chartPayload.js';

export const PROBE_TARGETS = [2048, 4096, 8192, 16384, 32768] as const;

// The `z` value of a probe payload no longer than `target` characters, and at most a few short of
// it. `random` gives `n` random bytes; the pad is their base64url, which deflate can't shrink much,
// so every pad character costs about one `z` character and the length can be aimed at.
export function probePayload(
  target: number,
  random: (n: number) => Uint8Array = (n) => randomBytes(n),
): string {
  const noise = Buffer.from(random(target)).toString('base64url');
  const encode = (padLength: number) => {
    const pie: PieSection = {
      k: 'pie',
      currency: 'RSD',
      totalMinor: 1,
      totalLabel: `${target} символов`,
      lines: [[`Проба ${target}`, 1, `${target} символов`, '100%']],
      unconverted: [],
    };
    const payload = {
      v: CHART_PAYLOAD_VERSION,
      title: `Проба ${target}`,
      sections: [pie, { k: 'probe', pad: noise.slice(0, padLength) }],
    };
    return deflateSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64url');
  };
  let padLength = Math.min(target, noise.length);
  let z = encode(padLength);
  while (z.length > target && padLength > 0) {
    padLength = Math.max(0, padLength - Math.max(1, Math.ceil((z.length - target) * 0.75)));
    z = encode(padLength);
  }
  // Each step above may undershoot: grow back one character at a time while it still fits.
  while (padLength < noise.length) {
    const longer = encode(padLength + 1);
    if (longer.length > target) break;
    padLength++;
    z = longer;
  }
  if (z.length > target) throw new RangeError(`no probe payload fits ${target} characters`);
  return z;
}

interface BotApiReply {
  readonly ok: boolean;
  readonly description?: string;
}

async function sendButtons(
  token: string,
  chatId: string,
  webappUrl: string,
  targets: readonly number[],
): Promise<BotApiReply> {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `Проба длины ссылки: ${targets.join(', ')}`,
      reply_markup: {
        inline_keyboard: targets.map((target) => [
          { text: `Проба ${target}`, web_app: { url: `${webappUrl}#z=${probePayload(target)}` } },
        ]),
      },
    }),
  });
  return (await response.json()) as BotApiReply;
}

// One message with every size; when the Bot API refuses it, each size alone, so the ones it
// accepts are still sent and each refusal is printed with its size. `log` gets only sizes, the
// Bot API's error descriptions and the name of a missing variable. A failed request is reported
// without its error, whose text could carry the request URL and so the token. False on any
// failure.
export async function runProbe(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
): Promise<boolean> {
  const missing = ['BOT_TOKEN', 'ADMIN_TELEGRAM_ID', 'WEBAPP_URL'].filter(
    (name) => (env[name] ?? '') === '',
  );
  const [token = '', chatId = '', webappUrl = ''] = [
    env['BOT_TOKEN'],
    env['ADMIN_TELEGRAM_ID'],
    env['WEBAPP_URL'],
  ];
  if (missing.length > 0) {
    log(`not set: ${missing.join(', ')}`);
    return false;
  }
  try {
    const all = await sendButtons(token, chatId, webappUrl, PROBE_TARGETS);
    if (all.ok) {
      log(`sent: ${PROBE_TARGETS.join(', ')}`);
      return true;
    }
    log(`refused together: ${all.description ?? 'no description'}`);
    let sentAny = false;
    for (const target of PROBE_TARGETS) {
      const one = await sendButtons(token, chatId, webappUrl, [target]);
      sentAny ||= one.ok;
      log(one.ok ? `sent: ${target}` : `refused ${target}: ${one.description ?? 'no description'}`);
    }
    return sentAny;
  } catch {
    log('the request to the Bot API failed');
    return false;
  }
}

// Run as a script, not when the test imports this module.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (
    !(await runProbe(process.env, (line) => {
      console.log(line);
    }))
  )
    process.exitCode = 1;
}
