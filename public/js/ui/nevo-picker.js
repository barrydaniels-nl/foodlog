/**
 * Sheet for choosing the NEVO food whose micronutrients stand in for one of
 * your foods (its "twin"), or choosing no twin so the AI estimates instead.
 */
import { api } from '../api.js';
import { h, debounce } from './dom.js';
import { icon } from './icons.js';
import { openSheet } from './sheet.js';
import { toastError } from './toast.js';

const DEBOUNCE_MS = 200;

/**
 * @param {{title?: string, onPick: (code: number|null) => Promise<void>|void}} options
 *   `onPick(null)` means no twin; the sheet closes once `onPick` resolves, and stays open if it throws
 */
export function openNevoPicker({ title = 'Choose a NEVO twin', onPick }) {
  const sheet = openSheet({ title, content: h('div', {}, h('div', { class: 'skeleton' })) });
  let busy = false;

  async function choose(code) {
    if (busy) return;
    busy = true;
    try {
      await onPick(code);
      sheet.close();
    } catch (error) {
      toastError(error);
    } finally {
      busy = false;
    }
  }

  const noTwin = h(
    'button',
    { class: 'btn btn-soft btn-block', type: 'button', style: { marginTop: '12px' }, onclick: () => choose(null) },
    'No twin — estimate with AI',
  );

  function resultItem(food) {
    return h(
      'button',
      { class: 'list-item', type: 'button', onclick: () => choose(food.code) },
      h(
        'span',
        { class: 'list-main' },
        h('span', { class: 'list-title', style: { display: 'block' } }, food.group ? `${food.name} · ${food.group}` : food.name),
        food.nameEn ? h('span', { class: 'list-sub', style: { display: 'block' } }, food.nameEn) : null,
      ),
    );
  }

  function searchView() {
    let sequence = 0;
    const results = h('div', { class: 'list' });
    async function refresh() {
      const mine = ++sequence;
      const q = input.value.trim();
      if (!q) {
        results.replaceChildren();
        return;
      }
      try {
        const foods = await api.get(`/api/reference/search?q=${encodeURIComponent(q)}&all=1`);
        if (mine !== sequence) return;
        results.replaceChildren(...(foods.length ? foods.map(resultItem) : [h('p', { class: 'muted', style: { margin: '4px' } }, 'No NEVO foods found.')]));
      } catch (error) {
        if (mine !== sequence) return;
        console.error(error);
        results.replaceChildren(h('p', { class: 'form-error' }, error.message));
      }
    }
    const input = h('input', {
      class: 'input',
      type: 'search',
      placeholder: 'Search NEVO',
      'aria-label': 'Search NEVO',
      autocomplete: 'off',
      oninput: debounce(refresh, DEBOUNCE_MS),
    });
    setTimeout(() => input.focus({ preventScroll: true }), 320);
    return h('div', {}, h('div', { class: 'search-input' }, icon('search', 18), input), h('div', { style: { marginTop: '12px' } }, results), noTwin);
  }

  api
    .get('/api/reference/status')
    .then(({ nevo }) =>
      sheet.setContent(nevo ? searchView() : h('div', {}, h('p', { class: 'notice' }, 'Upload the NEVO file in Settings first.'), noTwin)),
    )
    .catch((error) => {
      toastError(error);
      sheet.close();
    });
}
