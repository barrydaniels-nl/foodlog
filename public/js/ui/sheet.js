/**
 * Modal sheet: slides up from the bottom on phones, a centred dialog on
 * desktop. Multi-step flows swap content inside one sheet via setContent.
 */
import { h } from './dom.js';
import { icon } from './icons.js';

let openCount = 0;
const SWIPE_CLOSE_PX = 110;

/**
 * @param {{title: string, content: Node, onClose?: () => void}} options
 * @returns {{close: () => void, body: HTMLElement, setTitle: (t: string) => void, setContent: (n: Node) => void}}
 */
export function openSheet({ title, content, onClose }) {
  const previousFocus = document.activeElement;
  const titleEl = h('h2', { class: 'sheet-title' }, title);
  const body = h('div', { class: 'sheet-body' }, content);
  const grip = h('div', { class: 'sheet-grip' }, h('span'));
  const header = h(
    'header',
    { class: 'sheet-header' },
    titleEl,
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => close() }, icon('x')),
  );
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, grip, header, body);
  const backdrop = h('div', { class: 'sheet-backdrop' }, panel);
  let closed = false;

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });

  function onKey(event) {
    if (event.key === 'Escape' && backdrop === document.querySelector('.sheet-backdrop:last-of-type')) close();
  }
  document.addEventListener('keydown', onKey);

  // Swipe down on the grip/header to dismiss.
  let startY = null;
  for (const handle of [grip, header]) {
    handle.addEventListener('touchstart', (e) => (startY = e.touches[0].clientY), { passive: true });
    handle.addEventListener(
      'touchmove',
      (e) => {
        if (startY === null) return;
        const dy = Math.max(0, e.touches[0].clientY - startY);
        panel.style.transform = `translateY(${dy}px)`;
        panel.style.transition = 'none';
      },
      { passive: true },
    );
    handle.addEventListener('touchend', (e) => {
      if (startY === null) return;
      const dy = e.changedTouches[0].clientY - startY;
      startY = null;
      panel.style.transition = '';
      panel.style.transform = '';
      if (dy > SWIPE_CLOSE_PX) close();
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 240);
    openCount -= 1;
    if (openCount === 0) document.body.classList.remove('no-scroll');
    onClose?.();
    if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
  }

  document.body.append(backdrop);
  openCount += 1;
  document.body.classList.add('no-scroll');
  requestAnimationFrame(() => backdrop.classList.add('open'));

  return {
    close,
    body,
    setTitle(text) {
      titleEl.textContent = text;
      panel.setAttribute('aria-label', text);
    },
    setContent(node) {
      body.replaceChildren(node);
      body.scrollTop = 0;
    },
  };
}

/**
 * A row of pill buttons where exactly one is active.
 * @param {Array<{value: string, label: string}>} options
 * @param {string} selected
 * @param {(value: string) => void} onChange
 * @returns {HTMLElement}
 */
export function segmented(options, selected, onChange) {
  const buttons = options.map(({ value, label }) =>
    h(
      'button',
      {
        type: 'button',
        class: ['seg', value === selected && 'active'],
        'aria-pressed': String(value === selected),
        onclick: () => {
          for (const button of buttons) {
            const active = button === buttonFor(value);
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
          }
          onChange(value);
        },
      },
      label,
    ),
  );
  const buttonFor = (value) => buttons[options.findIndex((o) => o.value === value)];
  return h('div', { class: 'segmented', role: 'group' }, buttons);
}
