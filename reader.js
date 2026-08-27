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
  back: [],                   // scroll positions before followed links (Alt+← / "back")
  destCache: new Map(),       // named destination -> resolved {page, top}
};

/* ---------------- public API ---------------- */
const Reader = {
  cfg: CFG,
  ready: null,
  get numPages() { return state.n; },
  get pageEl() { return (n) => state.recs.get(n)?.el || null; },
  currentPage: () => state.cur,
  goToPage,
  goToDest,
  goBack,
  setZoom,
  get zoom() { return state.zoom; },
  get pdf() { return state.pdf; },
  scrollToFraction,
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
      // ?v=<build> busts the GitHub Pages / browser cache on every publish
      url: (CFG.pdfUrl || './thesis.pdf') + (CFG.buildVersion && CFG.buildVersion !== 'dev' ? '?v=' + encodeURIComponent(CFG.buildVersion) : ''),
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
  // External (URL) links AND internal links (named / explicit destinations —
  // the table of contents, cross-references, citations, footnotes).
  const links = anns.filter((a) => a.subtype === 'Link' && (a.url || a.dest || (a.action && /GoTo/i.test(a.action))));
  if (!links.length) return;
  const layer = document.createElement('div'); layer.className = 'linklayer';
  for (const a of links) {
    const r = pdfjsLib.Util.normalizeRect(a.rect);
    const [x1, y1] = vp.convertToViewportPoint(r[0], r[1]);
    const [x2, y2] = vp.convertToViewportPoint(r[2], r[3]);
    const el = document.createElement('a');
    if (a.url) {
      el.href = a.url; el.target = '_blank'; el.rel = 'noopener'; el.title = a.url;
    } else {
      const dest = a.dest;
      el.href = '#'; el.className = 'internal';
      el.title = typeof dest === 'string' ? dest.replace(/^(section|subsection|subsubsection|chapter|figure|table|cite|equation|Hfootnote|page)\./, '') : 'Siirry';
      el.addEventListener('click', (ev) => { ev.preventDefault(); goToDest(dest); });
    }
    el.style.left = Math.min(x1, x2) + 'px';
    el.style.top = Math.min(y1, y2) + 'px';
    el.style.width = Math.abs(x2 - x1) + 'px';
    el.style.height = Math.abs(y2 - y1) + 'px';
    layer.appendChild(el);
  }
  rec.el.appendChild(layer);
  rec.link = layer;
}

/* Resolve a pdf.js destination (name string or explicit array) to
 * { page (1-based), top (PDF units from the page bottom, or null) }. */
async function resolveDest(dest) {
  if (!dest) return null;
  const key = typeof dest === 'string' ? dest : null;
  if (key && state.destCache.has(key)) return state.destCache.get(key);
  let arr = dest;
  if (typeof dest === 'string') {
    try { arr = await state.pdf.getDestination(dest); } catch (_) { arr = null; }
  }
  if (!Array.isArray(arr) || !arr.length) return null;
  let page = 0;
  const ref = arr[0];
  try {
    if (typeof ref === 'number') page = ref + 1;                  // page index (rare)
    else if (ref && typeof ref === 'object') page = (await state.pdf.getPageIndex(ref)) + 1;
  } catch (_) { page = 0; }
  if (!page) return null;
  // /XYZ left top zoom | /FitH top | /FitBH top | /Fit | /FitV left ...
  const kind = arr[1] && arr[1].name ? arr[1].name : String(arr[1] || '');
  let top = null;
  if (kind === 'XYZ') top = typeof arr[3] === 'number' ? arr[3] : null;
  else if (kind === 'FitH' || kind === 'FitBH') top = typeof arr[2] === 'number' ? arr[2] : null;
  else if (kind === 'FitR') top = typeof arr[5] === 'number' ? arr[5] : null;
  const out = { page, top };
  if (key) state.destCache.set(key, out);
  return out;
}

async function goToDest(dest) {
  const d = await resolveDest(dest);
  if (!d) return;
  pushBack();
  const rec = state.recs.get(d.page);
  if (!rec) return;
  render(d.page);
  // Convert the PDF-space "top" (from the page bottom) into CSS px from the page top.
  let y = 0;
  if (typeof d.top === 'number') {
    const pageH = rec.el.offsetHeight || state.base.h * state.scale;
    const unitsH = state.base.h; // thesis pages are uniform; good enough for a scroll target
    y = Math.max(0, Math.min(pageH, (unitsH - d.top) * (pageH / unitsH)));
  }
  stage.scrollTo({ top: rec.el.offsetTop + y - 12, behavior: 'smooth' });
  state.cur = d.page; pageInput.value = String(d.page);
  history.replaceState(null, '', '#p=' + d.page);
}

