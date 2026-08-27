/* PhD public reader — OWNER view: all readers' comments (ES module).
 *
 * Visible only when the signed-in Google account is listed in
 * CFG.ownerEmails. Fetches the feedback for site=CFG.site from the
 * MyPublicAnalytics Worker (GET /feedback?site=…&id_token=…; the Worker
 * verifies the token and enforces the owner allowlist), then:
 *   - lists every comment (who ✓, when, page, kind, category, quote, message),
 *     newest first, with a text filter; click → jump to the page,
 *   - paints every text-anchored comment on its page (amber "other" markers
 *     with a hover title) and a 💬 badge for whole-page comments,
 *   - keeps a "N" counter on the toolbar button.
 */
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
  const st = { open: false, items: [], byPage: new Map(), loading: false, filter: '' };

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

  async function load() {
    const id = identity(); if (!id || !id.idToken) return;
    st.loading = true; ui.status.textContent = 'Ladataan…';
    try {
      const r = await fetch(endpoint + '?site=' + encodeURIComponent(CFG.site || 'phd') + '&id_token=' + encodeURIComponent(id.idToken), { mode: 'cors' });
      if (r.status === 401) throw new Error('Kirjautuminen vanhentunut — kirjaudu uudelleen.');
      if (r.status === 403) throw new Error('Ei oikeutta lukea kommentteja tällä tilillä.');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      st.items = (data.feedback || []).map(normalize).filter(Boolean).sort((a, b) => b.ts - a.ts);
      st.byPage = new Map();
      for (const it of st.items) { if (!st.byPage.has(it.page)) st.byPage.set(it.page, []); st.byPage.get(it.page).push(it); }
      ui.status.textContent = '';
      btn.querySelector('#ownerN').textContent = String(st.items.length);
      render(); repaintAll();
    } catch (e) {
      ui.status.textContent = 'Kommenttien haku epäonnistui: ' + (e.message || e);
    } finally { st.loading = false; }
  }
  function normalize(row) {
    let x = {}; try { x = typeof row.extra === 'string' ? JSON.parse(row.extra) : (row.extra || {}); } catch (_) {}
    const page = Number(x.page) || 0;
    return {
      ts: Number(row.ts) || 0, name: row.user_name || row.user_email || '(tuntematon)', email: row.user_email || '',
      verified: Number(row.user_verified) === 1, page, kind: x.kind || 'page', category: x.category || '',
      message: x.message || '', quote: x.quote || '', rects: Array.isArray(x.rects) ? x.rects : [], audio: x.audioUrl || '', v: x.v || '',
    };
  }

  /* ---------- list ---------- */
  const CAT = { general: 'Yleinen', typo: 'Kieli', content: 'Sisältö', question: 'Kysymys', suggestion: 'Ehdotus' };
  function fmt(ts) { const d = new Date(ts); return d.toLocaleDateString('fi-FI') + ' ' + d.toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' }); }
  function render() {
    const f = st.filter.trim().toLowerCase();
    const items = f ? st.items.filter((it) => (it.name + ' ' + it.email + ' ' + it.message + ' ' + it.quote + ' s. ' + it.page).toLowerCase().includes(f)) : st.items;
    ui.count.textContent = items.length + (f ? ' / ' + st.items.length : '') + ' kommenttia';
    ui.list.innerHTML = '';
    if (!items.length) { ui.list.innerHTML = '<div class="ownerEmpty">' + (st.items.length ? 'Ei osumia suodattimella.' : 'Ei vielä kommentteja.') + '</div>'; return; }
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const li = document.createElement('div'); li.className = 'ownerItem';
      li.innerHTML =
        '<div class="oh"><span class="who">' + esc(it.name) + (it.verified ? ' <span class="ok" title="Google-varmennettu">✓</span>' : ' <span class="unv" title="varmentamaton">?</span>') + '</span>' +
        '<span class="pg">s. ' + it.page + '</span>' +
        '<span class="kind">' + (it.kind === 'selection' ? 'valinta' : 'koko sivu') + '</span>' +
        (it.category ? '<span class="cat">' + esc(CAT[it.category] || it.category) + '</span>' : '') +
        '<span class="ts">' + esc(fmt(it.ts)) + '</span></div>' +
        (it.quote ? '<div class="oq">“' + esc(it.quote.length > 220 ? it.quote.slice(0, 220) + '…' : it.quote) + '”</div>' : '') +
        '<div class="om">' + esc(it.message || (it.audio ? '(äänikommentti)' : '')) + '</div>' +
        (it.audio ? '<audio controls preload="none" src="' + esc(it.audio) + '"></audio>' : '');
      li.addEventListener('click', (ev) => { if (ev.target.tagName === 'AUDIO') return; jump(it); });
      frag.appendChild(li);
    }
    ui.list.appendChild(frag);
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function jump(it) {
    if (!it.page) return;
    const fy = it.rects.length ? Math.min(...it.rects.map((r) => r.y)) : 0;
    R.scrollToFraction(it.page, fy, 'smooth');
    R.emit('owner_jump', { page: it.page });
    // flash the markers of this comment
    setTimeout(() => {
      const hl = R.hlLayer(it.page); if (!hl) return;
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
      const title = it.name + (it.verified ? ' ✓' : '') + ' · ' + fmt(it.ts) + '\n' + (it.message || '(ääni)');
      if (it.kind === 'selection' && it.rects.length) {
        for (const r of it.rects) {
          const i = document.createElement('i'); i.className = 'other'; i.dataset.ts = String(it.ts);
          i.style.left = (r.x * 100) + '%'; i.style.top = (r.y * 100) + '%'; i.style.width = (r.w * 100) + '%'; i.style.height = (r.h * 100) + '%';
          i.title = title;
          i.addEventListener('click', () => { show(); ui.filter.value = it.message.slice(0, 40); st.filter = ui.filter.value; render(); });
          hl.appendChild(i);
        }
      } else {
        const b = document.createElement('div'); b.className = 'otherBadge'; b.style.top = (8 + badges * 26) + 'px'; badges++;
        b.textContent = '💬 ' + it.name.split(' ')[0]; b.title = title;
        b.addEventListener('click', () => { show(); ui.filter.value = it.name; st.filter = it.name; render(); });
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
