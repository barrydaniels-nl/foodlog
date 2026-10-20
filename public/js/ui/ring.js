/** Progress ring card: planned value against a daily target. */
import { h, fmt } from './dom.js';

const SIZE = 60;
const STROKE = 7;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const OVER_COLOR = '#e0a030';

/**
 * @param {{value: number, target: number, color: string, track: string, label: string, unit?: string}} options
 * @returns {HTMLElement}
 */
export function ring({ value, target, color, track, label, unit = '' }) {
  const ratio = target > 0 ? value / target : 0;
  const over = value > target;
  const offset = CIRCUMFERENCE * (1 - Math.min(ratio, 1));

  const progress = h('svg:circle', {
    class: 'ring-progress',
    cx: SIZE / 2,
    cy: SIZE / 2,
    r: RADIUS,
    fill: 'none',
    stroke: over ? OVER_COLOR : color,
    'stroke-width': STROKE,
    'stroke-linecap': 'round',
    'stroke-dasharray': CIRCUMFERENCE,
    // Start empty and animate to the real value on the next frame.
    'stroke-dashoffset': CIRCUMFERENCE,
  });
  requestAnimationFrame(() => requestAnimationFrame(() => progress.setAttribute('stroke-dashoffset', offset)));

  const svg = h(
    'svg:svg',
    { width: SIZE, height: SIZE, viewBox: `0 0 ${SIZE} ${SIZE}`, 'aria-hidden': 'true' },
    h('svg:circle', { cx: SIZE / 2, cy: SIZE / 2, r: RADIUS, fill: 'none', stroke: track, 'stroke-width': STROKE }),
    progress,
  );

  const caption = over
    ? `over by ${fmt(value - target)}${unit} ${label}`
    : `of ${fmt(target)}${unit} ${label}`;

  return h(
    'div',
    { class: ['ring-card', over && 'over'], role: 'group', 'aria-label': `${fmt(value)}${unit} ${caption}` },
    h('div', { class: 'ring' }, svg, h('span', { class: 'ring-pct' }, `${Math.round(ratio * 100)}%`)),
    h('div', {}, h('div', { class: 'ring-value' }, `${fmt(value)}${unit}`), h('div', { class: 'ring-label' }, caption)),
  );
}
