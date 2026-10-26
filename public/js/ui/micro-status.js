/** How a food's micronutrient matching state is worded for the user. */
import { h } from './dom.js';

const STATUS_TEXT = Object.freeze({
  unconfirmed: 'AI-matched · unconfirmed',
  pending: 'No data yet',
  none: 'No data',
});

/**
 * @param {string} status a food's `micro_status`
 * @returns {string} anything not waiting for review reads as confirmed
 */
export function microStatusText(status) {
  return STATUS_TEXT[status] ?? 'confirmed';
}

/**
 * @param {string} status
 * @returns {HTMLElement}
 */
export function microStatusChip(status) {
  return h('span', { class: ['badge', status === 'unconfirmed' ? 'badge-warn' : 'badge-muted'] }, microStatusText(status));
}
