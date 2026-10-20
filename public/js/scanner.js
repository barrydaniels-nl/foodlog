/**
 * Camera barcode scanning. Uses the native BarcodeDetector where it can read
 * EAN codes; otherwise (iPhone Safari) lazily loads the bundled ZXing
 * WebAssembly ponyfill served from /vendor — never from a CDN.
 */
import { h } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { openSheet } from './ui/sheet.js';

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const DETECT_INTERVAL_MS = 250;
const BARCODE_PATTERN = /^\d{8,14}$/;

let detectorPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load the barcode scanner'));
    document.head.append(script);
  });
}

async function createDetector() {
  if ('BarcodeDetector' in window) {
    const supported = await window.BarcodeDetector.getSupportedFormats().catch(() => []);
    if (supported.includes('ean_13')) return new window.BarcodeDetector({ formats: FORMATS });
  }
  if (!window.BarcodeDetectionAPI) await loadScript('/vendor/barcode-detector.js');
  const { BarcodeDetector, prepareZXingModule } = window.BarcodeDetectionAPI;
  prepareZXingModule({
    overrides: {
      locateFile: (path, prefix) => (path.endsWith('.wasm') ? '/vendor/zxing_reader.wasm' : prefix + path),
    },
  });
  return new BarcodeDetector({ formats: FORMATS });
}

function getDetector() {
  detectorPromise ??= createDetector().catch((error) => {
    detectorPromise = null;
    throw error;
  });
  return detectorPromise;
}

/** @returns {boolean} whether this browser can try camera scanning at all */
export function scannerAvailable() {
  return Boolean(navigator.mediaDevices?.getUserMedia) || !window.isSecureContext;
}

/** A small form for typing the barcode printed under the stripes. */
function typedBarcodeForm(onCode) {
  const input = h('input', {
    class: 'input',
    type: 'text',
    inputmode: 'numeric',
    placeholder: 'e.g. 8710400000000',
    maxlength: '14',
    'aria-label': 'Barcode number',
    autocomplete: 'off',
  });
  const error = h('p', { class: 'form-error', hidden: true }, 'A barcode has 8 to 14 digits.');
  return h(
    'form',
    {
      onsubmit: (event) => {
        event.preventDefault();
        const code = input.value.replace(/\s/g, '');
        if (!BARCODE_PATTERN.test(code)) {
          error.hidden = false;
          return;
        }
        onCode(code);
      },
    },
    error,
    h('div', { class: 'search-row' }, h('div', { style: { flex: 1 } }, input), h('button', { class: 'btn', type: 'submit' }, 'Look up')),
  );
}

/**
 * Opens the camera and resolves with the first barcode read, a typed
 * barcode, or null when the user closes the scanner.
 * @returns {Promise<string|null>}
 */
export function scanBarcode() {
  return new Promise((resolve) => {
    let stream = null;
    let frame = null;
    let settled = false;
    let sheet = null;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (frame) cancelAnimationFrame(frame);
      for (const track of stream?.getTracks() ?? []) track.stop();
      sheet?.close();
      resolve(code);
    };

    const typed = typedBarcodeForm(finish);

    if (!window.isSecureContext) {
      sheet = openSheet({
        title: 'Type the barcode',
        content: h(
          'div',
          {},
          h(
            'p',
            { class: 'notice' },
            'The camera only works on the https address (Tailscale Serve). You can type the barcode instead.',
          ),
          typed,
        ),
        onClose: () => finish(null),
      });
      return;
    }

    const video = h('video', { playsinline: true, muted: true, autoplay: true });
    const status = h('div', { class: 'scanner-status' }, 'Starting camera…');
    sheet = openSheet({
      title: 'Scan barcode',
      content: h(
        'div',
        {},
        h('div', { class: 'scanner' }, video, h('div', { class: 'scanner-frame' }), status),
        h('div', { class: 'section-label', style: { marginTop: '4px' } }, 'Or type the number'),
        typed,
      ),
      onClose: () => finish(null),
    });

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        });
        if (settled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        video.srcObject = stream;
        await video.play();
        const detector = await getDetector();
        status.textContent = 'Point at a barcode';
        let last = 0;
        const tick = async (time) => {
          if (settled) return;
          if (time - last >= DETECT_INTERVAL_MS && video.readyState >= 2) {
            last = time;
            try {
              const [hit] = await detector.detect(video);
              if (hit?.rawValue && BARCODE_PATTERN.test(hit.rawValue)) {
                navigator.vibrate?.(60);
                finish(hit.rawValue);
                return;
              }
            } catch (error) {
              console.error('Barcode detection failed', error);
            }
          }
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      } catch (error) {
        console.error('Camera unavailable', error);
        status.replaceChildren(
          icon('x', 16),
          error.name === 'NotAllowedError' ? ' Camera access was denied. Type the barcode below.' : ' Camera unavailable. Type the barcode below.',
        );
      }
    })();
  });
}
