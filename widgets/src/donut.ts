import { UNKNOWN, W, el, esc, frame, palette, state } from './runtime.js';

// The donut (ADR-0053): a period's or a tag's spend by category. chatData is src/domain/
// widgetData.ts's DonutData: [1, title, total, drill, lines, extra, retry], each line
// [label, minor, amount, token]. `minor` is geometry only: the program formats no money.
// With `drill` set, a tap on a slice or a legend row whose token isn't '' requests
// `d:<drill>:<token>`, and the answer, a DrillAnswer, turns the widget into that category's bars
// until [back] returns to the donut, locally. A failure shows its text under the legend and
// leaves the row tappable.

type Line = readonly [label: string, minor: number, amount: string, token: string];
type Point = readonly [label: string, minor: number, amount: string];
type Bars = readonly [v: 1, title: string, points: readonly Point[], back: string];

const root = frame(
  '.d{display:flex;justify-content:center;margin-bottom:8px}' +
    '.l{display:flex;align-items:center;gap:6px;padding:2px 0}' +
    '.s{flex:none;width:10px;height:10px;border-radius:3px}' +
    '.n{flex:1;min-width:0}.a{flex:none;text-align:right}.k{flex:none;width:28%}' +
    '.g{flex:1;height:8px}.b{height:8px;border-radius:2px;background:var(--tg-theme-button-color)}' +
    'button{margin-top:auto}',
);

// The row waiting for an answer, -1 for none; the last failure's text; the bars on screen.
let pending = -1;
let status = '';
let bars: Bars | undefined;

function lines(data: readonly unknown[]): readonly Line[] {
  return Array.isArray(data[4]) ? (data[4] as readonly Line[]) : [];
}

function draw(): void {
  const data = state(1);
  if (data === undefined) {
    root.replaceChildren(el('div', 'h', UNKNOWN));
    return;
  }
  if (bars !== undefined) {
    drawBars(bars);
    return;
  }
  const [, title, total, drill, , extra] = data as readonly string[];
  const shown = lines(data);
  const colors = palette(shown.length);
  const sum = shown.reduce((s, line) => s + Math.max(line[1], 0), 0) || 1;
  // r=15.9155 makes the circumference 100, so a slice's dash is its percent.
  let at = 0;
  const slices = shown
    .map((line, i) => {
      const len = (Math.max(line[1], 0) / sum) * 100;
      const arc = `<circle data-i="${i}" r="15.9155" cx="21" cy="21" fill="none" stroke="${colors[i] ?? ''}" stroke-width="6" stroke-dasharray="${len} ${100 - len}" stroke-dashoffset="${25 - at}"/>`;
      at += len;
      return arc;
    })
    .join('');
  const donut = el('div', 'd');
  donut.innerHTML =
    `<svg width="150" height="150" viewBox="0 0 42 42">${slices}` +
    `<text x="21" y="22.5" text-anchor="middle" font-size="4" font-weight="600" fill="currentColor">${esc(total ?? '')}</text></svg>`;
  donut.onclick = (event) => {
    const i = (event.target as Element | null)?.getAttribute('data-i');
    if (i !== null && i !== undefined) tap(Number(i));
  };
  const rows = shown.map((line, i) => {
    const row = el('div', 'l');
    const swatch = el('span', 's');
    swatch.style.background = colors[i] ?? '';
    const open = drill !== '' && line[3] !== '';
    row.append(
      swatch,
      el('span', 'n e', line[0]),
      el('span', 'a', (pending === i ? '…' : line[2]) + (open ? ' ›' : '')),
    );
    if (open)
      row.onclick = () => {
        tap(i);
      };
    return row;
  });
  const note = status !== '' ? status : (extra ?? '');
  root.replaceChildren(
    el('div', 't e', title ?? ''),
    donut,
    ...rows,
    ...(note === '' ? [] : [el('div', 'h e', note)]),
  );
}

function drawBars([, title, points, back]: Bars): void {
  const max = points.reduce((m, point) => Math.max(m, point[1]), 0) || 1;
  const rows = points.map((point) => {
    const row = el('div', 'l');
    const track = el('div', 'g');
    const bar = el('div', 'b');
    bar.style.width = `${(Math.max(point[1], 0) / max) * 100}%`;
    track.append(bar);
    row.append(el('span', 'k e', point[0]), track, el('span', 'a', point[2]));
    return row;
  });
  const button = el('button', '', back);
  button.onclick = () => {
    bars = undefined;
    draw();
  };
  root.replaceChildren(el('div', 't e', title), ...rows, button);
}

// Requests line `i`'s drill-down, synchronously inside the tap as Telegram requires.
function tap(i: number): void {
  const data = state(1);
  const line = data === undefined ? undefined : lines(data)[i];
  const drill = data?.[3];
  if (W === undefined || pending >= 0 || line === undefined || drill === '' || line[3] === '') {
    return;
  }
  const retry = typeof data?.[6] === 'string' ? data[6] : '';
  let request: Promise<{ readonly result: string | null }>;
  try {
    request = W.request(`d:${String(drill)}:${line[3]}`);
  } catch {
    return;
  }
  pending = i;
  status = '';
  draw();
  request
    .then(
      ({ result }) => {
        let answer: unknown;
        try {
          answer = JSON.parse(result ?? '');
        } catch {
          answer = undefined;
        }
        if (Array.isArray(answer) && answer[0] === 1 && answer.length === 4) {
          bars = answer as unknown as Bars;
        } else {
          status = Array.isArray(answer) && typeof answer[1] === 'string' ? answer[1] : retry;
        }
      },
      () => {
        status = retry;
      },
    )
    .finally(() => {
      pending = -1;
      draw();
    });
}

draw();
W?.onEvent('chatDataChanged', draw);
W?.ready();
