import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { messages } from '../messages.js';
import { createTestBot, textUpdate } from '../testHarness.js';

const root = new URL('../../../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), 'utf8');

// The backticked host names in a README section: `suf.purs.gov.rs`, not URLs or paths.
function hostsInSection(readme: string, heading: string): string[] {
  const start = readme.indexOf(`### ${heading}\n`);
  if (start < 0) throw new Error(`README has no ${heading} section`);
  const end = readme.indexOf('\n#', start + heading.length + 4);
  const section = readme.slice(start, end < 0 ? undefined : end);
  return [...section.matchAll(/`([a-z0-9-]+(?:\.[a-z0-9-]+)+)`/g)].map((m) => m[1] ?? '');
}

describe('/privacy', () => {
  it('replies the summary with the link to PRIVACY.md', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/privacy' }));

    expect(calls).toMatchObject([{ payload: { text: messages.privacy } }]);
    expect(messages.privacy).toContain(
      'https://github.com/IgorKonovalov/personal_expenses_bot/blob/main/PRIVACY.md',
    );
  });

  it('is listed in /help with /delete_account', () => {
    expect(messages.help).toContain('/privacy');
    expect(messages.help).toContain('/delete_account');
  });

  it('names every external host the README lists under Receipts and Currency conversion', () => {
    const readme = read('README.md');
    const hosts = [
      ...hostsInSection(readme, 'Receipts'),
      ...hostsInSection(readme, 'Currency conversion'),
    ];
    expect(hosts.length).toBeGreaterThanOrEqual(3);

    const policy = read('PRIVACY.md');
    for (const host of hosts) expect(policy, host).toContain(host);
  });

  it('lists donations among what is stored and what outlives /delete_account', () => {
    const policy = read('PRIVACY.md');
    expect(policy).toContain('- Пожертвования:');
    const deletion = policy.slice(policy.indexOf('## Удаление'));
    expect(deletion.slice(0, deletion.indexOf('\n## ', 1))).toContain('пожертвованиях');
    expect(messages.deleteAccountPrompt(14)).toContain('пожертвованиях');
  });
});
