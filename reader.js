/* PhD public reader — pdf.js rendering engine (ES module, entry point).
 *
 * Design follows the proven MyPDFViewer / calculus-fennicus patterns:
 *   - continuous vertical scroll, one <canvas> per visible page
 *   - measure page geometry once (thesis pages are uniform Letter), lay out all
 *     placeholders up front, render lazily via IntersectionObserver, unrender
 *     far pages to cap memory
 *   - a real, selectable pdf.js TextLayer over each canvas (substrate for
 *     text-anchored commenting) + a lightweight external-link layer
 *
 * Exposes window.Reader for comments.js / auth.js to build on, then boots the
 * comment + auth layers.
 */
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

const CFG = window.PHD_VIEWER_CONFIG || {};
pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/worker-shim.mjs';

const KEEP_RENDERED = 8;                 // max pages kept rasterized at once
const MAX_DPR = 2;
const cMapUrl = './vendor/pdfjs/cmaps/';
const standardFontDataUrl = './vendor/pdfjs/standard_fonts/';

const stage = document.getElementById('stage');
const pagesEl = document.getElementById('pages');
const loading = document.getElementById('loading');
const loadingBar = document.querySelector('#loading .bar i');
const pageInput = document.getElementById('pageInput');
const pageTotal = document.getElementById('pageTotal');

const state = {
  pdf: null,
  n: 0,
  base: { w: 612, h: 792 },   // PDF-unit page size (from page 1)
  scale: 1,                   // pdf.js viewport scale (fit-width * zoom)
  zoom: 1,                    // user zoom multiplier on top of fit-width
  cur: 1,
  recs: new Map(),            // n -> { el, canvas, hl, link, rendered, rendering, task }
  order: [],                  // MRU list of rendered page numbers
  observer: null,
  paintedCbs: [],             // cb(n, el, hlEl) after a page's text layer is ready
};

/* ---------------- public API ---------------- */
const Reader = {
  cfg: CFG,
  ready: null,
  get numPages() { return state.n; },
  get pageEl() { return (n) => state.recs.get(n)?.el || null; },
  currentPage: () => state.cur,
  goToPage,
  onPainted: (cb) => { state.paintedCbs.push(cb); },
  // page number a DOM node lives in (walk up to the .page element), or 0
  pageOfNode(node) {
    let el = node && node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== pagesEl) {
      if (el.classList && el.classList.contains('page')) {
        const n = Number(el.dataset.n);
        return n || 0;
      }
      el = el.parentElement;
    }
    return 0;
  },
  hlLayer: (n) => state.recs.get(n)?.hl || null,
  isRendered: (n) => !!state.recs.get(n)?.rendered,
};
window.Reader = Reader;

/* ---------------- boot ---------------- */
Reader.ready = boot();
async function boot() {
  try {
    const task = pdfjsLib.getDocument({
      url: CFG.pdfUrl || './thesis.pdf',
      cMapUrl, cMapPacked: true, standardFontDataUrl,
      disableAutoFetch: true, disableStream: false,
    });
    task.onProgress = (p) => {
      if (p.total && loadingBar) loadingBar.style.width = Math.round((p.loaded / p.total) * 100) + '%';
    };
    state.pdf = await task.promise;
    state.n = state.pdf.numPages;
    pageTotal.textContent = '/ ' + state.n;

    const p1 = await state.pdf.getPage(1);
    const vp1 = p1.getViewport({ scale: 1 });
    state.base = { w: vp1.width, h: vp1.height };

    layout();
    setupObserver();
    setupNav();
    if (loading) loading.classList.add('hide');
    // Deep-link: #p=NN jumps to a page.
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return Reader;
  } catch (e) {
    if (loading) loading.innerHTML = '<p style="max-width:420px;text-align:center">Väitöskirjan lataus epäonnistui.<br><small>' +
      String(e && e.message || e) + '</small></p>';
    throw e;
  }
}

/* ---------------- layout ---------------- */
function fitScale() {
  const avail = Math.max(280, stage.clientWidth - 40);
  return (avail / state.base.w) * state.zoom;
}

