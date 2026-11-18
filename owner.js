/* PhD public reader — OWNER view: all readers' comments (ES module).
 *
 * Visible only when the signed-in Google account is listed in
 * CFG.ownerEmails. Fetches the feedback for site=CFG.site from the
 * MyPublicAnalytics Worker (GET /feedback?site=…&id_token=…; the Worker
 * verifies the token and enforces the owner allowlist), then:
 *   - joins each comment (by D1 row id) to its processing status from
 *     comment-status.json (generated at publish from ReaderComments/RCM-*.md):
 *     ✅ applied, ⏳ needs decision, … — the list has tabs Avoimet / Käsitellyt
 *     / Kaikki, and handled comments are NOT painted on the pages unless
 *     "Näytä käsitellyt sivuilla" is ticked;
 *   - re-anchors comments left on an OLDER build: the quote is searched in the
 *     current text near the original page (search.js locate()). Found → the
 *     marker is drawn where the text is now; not found → no marker, the list
 *     says "teksti muuttunut". Page/area comments from an older build are
 *     listed only (their page may have moved);
 *   - keeps a counter of OPEN comments on the toolbar button.
 */
const STATUS = {
  'applied':           { label: '✅ Toteutettu',        cls: 'done' },
  'partially-applied': { label: '◐ Osin toteutettu',   cls: 'done' },
  'no-change-needed':  { label: '✓ Ei muutostarvetta', cls: 'done' },
  'declined':          { label: '✖ Ei muutettu',       cls: 'done' },
  'superseded':        { label: '↺ Korvattu',          cls: 'done' },
  'needs-decision':    { label: '⏳ Odottaa päätöstä',  cls: 'open' },
  'open':              { label: '● Avoin',             cls: 'open' },
};
const isDone = (s) => (STATUS[s] || STATUS.open).cls === 'done';

