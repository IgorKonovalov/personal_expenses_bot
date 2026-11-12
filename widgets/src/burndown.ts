import { UNKNOWN, W, el, frame, state } from './runtime.js';

// A budget period's burn-down (ADR-0053): what is left of the limit at the end of each elapsed
// day, against the ideal line falling from the limit to 0 at the period's end. chatData is
// src/domain/widgetData.ts's BurndownData: [1, title, status, remaining, limit, days, extra].
// The amounts are geometry only. No taps.

const root = frame('.v{flex:1;min-height:0;margin:8px 0}');

function draw(): void {
  const data = state(1);
  if (data === undefined) {
    root.replaceChildren(el('div', 'h', UNKNOWN));
    return;
  }
  const [, title, status, remaining, limit, days, extra] = data as readonly [
    1,
    string,
    string,
    readonly number[],
    number,
    number,
    string,
  ];
  const top = Math.max(limit, ...remaining, 1);
  const bottom = Math.min(0, ...remaining);
  const span = Math.max(days, 1);
  // A 300 x 200 box: x is the end of day d, y the amount.
  const x = (d: number) => Math.round((d / span) * 3000) / 10;
  const y = (amount: number) => Math.round((1 - (amount - bottom) / (top - bottom)) * 2000) / 10;
  const line = [`0,${y(limit)}`, ...remaining.map((left, i) => `${x(i + 1)},${y(left)}`)].join(' ');
  const chart = el('div', 'v');
  chart.innerHTML =
    '<svg width="100%" height="100%" viewBox="-4 -4 308 208" preserveAspectRatio="none">' +
    `<line x1="0" y1="${y(0)}" x2="300" y2="${y(0)}" stroke="var(--tg-theme-hint-color)" stroke-width="1"/>` +
    `<line x1="0" y1="${y(limit)}" x2="300" y2="${y(0)}" stroke="var(--tg-theme-hint-color)" stroke-width="1.5" stroke-dasharray="5 4"/>` +
    `<polyline points="${line}" fill="none" stroke="var(--tg-theme-button-color)" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
  root.replaceChildren(
    el('div', 't e', title),
    el('div', 'e', status),
    chart,
    ...(extra === '' ? [] : [el('div', 'h e', extra)]),
  );
}

draw();
W?.onEvent('chatDataChanged', draw);
W?.ready();