function layout() {
  state.scale = fitScale();
  const cssW = Math.floor(state.base.w * state.scale);
  const cssH = Math.floor(state.base.h * state.scale);
  pagesEl.style.width = cssW + 'px';
  // (re)create placeholders
  for (let n = 1; n <= state.n; n++) {
    let rec = state.recs.get(n);
    if (!rec) {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.n = String(n);
      const hl = document.createElement('div'); hl.className = 'hl';
      el.appendChild(hl);
      pagesEl.appendChild(el);
      rec = { el, canvas: null, hl, link: null, rendered: false, rendering: false, task: null };
      state.recs.set(n, rec);
    }
    rec.el.style.width = cssW + 'px';
    rec.el.style.height = cssH + 'px';
  }
}

function relayoutRerender() {
  // Called on zoom / resize: drop all raster, resize boxes, re-observe.
  for (const [n, rec] of state.recs) unrender(n);
  layout();
  // force re-check of what is visible
  if (state.observer) { state.observer.disconnect(); setupObserver(); }
}

/* ---------------- render pipeline ---------------- */
function setupObserver() {
  state.observer = new IntersectionObserver(onIntersect, { root: stage, rootMargin: '900px 0px' });
  for (const rec of state.recs.values()) state.observer.observe(rec.el);
}
function onIntersect(entries) {
  for (const e of entries) {
    const n = Number(e.target.dataset.n);
    if (e.isIntersecting) render(n);
  }
  updateCur();
}

async function render(n) {
  const rec = state.recs.get(n);
  if (!rec || rec.rendered || rec.rendering) return;
  rec.rendering = true;
  try {
    const page = await state.pdf.getPage(n);
    const vp = page.getViewport({ scale: state.scale });
    // Correct placeholder if this page's size differs from page 1.
    rec.el.style.width = Math.floor(vp.width) + 'px';
    rec.el.style.height = Math.floor(vp.height) + 'px';

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = Math.floor(vp.width) + 'px';
    canvas.style.height = Math.floor(vp.height) + 'px';
    const ctx = canvas.getContext('2d', { alpha: false });
    rec.el.insertBefore(canvas, rec.hl); // canvas below hl + textlayer
    rec.canvas = canvas;

    rec.task = page.render({
      canvasContext: ctx, viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    });
    await rec.task.promise;

    await addTextLayer(rec, page, vp);
    await addLinkLayer(rec, page, vp);

    rec.rendered = true;
    rec.rendering = false;
    touch(n);
    for (const cb of state.paintedCbs) { try { cb(n, rec.el, rec.hl); } catch (_) {} }
  } catch (e) {
    rec.rendering = false;
    // Render cancelled (fast scroll) is normal; ignore.
  }
}

async function addTextLayer(rec, page, vp) {
  const div = document.createElement('div');
  div.className = 'textLayer';
  div.style.setProperty('--scale-factor', String(state.scale));
  rec.el.appendChild(div); // above canvas + hl (z-index in CSS)
  const tl = new pdfjsLib.TextLayer({
    textContentSource: page.streamTextContent({ includeMarkedContent: true }),
    container: div, viewport: vp,
  });
  await tl.render();
  rec.textDiv = div;
}

async function addLinkLayer(rec, page, vp) {
  let anns = [];
  try { anns = await page.getAnnotations({ intent: 'display' }); } catch (_) { return; }
  const links = anns.filter((a) => a.subtype === 'Link' && a.url);
  if (!links.length) return;
  const layer = document.createElement('div'); layer.className = 'linklayer';
  for (const a of links) {
    const r = pdfjsLib.Util.normalizeRect(a.rect);
    const [x1, y1] = vp.convertToViewportPoint(r[0], r[1]);
    const [x2, y2] = vp.convertToViewportPoint(r[2], r[3]);
    const el = document.createElement('a');
    el.href = a.url; el.target = '_blank'; el.rel = 'noopener';
    el.style.left = Math.min(x1, x2) + 'px';
    el.style.top = Math.min(y1, y2) + 'px';
    el.style.width = Math.abs(x2 - x1) + 'px';
    el.style.height = Math.abs(y2 - y1) + 'px';
    layer.appendChild(el);
  }
  rec.el.appendChild(layer);
  rec.link = layer;
}

