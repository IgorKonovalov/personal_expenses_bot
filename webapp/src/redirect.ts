// The page's payload keys: `z` and `d` carry a chart, `m` names a mode. A visit whose fragment
// carries none of them came from no bot button (a bare link, a search result), so the page
// sends it to the docs site published beside it (ADR-0048). Telegram's own launch parameters
// (`tgWebAppData` and others) are not a payload.
const PAYLOAD_KEYS = ['z', 'd', 'm'] as const;

export const DOCS_PATH = './docs/';

export function redirectsToDocs(hash: string): boolean {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return !PAYLOAD_KEYS.some((key) => params.has(key));
}