/* Scroll so that the point at page fraction fy (0 = top of page n) sits ~1/3
 * down the viewport. Used by search results. */
function scrollToFraction(n, fy, behavior = 'smooth') {
  const rec = state.recs.get(n); if (!rec) return;
  render(n);
  const y = rec.el.offsetTop + (rec.el.offsetHeight || state.base.h * state.scale) * (fy || 0);
  stage.scrollTo({ top: Math.max(0, y - stage.clientHeight / 3), behavior });
  state.cur = n; pageInput.value = String(n);
  history.replaceState(null, '', '#p=' + n);
}

function pushBack() {
  state.back.push({ top: stage.scrollTop, left: stage.scrollLeft, zoom: state.zoom });
  if (state.back.length > 50) state.back.shift();
  updateBackBtn();
}
function goBack() {
  const b = state.back.pop();
  updateBackBtn();
  if (!b) return;
  if (b.zoom !== state.zoom) { setZoom(b.zoom, { keepView: false }); }
  requestAnimationFrame(() => stage.scrollTo({ top: b.top, left: b.left, behavior: 'smooth' }));
}
function updateBackBtn() {
  const b = document.getElementById('back');
  if (b) b.disabled = !state.back.length;
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
  document.getElementById('zin').onclick = () => setZoom(state.zoom * 1.2);
  document.getElementById('zout').onclick = () => setZoom(state.zoom / 1.2);
  document.getElementById('zfit').onclick = () => setZoom(1);
  const backBtn = document.getElementById('back');
  if (backBtn) backBtn.onclick = goBack;
  updateBackBtn(); updateZoomLabel();

  // Window resize (orientation change, sidebar…) → refit. Browser-level zoom
  // (⌘/Ctrl +/−) is intercepted below so it does NOT end up here.
  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => setZoom(state.zoom), 200); });

  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    // ⌘/Ctrl + / − / 0 → document zoom (instead of browser zoom, which the
    // fit-to-width layout would immediately cancel out).
    if (mod && !e.altKey && (e.key === '+' || e.key === '=' || e.key === 'Add')) { e.preventDefault(); setZoom(state.zoom * 1.2); return; }
    if (mod && !e.altKey && (e.key === '-' || e.key === '_' || e.key === 'Subtract')) { e.preventDefault(); setZoom(state.zoom / 1.2); return; }
    if (mod && !e.altKey && e.key === '0') { e.preventDefault(); setZoom(1); return; }
    if (/input|textarea|select/i.test(e.target.tagName)) return;
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); return; }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { goToPage(state.cur + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { goToPage(state.cur - 1); e.preventDefault(); }
  });

  // Ctrl+wheel / trackpad pinch (Chrome, Safari, Firefox report pinch as a
  // wheel event with ctrlKey) → smooth preview zoom, committed when the
  // gesture pauses.
  stage.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
    previewZoom(clampZoom(previewTarget() * factor), e.clientX, e.clientY);
  }, { passive: false });

  // Safari desktop pinch (gesture events) — prevent page zoom, use ours.
  let gestureStart = 1;
  stage.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureStart = previewTarget(); }, { passive: false });
  stage.addEventListener('gesturechange', (e) => { e.preventDefault(); previewZoom(clampZoom(gestureStart * e.scale), e.clientX, e.clientY); }, { passive: false });
  stage.addEventListener('gestureend', (e) => { e.preventDefault(); commitPreview(); }, { passive: false });

  // Touch pinch (phones / tablets).
  let pinch = null;
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      pinch = { d: touchDist(e), z: previewTarget(), cx: (e.touches[0].clientX + e.touches[1].clientX) / 2, cy: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
    }
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const d = touchDist(e);
    previewZoom(clampZoom(pinch.z * (d / pinch.d)), pinch.cx, pinch.cy);
  }, { passive: false });
  const endPinch = () => { if (pinch) { pinch = null; commitPreview(); } };
  stage.addEventListener('touchend', endPinch, { passive: true });
  stage.addEventListener('touchcancel', endPinch, { passive: true });
}
function touchDist(e) {
  const dx = e.touches[0].clientX - e.touches[1].clientX, dy = e.touches[0].clientY - e.touches[1].clientY;
  return Math.hypot(dx, dy) || 1;
}

