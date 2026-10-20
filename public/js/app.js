/** Hash router: maps #/... URLs onto view modules. */
import { toIsoDate } from './shared/dates.js';
import { hydrateIcons } from './ui/icons.js';
import { h } from './ui/dom.js';
import * as dayView from './views/day.js';
import * as mealsView from './views/meals.js';
import * as foodsView from './views/foods.js';
import * as settingsView from './views/settings.js';

const ROUTES = [
  { pattern: /^#\/day\/(\d{4}-\d{2}-\d{2})$/, nav: 'day', view: dayView, params: (m) => ({ date: m[1] }) },
  { pattern: /^#\/meals\/(new|\d+)$/, nav: 'meals', view: mealsView, params: (m) => ({ id: m[1] }) },
  { pattern: /^#\/meals$/, nav: 'meals', view: mealsView, params: () => ({}) },
  { pattern: /^#\/foods$/, nav: 'foods', view: foodsView, params: () => ({}) },
  { pattern: /^#\/settings$/, nav: 'settings', view: settingsView, params: () => ({}) },
];

const main = document.getElementById('view');
let cleanup = null;

function todayHash() {
  return `#/day/${toIsoDate(new Date())}`;
}

async function route() {
  const hash = location.hash;
  const match = ROUTES.map((r) => ({ r, m: r.pattern.exec(hash) })).find(({ m }) => m);
  if (!match) {
    location.replace(todayHash());
    return;
  }

  for (const link of document.querySelectorAll('[data-nav]')) {
    link.classList.toggle('active', link.dataset.nav === match.r.nav);
    if (link.dataset.nav === match.r.nav) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  cleanup?.();
  cleanup = null;
  // Each navigation renders into a fresh section, so a slow, stale render
  // writes into a detached element instead of over the current view.
  const section = h('section', { class: 'page' });
  main.replaceChildren(section);
  try {
    const result = await match.r.view.render(section, match.r.params(match.m));
    if (typeof result === 'function') {
      if (section.isConnected) cleanup = result;
      else result();
    }
  } catch (error) {
    console.error('Failed to render view', error);
    section.replaceChildren(
      h(
        'div',
        { class: 'empty-state' },
        h('h2', {}, 'Could not load this page'),
        h('p', {}, error.message),
        h('button', { class: 'btn', type: 'button', onclick: () => route() }, 'Try again'),
      ),
    );
  }
}

// "Day" nav links always jump to today.
for (const link of document.querySelectorAll('a[href="#/day"]')) {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    location.hash = todayHash();
  });
}

hydrateIcons();
window.addEventListener('hashchange', route);
route();
