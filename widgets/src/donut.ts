import { UNKNOWN, W, el, esc, frame, palette, state } from './runtime.js';

// The donut (ADR-0053): a period's or a tag's spend by category. chatData is src/domain/
// widgetData.ts's DonutData: [1, title, total, drill, lines, extra, retry], each line
// [label, minor, amount, token]. `minor` is geometry only: the program formats no money.

type Line = readonly [label: string, minor: number, amount: string, token: string];

const root = frame(
  '.d{display:flex;justify-content:center;margin-bottom:8px}' +
    '.l{display:flex;align-items:center;gap:6px;padding:2px 0}' +
    '.s{flex:none;width:10px;height:10px;border-radius:3px}' +
    '.n{flex:1;min-width:0}.a{flex:none;text-align:right}',
);

function draw(): void {
  const data = state(1);
  if (data === undefined) {
    root.replaceChildren(el('div', 'h', UNKNOWN));
    return;
  }
  const [, title, total, , lines, extra] = data as [
    1,
    string,
    string,
    string,
    readonly Line[],
    string,
  ];
  const colors = palette(lines.length);
  const sum = lines.reduce((s, line) => s + Math.max(line[1], 0), 0) || 1;
  // r=15.9155 makes the circumference 100, so a slice's dash is its percent.
  let at = 0;
  const slices = lines
    .map((line, i) => {
      const len = (Math.max(line[1], 0) / sum) * 100;
      const arc = `<circle r="15.9155" cx="21" cy="21" fill="none" stroke="${colors[i] ?? ''}" stroke-width="6" stroke-dasharray="${len} ${100 - len}" stroke-dashoffset="${25 - at}"/>`;
      at += len;
      return arc;
    })
    .join('');
  const donut = el('div', 'd');
  donut.innerHTML =
    `<svg width="150" height="150" viewBox="0 0 42 42">${slices}` +
    `<text x="21" y="22.5" text-anchor="middle" font-size="4" font-weight="600" fill="currentColor">${esc(total)}</text></svg>`;
  const rows = lines.map((line, i) => {
    const row = el('div', 'l');
    const swatch = el('span', 's');
    swatch.style.background = colors[i] ?? '';
    row.append(swatch, el('span', 'n e', line[0]), el('span', 'a', line[2]));
    return row;
  });
  root.replaceChildren(
    el('div', 't e', title),
    donut,
    ...rows,
    ...(extra === '' ? [] : [el('div', 'h e', extra)]),
  );
}

draw();
W?.onEvent('chatDataChanged', draw);
W?.ready();
