/* PhD public reader — full-text search (ES module).
 *
 * Indexes every page's text (pdf.js getTextContent) once, in the background,
 * then searches the whole dissertation — not just the pages currently
 * rendered (which is all the browser's own ⌘F could ever see). Matches are
 * highlighted on the pages as they render, a result list gives page + context,
 * and ▲/▼ (Enter / Shift+Enter) walk the matches.
 *
 * Coordinates are page fractions (like comments.js), so highlights survive
 * zoom and re-render.
 */
export function initSearch(R) {
  const stage = document.getElementById('stage');
  const ui = buildUI();
  const idx = { pages: null, building: null, done: 0 };   // pages[n-1] = { text, norm, items:[{start,end,fx,fy,fw,fh}] }
  const st = { q: '', matches: [], cur: -1, byPage: new Map(), timer: 0 };

  /* ---------- text normalisation (length-preserving, 1 char -> 1 char) ---------- */
  function normChar(c) {
    const d = c.normalize('NFD');
    let b = d[0] || c;
    const l = b.toLowerCase();
    if (l.length === 1) b = l;
    if (b === '­') b = '-';            // soft hyphen
    if (/[\s ]/.test(b)) b = ' ';
    return b;
  }
  function norm(s) { let o = ''; for (const c of s) o += normChar(c); return o; }

  /* ---------- index ---------- */
  async function buildIndex() {
    if (idx.pages) return idx.pages;
    if (idx.building) return idx.building;
    idx.building = (async () => {
      const pdf = R.pdf; const n = R.numPages;
      const pages = new Array(n);
      for (let p = 1; p <= n; p++) {
        try {
          const page = await pdf.getPage(p);
          const vp = page.getViewport({ scale: 1 });
          const tc = await page.getTextContent();
          pages[p - 1] = indexPage(tc, vp);
        } catch (_) { pages[p - 1] = { text: '', norm: '', items: [] }; }
        idx.done = p;
        if (ui.open && !idx.pages) ui.count.textContent = 'Indeksoidaan… ' + p + '/' + n;
      }
      idx.pages = pages;
      return pages;
    })();
    return idx.building;
  }
  function indexPage(tc, vp) {
    let text = '';
    const items = [];
    let prev = null;
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      const [a, b, c, d, e, f] = it.transform;
      const fontH = Math.hypot(b, d) || it.height || 0;
      const h = it.height || fontH;
      // geometry in page fractions (viewport scale 1, y flipped by convertToViewportPoint)
      const [x1, yTop] = vp.convertToViewportPoint(e, f + h * 0.8);
      const [x2, yBot] = vp.convertToViewportPoint(e + it.width, f - h * 0.2);
      const g = { fx: x1 / vp.width, fy: yTop / vp.height, fw: Math.max(0, x2 - x1) / vp.width, fh: Math.max(0, yBot - yTop) / vp.height, x: e, y: f, w: it.width, h };
      if (it.str.length) {
        if (prev) {
          const sameLine = Math.abs(prev.y - g.y) < Math.max(prev.h, g.h) * 0.5;
          const lastCh = text[text.length - 1] || ' ';
          if (!sameLine) { if (lastCh !== '\n') text += '\n'; }
          else {
            const gap = g.x - (prev.x + prev.w);
            if (gap > Math.max(prev.h, g.h) * 0.12 && lastCh !== ' ' && it.str[0] !== ' ') text += ' ';
          }
        }
        items.push({ start: text.length, end: text.length + it.str.length, ...g });
        text += it.str;
        prev = g;
      }
      if (it.hasEOL && text[text.length - 1] !== '\n') { text += '\n'; }
    }
    return { text, norm: norm(text), items };
  }
  // Start indexing quietly after the document has settled.
  R.ready.then(() => setTimeout(() => buildIndex().catch(() => {}), 1500));

  /* ---------- search ---------- */
  async function run(q) {
    q = q.trim();
    st.q = q; st.matches = []; st.cur = -1; st.byPage = new Map();
    ui.list.innerHTML = '';
    if (!q) { ui.count.textContent = ''; repaintAll(); return; }
    const nq = norm(q).replace(/\s+/g, ' ');
    if (!idx.pages) ui.count.textContent = 'Indeksoidaan… ' + idx.done + '/' + R.numPages;
    const pages = await buildIndex();
    if (st.q !== q) return; // superseded
    const re = new RegExp(nq.split(' ').map(escapeRe).join('[\\s-]*'), 'g');   // whitespace / line-break / hyphenation tolerant
    let total = 0;
    for (let p = 1; p <= pages.length; p++) {
      const pg = pages[p - 1]; if (!pg.norm) continue;
      re.lastIndex = 0; let m;
      while ((m = re.exec(pg.norm)) && total < 5000) {
        if (!m[0].length) { re.lastIndex++; continue; }
        const match = { page: p, start: m.index, end: m.index + m[0].length, rects: rectsFor(pg, m.index, m.index + m[0].length), i: total };
        st.matches.push(match);
        if (!st.byPage.has(p)) st.byPage.set(p, []);
        st.byPage.get(p).push(match);
        total++;
      }
    }
    renderList(pages);
    repaintAll();
    R.emit('search', { q: q.slice(0, 120), hits: total, page: R.currentPage() });
    if (total) go(0, true); else ui.count.textContent = 'Ei osumia';
  }
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function rectsFor(pg, s, e) {
    const out = [];
    for (const it of pg.items) {
      if (it.end <= s || it.start >= e) continue;
      const len = it.end - it.start || 1;
      const a = Math.max(s, it.start) - it.start, b = Math.min(e, it.end) - it.start;
      out.push({ fx: it.fx + it.fw * (a / len), fy: it.fy, fw: it.fw * ((b - a) / len), fh: it.fh });
    }
    return out;
  }

  function renderList(pages) {
    const frag = document.createDocumentFragment();
    const max = 400; let shown = 0;
    for (const m of st.matches) {
      if (shown++ >= max) break;
      const pg = pages[m.page - 1];
      const a = Math.max(0, m.start - 40), b = Math.min(pg.text.length, m.end + 60);
      const pre = pg.text.slice(a, m.start).replace(/\s+/g, ' ');
      const hit = pg.text.slice(m.start, m.end).replace(/\s+/g, ' ');
      const post = pg.text.slice(m.end, b).replace(/\s+/g, ' ');
      const li = document.createElement('div'); li.className = 'srchItem'; li.dataset.i = String(m.i);
      const pn = document.createElement('span'); pn.className = 'pg'; pn.textContent = 's. ' + m.page;
      const tx = document.createElement('span'); tx.className = 'tx';
      tx.append((a > 0 ? '…' : '') + pre);
      const mk = document.createElement('mark'); mk.textContent = hit; tx.append(mk);
      tx.append(post + (b < pg.text.length ? '…' : ''));
      li.append(pn, tx);
      li.addEventListener('click', () => go(m.i));
      frag.appendChild(li);
    }
    ui.list.innerHTML = '';
    ui.list.appendChild(frag);
    if (st.matches.length > max) {
      const more = document.createElement('div'); more.className = 'srchMore';
      more.textContent = '… ja ' + (st.matches.length - max) + ' osumaa lisää (tarkenna hakua)';
      ui.list.appendChild(more);
    }
  }

  function go(i, first) {
    if (!st.matches.length) return;
    st.cur = ((i % st.matches.length) + st.matches.length) % st.matches.length;
    const m = st.matches[st.cur];
    ui.count.textContent = (st.cur + 1) + ' / ' + st.matches.length;
    if (!first) R.emit('search_nav', { q: st.q.slice(0, 120), i: st.cur + 1, of: st.matches.length, page: m.page });
    // scroll: put the match ~1/3 down the viewport
    const fy = m.rects.length ? m.rects[0].fy : 0;
    R.scrollToFraction(m.page, fy, first ? 'auto' : 'smooth');
    repaintAll();
    ui.list.querySelectorAll('.srchItem.cur').forEach((x) => x.classList.remove('cur'));
    const li = ui.list.querySelector('.srchItem[data-i="' + m.i + '"]');
    if (li) { li.classList.add('cur'); li.scrollIntoView({ block: 'nearest' }); }
  }

  /* ---------- highlights ---------- */
  function paint(n, hl) {
    if (!hl) return;
    hl.querySelectorAll('i.srch').forEach((x) => x.remove());
    const ms = st.byPage.get(n); if (!ms) return;
    for (const m of ms) for (const r of m.rects) {
      const i = document.createElement('i');
      i.className = 'srch' + (m.i === st.cur ? ' cur' : '');
      i.style.left = (r.fx * 100) + '%'; i.style.top = (r.fy * 100) + '%';
      i.style.width = (r.fw * 100) + '%'; i.style.height = (r.fh * 100) + '%';
      hl.appendChild(i);
    }
  }
  function repaintAll() { for (let n = 1; n <= R.numPages; n++) if (R.isRendered(n)) paint(n, R.hlLayer(n)); }
  R.onPainted((n, el, hl) => paint(n, hl));

  /* ---------- UI ---------- */
  function buildUI() {
    const box = document.getElementById('search');
    const u = {
      box, input: box.querySelector('#srchInput'), count: box.querySelector('#srchCount'),
      prev: box.querySelector('#srchPrev'), next: box.querySelector('#srchNext'), close: box.querySelector('#srchClose'),
      list: box.querySelector('#srchList'), open: false,
    };
    const btn = document.getElementById('srchBtn');
    btn.onclick = () => (u.open ? hide() : show());
    u.close.onclick = hide;
    u.prev.onclick = () => go(st.cur - 1);
    u.next.onclick = () => go(st.cur + 1);
    u.input.addEventListener('input', () => { clearTimeout(st.timer); st.timer = setTimeout(() => run(u.input.value), 250); });
    u.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (u.input.value.trim() !== st.q) run(u.input.value); else go(st.cur + (e.shiftKey ? -1 : 1)); }
      else if (e.key === 'Escape') { e.preventDefault(); hide(); }
    });
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); show(); }
      else if (u.open && e.key === 'Escape' && !/input|textarea/i.test(e.target.tagName)) hide();
      else if (u.open && !/input|textarea|select/i.test(e.target.tagName) && st.matches.length) {
        if (e.key === 'F3' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); go(st.cur + 1); }
        else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); go(st.cur - 1); }
      }
    });
    function show() { if (!u.open) R.emit('search_open', { page: R.currentPage() }); u.open = true; box.classList.add('show'); btn.classList.add('on'); u.input.focus(); u.input.select(); if (!idx.pages) buildIndex(); }
    function hide() { if (u.open) R.emit('search_close', { q: st.q.slice(0, 120), hits: st.matches.length, page: R.currentPage() }); u.open = false; box.classList.remove('show'); btn.classList.remove('on'); st.q = ''; st.matches = []; st.byPage = new Map(); st.cur = -1; ui.list.innerHTML = ''; ui.count.textContent = ''; repaintAll(); }
    u.show = show; u.hide = hide;
    return u;
  }

  // Deep link: #q=term (with optional &p=)
  const m = /(?:^|[#&])q=([^&]+)/.exec(location.hash);
  if (m) { R.ready.then(() => { ui.show(); ui.input.value = decodeURIComponent(m[1]); run(ui.input.value); }); }

  return { search: (q) => { ui.show(); ui.input.value = q; return run(q); }, next: () => go(st.cur + 1), prev: () => go(st.cur - 1), get matches() { return st.matches; } };
}
