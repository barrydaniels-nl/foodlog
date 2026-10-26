/** Foods whose micronutrients still need a look: confirm the AI match, change the twin or correct amounts. */
import { api } from '../api.js';
import { MICRO_BY_KEY } from '../shared/micronutrients.js';
import { parseNumber } from '../shared/nutrition.js';
import { h, guarded } from '../ui/dom.js';
import { microStatusChip } from '../ui/micro-status.js';
import { openNevoPicker } from '../ui/nevo-picker.js';
import { displayAmount } from '../ui/nutrient-rows.js';
import { toast, toastError } from '../ui/toast.js';

const UNCONFIRMED = 'unconfirmed';

/**
 * @param {HTMLElement} container
 */
export async function render(container) {
  const list = h('div', { class: 'review-list' });
  const count = h('p', { class: 'page-sub' });
  let cards = 0;

  container.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', { class: 'page-title' }, 'Match review'), count),
    ),
    list,
  );
  await load();

  function drawCount() {
    count.textContent = cards === 0 ? '' : `${cards} ${cards === 1 ? 'food' : 'foods'} to review`;
    if (cards === 0) {
      list.replaceChildren(
        h(
          'div',
          { class: 'empty-state' },
          h('h2', {}, 'All foods are matched.'),
          h('a', { class: 'btn btn-soft', href: '#/micros' }, 'Back to Micros'),
        ),
      );
    }
  }

  async function load() {
    const foods = await api.get('/api/micros/review');
    // Estimates are read per food; with a short list, loading them all at once is simpler than expanding cards.
    const estimates = await Promise.all(foods.map((food) => (food.aiKeys.length ? loadEstimates(food) : {})));
    cards = foods.length;
    list.replaceChildren(...foods.map((food, i) => reviewCard(food, estimates[i])));
    drawCount();
  }

  /** @returns {Promise<Record<string, number>>} AI amounts per 100 g; empty when they cannot be read */
  async function loadEstimates(food) {
    try {
      return (await api.get(`/api/ingredients/${food.id}/micros`)).ai;
    } catch (error) {
      toastError(error);
      return {};
    }
  }

  function reviewCard(food, estimates) {
    const card = h('article', { class: 'card review-card' });
    // What the server holds; edits are compared against it so only changed keys are sent.
    const saved = { ...estimates };
    const inputs = new Map();

    const save = h('button', { class: 'btn btn-sm', type: 'button', hidden: true, onclick: guarded(() => saveEdits()) }, 'Save changes');

    const fields = food.aiKeys.map((key) => {
      const micro = MICRO_BY_KEY[key];
      const input = h('input', {
        class: 'input',
        type: 'text',
        inputmode: 'decimal',
        autocomplete: 'off',
        value: displayAmount(saved[key]),
        oninput: () => {
          input.classList.remove('needs');
          save.hidden = changedKeys().length === 0;
        },
      });
      inputs.set(key, input);
      return h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label' }, micro.label),
        h('div', { class: 'input-wrap' }, input, h('span', { class: 'input-suffix' }, micro.unit)),
      );
    });

    function changedKeys() {
      return [...inputs].filter(([key, input]) => input.value.trim() !== displayAmount(saved[key])).map(([key]) => key);
    }

    /** @returns {Promise<boolean>} whether the edits (if any) are stored */
    async function saveEdits() {
      const values = {};
      for (const key of changedKeys()) {
        const amount = parseNumber(inputs.get(key).value);
        if (amount === null) {
          inputs.get(key).classList.add('needs');
          toast(`Enter ${MICRO_BY_KEY[key].label} as a number.`, { type: 'error' });
          return false;
        }
        values[key] = amount;
      }
      if (Object.keys(values).length === 0) return true;
      try {
        await api.put(`/api/ingredients/${food.id}/micros/values`, { values });
      } catch (error) {
        toastError(error);
        return false;
      }
      Object.assign(saved, values);
      for (const [key, amount] of Object.entries(values)) inputs.get(key).value = displayAmount(amount);
      save.hidden = true;
      toast(`Saved ${food.name}`);
      return true;
    }

    const approve = guarded(async () => {
      // Approving the match must not throw away amounts typed on this card.
      if (!(await saveEdits())) return;
      try {
        await api.post(`/api/ingredients/${food.id}/micros/confirm`);
        card.remove();
        cards -= 1;
        drawCount();
      } catch (error) {
        toastError(error);
      }
    });

    /** Re-reads the list afterwards: a new twin changes the food's status and estimates. */
    const setTwin = (code) =>
      api.put(`/api/ingredients/${food.id}/micros/twin`, { code }).then(() => load());

    const noTwin = guarded(async () => {
      try {
        await setTwin(null);
      } catch (error) {
        toastError(error);
      }
    });

    const source = food.twinName ?? food.twinCode ?? (food.aiKeys.length ? 'AI estimate' : 'none yet');
    // Native append would print the optional (null) children as the text "null".
    const children = [
      h(
        'div',
        { class: 'review-head' },
        h('div', { class: 'review-title' }, food.name, food.brand ? h('span', { class: 'list-sub', style: { display: 'block' } }, food.brand) : null),
        microStatusChip(food.status),
      ),
      h('p', { class: 'review-twin' }, 'Micronutrients from: ', h('strong', {}, source)),
      fields.length ? h('div', { class: 'grid-2' }, fields) : null,
      h(
        'div',
        { class: 'review-actions' },
        food.status === UNCONFIRMED ? h('button', { class: 'btn btn-sm', type: 'button', onclick: approve }, '✓ Confirm') : null,
        h(
          'button',
          { class: 'btn btn-soft btn-sm', type: 'button', onclick: () => openNevoPicker({ title: `Twin for ${food.name}`, onPick: setTwin }) },
          '✎ Change twin',
        ),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: noTwin }, '✕ No twin'),
        save,
      ),
    ];
    card.append(...children.filter(Boolean));
    return card;
  }
}
