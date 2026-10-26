/** "Analyse day": the AI review of a planned day, shown in a sheet. */
import { api } from '../api.js';
import { h } from './dom.js';
import { openSheet } from './sheet.js';

let enabled = null;

/**
 * Whether the server has an OpenAI key. Asked once per page load; a failure
 * hides the feature instead of breaking the Day screen.
 * @returns {Promise<boolean>}
 */
export function analysisEnabled() {
  enabled ??= api
    .get('/api/analysis/status')
    .then((status) => status?.enabled === true)
    .catch((error) => {
      console.error('Could not check whether day analysis is on', error);
      return false;
    });
  return enabled;
}

function section(title, ...content) {
  return h('section', { class: 'analysis-section' }, h('h3', { class: 'section-label' }, title), ...content);
}

function tips(list) {
  return h('ul', { class: 'analysis-tips' }, list.map((tip) => h('li', {}, tip)));
}

/**
 * Opens the sheet and asks for an analysis of `date`. AI text is only ever
 * inserted as text, never as HTML.
 * @param {{date: string}} options
 */
export function openDayAnalysis({ date }) {
  const sheet = openSheet({ title: 'Day analysis', content: h('div') });
  let request = 0;

  const refreshButton = () =>
    h('button', { class: 'btn btn-soft btn-block analysis-refresh', type: 'button', onclick: load }, 'Refresh');

  async function load() {
    const current = ++request;
    sheet.setContent(
      h('div', { class: 'analysis', 'aria-busy': 'true' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })),
    );
    let content;
    try {
      const { summary, protein, calories, micronutrients } = await api.post(`/api/days/${date}/analysis`);
      content = h(
        'div',
        { class: 'analysis' },
        section('Your day', h('p', { class: 'analysis-summary' }, summary)),
        protein.length > 0 ? section('More protein', tips(protein)) : null,
        calories.length > 0 ? section('Fewer calories', tips(calories)) : null,
        micronutrients.length > 0 ? section('Micronutrients', tips(micronutrients)) : null,
        refreshButton(),
      );
    } catch (error) {
      console.error(error);
      content = h('div', { class: 'analysis' }, h('p', { class: 'analysis-error' }, error.message), refreshButton());
    }
    // A slower earlier request must not overwrite a newer one.
    if (current === request) sheet.setContent(content);
  }

  load();
}