/* ---------------- zoom ---------------- */
const ZOOM_MIN = 0.4, ZOOM_MAX = 5;
function clampZoom(z) { return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)); }
function updateZoomLabel() {
  const el = document.getElementById('zlabel');
  if (el) el.textContent = Math.round(state.zoom * 100) + ' %';
  const zin = document.getElementById('zin'), zout = document.getElementById('zout');
  if (zin) zin.disabled = state.zoom >= ZOOM_MAX - 1e-6;
  if (zout) zout.disabled = state.zoom <= ZOOM_MIN + 1e-6;
}

// Preview zoom: scale the already-rendered pages with a CSS transform during a
// continuous gesture (cheap), then commit with a real re-render when it ends.
const preview = { z: null, timer: 0, ax: 0, ay: 0 };
function previewTarget() { return preview.z == null ? state.zoom : preview.z; }
function previewZoom(z, clientX, clientY) {
  preview.z = z;
  preview.ax = clientX; preview.ay = clientY;
  const k = z / state.zoom;
  // keep the point under the cursor/fingers fixed
  const sr = stage.getBoundingClientRect();
  const px = (clientX == null ? sr.width / 2 : clientX - sr.left), py = (clientY == null ? sr.height / 2 : clientY - sr.top);
  if (!preview.origin) preview.origin = { sx: stage.scrollLeft, sy: stage.scrollTop, px, py };
  pagesEl.style.transformOrigin = '0 0';
  pagesEl.style.transform = 'scale(' + k + ')';
  // pages block is centered via margin:auto; transform ignores that, so nudge
  const docW = pagesEl.offsetWidth * k;
  const shift = Math.max(0, (stage.clientWidth - docW) / 2) - Math.max(0, (stage.clientWidth - pagesEl.offsetWidth) / 2);
  pagesEl.style.marginLeft = (shift > 0 ? shift : 0) + 'px';
  stage.scrollTop = (preview.origin.sy + preview.origin.py) * k - py;
  stage.scrollLeft = (preview.origin.sx + preview.origin.px) * k - px;
  const el = document.getElementById('zlabel'); if (el) el.textContent = Math.round(z * 100) + ' %';
  clearTimeout(preview.timer); preview.timer = setTimeout(commitPreview, 180);
}
function commitPreview() {
  clearTimeout(preview.timer); preview.timer = 0;
  if (preview.z == null) return;
  const z = preview.z, ax = preview.ax, ay = preview.ay;
  preview.z = null; preview.origin = null;
  pagesEl.style.transform = ''; pagesEl.style.marginLeft = '';
  setZoom(z, { anchorX: ax, anchorY: ay, fromPreview: true });
}

/* setZoom: re-lay out at a new zoom while keeping the document point that was
 * under the anchor (default: viewport centre) in place — no jump to page top. */
function setZoom(z, opts = {}) {
  const prevZoom = state.zoom;
  const newZoom = clampZoom(z);
  const sr = stage.getBoundingClientRect();
  const ax = opts.anchorX == null ? sr.width / 2 : opts.anchorX - sr.left;
  const ay = opts.anchorY == null ? sr.height * 0.35 : opts.anchorY - sr.top;
  // document-space fractions of the anchor (before)
  const prevW = pagesEl.offsetWidth || 1, prevH = pagesEl.scrollHeight || 1;
  let fx = (stage.scrollLeft + ax) / prevW, fy = (stage.scrollTop + ay) / prevH;
  if (opts.fromPreview) {
    // the preview already moved scrollTop/Left to the new geometry (scaled by k)
    const k = newZoom / prevZoom;
    fx = (stage.scrollLeft + ax) / (prevW * k); fy = (stage.scrollTop + ay) / (prevH * k);
  }
  state.zoom = newZoom;
  relayoutRerender();
  updateZoomLabel();
  if (opts.keepView === false) return;
  const newW = pagesEl.offsetWidth || 1, newH = pagesEl.scrollHeight || 1;
  stage.scrollTop = fy * newH - ay;
  stage.scrollLeft = fx * newW - ax;
  updateCur();
}

/* ---------------- boot comment + auth layers ---------------- */
const V = CFG.buildVersion && CFG.buildVersion !== 'dev' ? '?v=' + encodeURIComponent(CFG.buildVersion) : '';
import('./auth.js' + V).then((m) => m.initAuth(CFG)).catch((e) => console.warn('auth init', e));
import('./comments.js' + V).then((m) => m.initComments(Reader, CFG)).catch((e) => console.warn('comments init', e));
import('./search.js' + V).then((m) => { Reader.search = m.initSearch(Reader); }).catch((e) => console.warn('search init', e));