function touch(n) {
  const i = state.order.indexOf(n);
  if (i >= 0) state.order.splice(i, 1);
  state.order.push(n);
  while (state.order.length > KEEP_RENDERED) {
    const victim = state.order.shift();
    // keep pages near the current view
    if (Math.abs(victim - state.cur) <= 2) { state.order.push(victim); continue; }
    unrender(victim);
  }
}

function unrender(n) {
  const rec = state.recs.get(n);
  if (!rec || !rec.rendered && !rec.rendering) return;
  if (rec.task) { try { rec.task.cancel(); } catch (_) {} rec.task = null; }
  if (rec.canvas) { rec.canvas.width = 0; rec.canvas.height = 0; rec.canvas.remove(); rec.canvas = null; }
  if (rec.textDiv) { rec.textDiv.remove(); rec.textDiv = null; }
  if (rec.link) { rec.link.remove(); rec.link = null; }
  rec.hl.innerHTML = '';
  rec.rendered = false; rec.rendering = false;
  const i = state.order.indexOf(n); if (i >= 0) state.order.splice(i, 1);
}

/* ---------------- navigation ---------------- */
function updateCur() {
  const mid = stage.scrollTop + stage.clientHeight * 0.42;
  let best = state.cur, bestD = Infinity;
  for (const [n, rec] of state.recs) {
    const top = rec.el.offsetTop, bot = top + rec.el.offsetHeight;
    const d = (mid < top) ? top - mid : (mid > bot ? mid - bot : 0);
    if (d < bestD) { bestD = d; best = n; }
  }
  if (best !== state.cur) {
    state.cur = best;
    if (document.activeElement !== pageInput) pageInput.value = String(best);
    history.replaceState(null, '', '#p=' + best);
  }
}

function goToPage(n) {
  n = Math.max(1, Math.min(state.n, n | 0));
  const rec = state.recs.get(n);
  if (!rec) return;
  render(n);
  stage.scrollTo({ top: rec.el.offsetTop - 12, behavior: 'smooth' });
  state.cur = n; pageInput.value = String(n);
}

function applyHash() {
  const m = /(?:^|[#&])p=(\d+)/.exec(location.hash);
  if (m) goToPage(Number(m[1]));
}

function setupNav() {
  let raf = 0;
  stage.addEventListener('scroll', () => {
    if (raf) return; raf = requestAnimationFrame(() => { raf = 0; updateCur(); });
  }, { passive: true });

  document.getElementById('prev').onclick = () => goToPage(state.cur - 1);
  document.getElementById('next').onclick = () => goToPage(state.cur + 1);
  pageInput.addEventListener('change', () => goToPage(Number(pageInput.value)));
  document.getElementById('zin').onclick = () => setZoom(state.zoom * 1.15);
  document.getElementById('zout').onclick = () => setZoom(state.zoom / 1.15);
  document.getElementById('zfit').onclick = () => setZoom(1);

  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(relayoutRerender, 200); });

  window.addEventListener('keydown', (e) => {
    if (/input|textarea/i.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { goToPage(state.cur + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { goToPage(state.cur - 1); e.preventDefault(); }
  });
}

function setZoom(z) {
  state.zoom = Math.max(0.5, Math.min(4, z));
  const anchor = state.cur;
  relayoutRerender();
  requestAnimationFrame(() => goToPage(anchor));
}

/* ---------------- boot comment + auth layers ---------------- */
import('./auth.js').then((m) => m.initAuth(CFG)).catch((e) => console.warn('auth init', e));
import('./comments.js').then((m) => m.initComments(Reader, CFG)).catch((e) => console.warn('comments init', e));
