/**
 * Minimal DOM builder. Text always becomes text nodes, so user content can
 * never be interpreted as HTML.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function appendChildren(element, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/**
 * @param {string} tag prefix with `svg:` for SVG elements
 * @param {Record<string, any>|null} [attrs] `on*` functions become listeners
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const isSvg = tag.startsWith('svg:');
  const element = isSvg ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class') {
      element.setAttribute('class', Array.isArray(value) ? value.filter(Boolean).join(' ') : value);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [name, styleValue] of Object.entries(value)) {
        // Custom properties (--x) are ignored by plain assignment; they need setProperty.
        if (name.startsWith('--')) element.style.setProperty(name, String(styleValue));
        else element.style[name] = styleValue;
      }
    } else if (key === 'dataset') {
      Object.assign(element.dataset, value);
    } else if (!isSvg && ['value', 'checked', 'disabled', 'selected'].includes(key)) {
      element[key] = value;
    } else {
      element.setAttribute(key, value === true ? '' : String(value));
    }
  }
  appendChildren(element, children);
  return element;
}

/**
 * @param {number} value
 * @param {number} [decimals]
 * @returns {string} e.g. "1,640" or "7.8"
 */
export function fmt(value, decimals = 0) {
  return Number(value ?? 0).toLocaleString('en-GB', { maximumFractionDigits: decimals });
}

/**
 * Wraps an async event handler so taps while it is still running are ignored;
 * the element that triggered it shows a loading state meanwhile.
 * @param {(event: Event) => Promise<void>} fn
 * @returns {(event: Event) => Promise<void>}
 */
export function guarded(fn) {
  let running = false;
  return async (event) => {
    if (running) return;
    running = true;
    const target = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    target?.classList.add('loading');
    try {
      await fn(event);
    } finally {
      running = false;
      target?.classList.remove('loading');
    }
  };
}

/**
 * @param {Function} fn
 * @param {number} ms
 */
export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
