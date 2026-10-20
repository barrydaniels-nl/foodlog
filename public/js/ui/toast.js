/** Short, non-blocking notifications. */
import { h } from './dom.js';
import { icon } from './icons.js';

/**
 * @param {string} message
 * @param {{type?: 'info'|'error'}} [options]
 */
export function toast(message, { type = 'info' } = {}) {
  const host = document.getElementById('toasts');
  const element = h(
    'div',
    { class: ['toast', type === 'error' && 'toast-error'], role: type === 'error' ? 'alert' : null },
    type === 'error' ? null : icon('check', 18),
    h('span', {}, message),
  );
  host.append(element);
  requestAnimationFrame(() => element.classList.add('show'));
  setTimeout(
    () => {
      element.classList.remove('show');
      setTimeout(() => element.remove(), 300);
    },
    type === 'error' ? 4500 : 2600,
  );
}

/**
 * Shows an error toast for a failed action and logs the full error.
 * @param {unknown} error
 */
export function toastError(error) {
  console.error(error);
  toast(error instanceof Error ? error.message : 'Something went wrong', { type: 'error' });
}