export function initOwner(R, CFG) {
  const owners = (CFG.ownerEmails || []).map((e) => String(e).toLowerCase());
  if (!owners.length) return;
  const endpoint = CFG.feedbackEndpoint || String(CFG.collectEndpoint || '').replace(/\/collect\/?$/, '/feedback');
  const btn = document.getElementById('ownerBtn');
  const panel = document.getElementById('owner');
  if (!btn || !panel) return;
  const ui = {
    list: panel.querySelector('#ownerList'), count: panel.querySelector('#ownerCount'), filter: panel.querySelector('#ownerFilter'),
    reload: panel.querySelector('#ownerReload'), close: panel.querySelector('#ownerClose'), status: panel.querySelector('#ownerStatus'),
  };
  const st = { open: false, items: [], byPage: new Map(), loading: false, filter: '', tab: 'open', showDone: false, statusMap: {} };
  const BUILD = CFG.pdfVersion || CFG.buildVersion || '';

  /* ---------- tabs + "show handled on pages" toggle (built here, no HTML change needed) ---------- */
  const tabs = document.createElement('span'); tabs.className = 'ownerTabs';
  tabs.innerHTML = '<button type="button" data-t="open">Avoimet <b></b></button><button type="button" data-t="done">Käsitellyt <b></b></button><button type="button" data-t="all">Kaikki <b></b></button>';
  const tog = document.createElement('label'); tog.className = 'ownerTog';
  tog.innerHTML = '<input type="checkbox"> Näytä käsitellyt sivuilla';
  ui.count.after(tabs); tabs.after(tog);
  tabs.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; st.tab = b.dataset.t; render(); });
  tog.querySelector('input').addEventListener('change', (e) => { st.showDone = e.target.checked; rebuildByPage(); repaintAll(); });

  function identity() { return window.PhdAuth && window.PhdAuth.getIdentity ? window.PhdAuth.getIdentity() : null; }
  function isOwner() { const id = identity(); return !!(id && id.email && owners.includes(String(id.email).toLowerCase())); }

  function refreshVisibility() {
    const on = isOwner();
    btn.style.display = on ? '' : 'none';
    if (!on) { if (st.open) hide(); st.items = []; st.byPage = new Map(); repaintAll(); }
    else if (!st.items.length && !st.loading) load();
  }
  window.addEventListener('phd-auth-change', refreshVisibility);
  R.ready.then(refreshVisibility);
  // PhdAuth may initialise after us
  setTimeout(refreshVisibility, 1500);

  async function loadStatus() {
    try {
      const r = await fetch('./comment-status.json?v=' + encodeURIComponent(BUILD || Date.now()), { cache: 'no-cache' });
      if (r.ok) st.statusMap = (await r.json()).items || {};
    } catch (_) { st.statusMap = {}; }
  }

  async function load() {
    const id = identity(); if (!id || !id.idToken) return;
    st.loading = true; ui.status.textContent = 'Ladataan…';
    try {
      const [r] = await Promise.all([
        fetch(endpoint + '?site=' + encodeURIComponent(CFG.site || 'phd') + '&id_token=' + encodeURIComponent(id.idToken), { mode: 'cors' }),
        loadStatus(),
      ]);
      if (r.status === 401) throw new Error('Kirjautuminen vanhentunut — kirjaudu uudelleen.');
      if (r.status === 403) throw new Error('Ei oikeutta lukea kommentteja tällä tilillä.');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      st.items = (data.feedback || []).map(normalize).filter(Boolean).sort((a, b) => b.ts - a.ts);
      ui.status.textContent = '';
      updateCounts(); rebuildByPage(); render(); repaintAll();
      reanchor();   // async: moves/clears markers of comments left on older builds
    } catch (e) {
      ui.status.textContent = 'Kommenttien haku epäonnistui: ' + (e.message || e);
    } finally { st.loading = false; }
  }
  function normalize(row) {
    let x = {}; try { x = typeof row.extra === 'string' ? JSON.parse(row.extra) : (row.extra || {}); } catch (_) {}
    const page = Number(x.page) || 0;
    const id = String(row.id || '');
    const rec = st.statusMap[id] || null;
    const v = x.v || '';
    const it = {
      id, ts: Number(row.ts) || 0, name: row.user_name || row.user_email || '(tuntematon)', email: row.user_email || '',
      verified: Number(row.user_verified) === 1, page, kind: x.kind || 'page', category: x.category || '',
      message: x.message || '', quote: x.quote || '', rects: Array.isArray(x.rects) ? x.rects : [], audio: x.audioUrl || '', v,
      status: rec ? rec.s : 'open', rec,
    };
    // Anchor on the CURRENT build: same build → as stored; older build → resolved by reanchor().
    if (!v || v === BUILD) it.anchor = { page, rects: it.rects, state: 'current' };
    else if (it.kind === 'selection' && it.quote) it.anchor = { page, rects: [], state: 'pending' };
    else it.anchor = { page, rects: [], state: 'old' };
    return it;
  }

  async function reanchor() {
    const todo = st.items.filter((it) => it.anchor.state === 'pending');
    if (!todo.length) return;
    let search = R.search;
    for (let i = 0; !search && i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); search = R.search; }
    if (!search || !search.locate) { todo.forEach((it) => { it.anchor.state = 'lost'; }); render(); return; }
    for (const it of todo) {
      try {
        const hit = await search.locate(it.quote, it.page);
        it.anchor = hit ? { page: hit.page, rects: hit.rects, state: hit.page === it.page ? 'moved' : 'moved-page' } : { page: it.page, rects: [], state: 'lost' };
      } catch (_) { it.anchor = { page: it.page, rects: [], state: 'lost' }; }
    }
    rebuildByPage(); render(); repaintAll();
  }

  function visibleOnPages(it) { return st.showDone || !isDone(it.status); }
  function rebuildByPage() {
    st.byPage = new Map();
    for (const it of st.items) {
      if (!visibleOnPages(it)) continue;
      const a = it.anchor;
      if (a.state === 'old' || a.state === 'lost' || a.state === 'pending') continue;
      if (!st.byPage.has(a.page)) st.byPage.set(a.page, []);
      st.byPage.get(a.page).push(it);
    }
  }
  function updateCounts() {
    const open = st.items.filter((it) => !isDone(it.status)).length;
    btn.querySelector('#ownerN').textContent = String(open);
    btn.title = 'Kaikkien lukijoiden kommentit (vain omistaja) — ' + open + ' avointa / ' + st.items.length;
  }

  /* ---------- list ---------- */
  const CAT = { general: 'Yleinen', typo: 'Kieli', content: 'Sisältö', question: 'Kysymys', suggestion: 'Ehdotus' };
  const KIND = { selection: 'valinta', area: 'alue', page: 'koko sivu' };
  function fmt(ts) { const d = new Date(ts); return d.toLocaleDateString('fi-FI') + ' ' + d.toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' }); }
  function anchorNote(it) {
    const a = it.anchor;
    if (a.state === 'moved-page') return '<span class="anc">→ nyt s. ' + a.page + '</span>';
    if (a.state === 'lost') return isDone(it.status)
      ? '<span class="anc" title="Lainattu teksti on muutettu tämän kommentin perusteella">kohta muutettu</span>'
      : '<span class="anc warn" title="Lainattua tekstiä ei löydy nykyversiosta — kohta on todennäköisesti muutettu">⚠ teksti muuttunut</span>';
    if (a.state === 'old') return '<span class="anc" title="Jätetty aiempaan versioon (' + esc(it.v) + '); sivunumero viittaa siihen">vanha versio</span>';
    return '';
  }
  function render() {
    const f = st.filter.trim().toLowerCase();
    const nOpen = st.items.filter((it) => !isDone(it.status)).length;
    const nDone = st.items.length - nOpen;
    const bs = tabs.querySelectorAll('button');
    bs[0].querySelector('b').textContent = nOpen; bs[1].querySelector('b').textContent = nDone; bs[2].querySelector('b').textContent = st.items.length;
    bs.forEach((b) => b.classList.toggle('on', b.dataset.t === st.tab));
    let items = st.items.filter((it) => st.tab === 'all' || (st.tab === 'done') === isDone(it.status));
    if (f) items = items.filter((it) => (it.name + ' ' + it.email + ' ' + it.message + ' ' + it.quote + ' s. ' + it.page + ' ' + (it.rec ? it.rec.t : '')).toLowerCase().includes(f));
    ui.count.textContent = items.length + ' kommenttia';
    ui.list.innerHTML = '';
    if (!items.length) { ui.list.innerHTML = '<div class="ownerEmpty">' + (st.items.length ? (f ? 'Ei osumia suodattimella.' : (st.tab === 'open' ? 'Ei avoimia kommentteja 🎉' : 'Ei kommentteja tässä näkymässä.')) : 'Ei vielä kommentteja.') + '</div>'; return; }
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const S = STATUS[it.status] || STATUS.open;
      const li = document.createElement('div'); li.className = 'ownerItem ' + S.cls;
      li.innerHTML =
        '<div class="oh"><span class="sts ' + S.cls + '">' + S.label + '</span>' +
        '<span class="who">' + esc(it.name) + (it.verified ? ' <span class="ok" title="Google-varmennettu">✓</span>' : ' <span class="unv" title="varmentamaton">?</span>') + '</span>' +
        '<span class="pg">s. ' + it.page + '</span>' + anchorNote(it) +
        '<span class="kind">' + (KIND[it.kind] || it.kind) + '</span>' +
        (it.category ? '<span class="cat">' + esc(CAT[it.category] || it.category) + '</span>' : '') +
        '<span class="ts">' + esc(fmt(it.ts)) + '</span></div>' +
        (it.quote ? '<div class="oq">“' + esc(it.quote.length > 220 ? it.quote.slice(0, 220) + '…' : it.quote) + '”</div>' : '') +
        '<div class="om">' + esc(it.message || (it.audio ? '(äänikommentti)' : '')) + '</div>' +
        (it.rec ? '<div class="orec">RCM-' + esc(it.id) + (it.rec.t ? ' — ' + esc(it.rec.t) : '') + (it.rec.c ? ' · <code>' + esc(it.rec.c) + '</code>' : '') + '</div>' : '') +
        (it.audio ? '<audio controls preload="none" src="' + esc(it.audio) + '"></audio>' : '');
      li.addEventListener('click', (ev) => { if (ev.target.tagName === 'AUDIO') return; jump(it); });
      frag.appendChild(li);
    }
    ui.list.appendChild(frag);
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function jump(it) {
    const a = it.anchor;
    const page = a.page || it.page; if (!page) return;
    const fy = a.rects && a.rects.length ? Math.min(...a.rects.map((r) => r.y)) : 0;
    // A handled comment is not painted by default — show it while jumping to it.
    if (!visibleOnPages(it) && a.rects && a.rects.length) { st.showDone = true; tog.querySelector('input').checked = true; rebuildByPage(); repaintAll(); }
    R.scrollToFraction(page, fy, 'smooth');
    R.emit('owner_jump', { page });
    setTimeout(() => {
      const hl = R.hlLayer(page); if (!hl) return;
      hl.querySelectorAll('i.other[data-ts="' + it.ts + '"]').forEach((el) => { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1800); });
    }, 700);
  }

  /* ---------- markers on pages ---------- */
  function paint(n, hl) {
    if (!hl) return;
    hl.querySelectorAll('i.other, .otherBadge').forEach((x) => x.remove());
    const items = st.byPage.get(n); if (!items || !isOwner()) return;
    let badges = 0;
    for (const it of items) {
      const S = STATUS[it.status] || STATUS.open;
      const title = S.label + ' · ' + it.name + (it.verified ? ' ✓' : '') + ' · ' + fmt(it.ts) + '\n' + (it.message || '(ääni)');
      const rects = it.anchor.rects || [];
      if ((it.kind === 'selection' || it.kind === 'area') && rects.length) {
        for (const r of rects) {
          const i = document.createElement('i'); i.className = 'other' + (S.cls === 'done' ? ' done' : '') + (it.kind === 'area' ? ' area' : ''); i.dataset.ts = String(it.ts);
          i.style.left = (r.x * 100) + '%'; i.style.top = (r.y * 100) + '%'; i.style.width = (r.w * 100) + '%'; i.style.height = (r.h * 100) + '%';
          i.title = title;
          i.addEventListener('click', () => { show(); st.tab = 'all'; ui.filter.value = it.message.slice(0, 40); st.filter = ui.filter.value; render(); });
          hl.appendChild(i);
        }
      } else if (it.kind === 'page') {
        const b = document.createElement('div'); b.className = 'otherBadge' + (S.cls === 'done' ? ' done' : ''); b.style.top = (8 + badges * 26) + 'px'; badges++;
        b.textContent = (S.cls === 'done' ? '✅ ' : '💬 ') + it.name.split(' ')[0]; b.title = title;
        b.addEventListener('click', () => { show(); st.tab = 'all'; ui.filter.value = it.name; st.filter = it.name; render(); });
        hl.appendChild(b);
      }
    }
  }
  function repaintAll() { for (let n = 1; n <= R.numPages; n++) if (R.isRendered(n)) paint(n, R.hlLayer(n)); }
  R.onPainted((n, el, hl) => paint(n, hl));

  /* ---------- panel ---------- */
  function show() { st.open = true; panel.classList.add('show'); btn.classList.add('on'); if (!st.items.length) load(); render(); }
  function hide() { st.open = false; panel.classList.remove('show'); btn.classList.remove('on'); }
  btn.onclick = () => (st.open ? hide() : show());
  ui.close.onclick = hide;
  ui.reload.onclick = load;
  ui.filter.addEventListener('input', () => { st.filter = ui.filter.value; render(); });
  window.addEventListener('keydown', (e) => { if (st.open && e.key === 'Escape' && !/input|textarea/i.test(e.target.tagName)) hide(); });

  return { reload: load, get items() { return st.items; }, isOwner };
}
