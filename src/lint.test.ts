import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

// Runs the repo's ESLint config on in-memory snippets. Type-aware rules are switched off: the
// snippets aren't files the TypeScript project knows, and the rules under test are syntactic.
const eslint = new ESLint({
  cwd: process.cwd(),
  overrideConfig: [tseslint.configs.disableTypeChecked],
});

async function restrictedSyntax(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === 'no-restricted-syntax')
    .map((message) => message.message);
}

const HANDLER = 'src/bot/handlers/snippet.ts';
const SEAM = /replyHtml \/ editHtml/;

describe('the HTML seam lint gate (ADR-0012)', () => {
  it.each([
    ['ctx.reply', "declare const ctx: any;\nvoid ctx.reply('x');\n"],
    ['ctx.editMessageText', "declare const ctx: any;\nvoid ctx.editMessageText('x');\n"],
    ['a parse_mode property', "export const extra = { parse_mode: 'HTML' };\n"],
  ])('rejects %s in a handler', async (_name, code) => {
    const errors = await restrictedSyntax(code, HANDLER);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(SEAM);
  });

  it('allows parse_mode inside src/bot/render/html.ts', async () => {
    const errors = await restrictedSyntax(
      "export const extra = { parse_mode: 'HTML' };\n",
      'src/bot/render/html.ts',
    );

    expect(errors).toEqual([]);
  });
});
