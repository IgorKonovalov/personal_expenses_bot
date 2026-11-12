import { UNKNOWN, W, el, frame, state } from './runtime.js';

// Labelled horizontal bars (ADR-0053): /today's last seven days, and a product's price by month.
// chatData is src/domain/widgetData.ts's BarsData: [1, title, rows, highlight, extra], each row
// [label, minor, amount]. The highlighted row is drawn in the button colour and bold, the others
// in the hint colour. No taps.

type Row = readonly [label: string, minor: number, amount: string];

const root = frame(
  '.l{display:flex;align-items:center;gap:6px;padding:3px 0}.k{flex:none;width:30%}' +
    '.g{flex:1;height:10px}.b{height:10px;border-radius:3px;background:var(--tg-theme-hint-color)}' +
    '.c{font-weight:600}.c .b{background:var(--tg-theme-button-color)}.a{flex:none;text-align:right}',
);

function draw(): void {
  const data = state(1);
  if (data === undefined) {
    root.replaceChildren(el('div', 'h', UNKNOWN));
    return;
  }
  const [, title, rows, highlight, extra] = data as readonly [
    1,
    string,
    readonly Row[],
    number,
    string,
  ];
  const max = rows.reduce((m, row) => Math.max(m, row[1]), 0) || 1;
  const bars = rows.map((row, i) => {
    const line = el('div', i === highlight ? 'l c' : 'l');
    const track = el('div', 'g');
    const bar = el('div', 'b');
    bar.style.width = `${(Math.max(row[1], 0) / max) * 100}%`;
    track.append(bar);
    line.append(el('span', 'k e', row[0]), track, el('span', 'a', row[2]));
    return line;
  });
  root.replaceChildren(
    el('div', 't e', title),
    ...bars,
    ...(extra === '' ? [] : [el('div', 'h e', extra)]),
  );
}

draw();
W?.onEvent('chatDataChanged', draw);
W?.ready();
