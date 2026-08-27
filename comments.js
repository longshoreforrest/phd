/* PhD public reader — commenting layer.
 *
 * Flow: select text in a page's TextLayer -> floating 💬 button -> composer.
 * A comment is anchored as { page, quote, rects[] } where rects are page-
 * fraction coordinates (0..1), resolution-independent so they both paint an
 * overlay now and place a real PDF annotation later (offline export tool).
 * Page-level comments (no selection) are also supported ("Kommentoi tätä sivua").
 *
 * Submit POSTs event:'feedback' to the MyPublicAnalytics Worker with site='phd'
 * and the signed-in Google identity. Nothing renders publicly; the commenter's
 * OWN comments are echoed locally (localStorage) so they can see what they left.
 */
const LS_MINE = 'phd:mycomments';
const MAX_EXTRA = 3800;   // Worker truncates `extra` JSON at 4096 chars
const MAX_MSG = 1500;
const MAX_RECTS = 80;

let R, CFG;
let sel = null;           // pending selection anchor
let recog = null, recognizing = false;
let mediaRec = null, chunks = [], audioBlob = null;

export function initComments(reader, cfg) {
  R = reader; CFG = cfg || {};
  wireSelection();
  wireComposer();
  wirePageButton();
  R.onPainted((n, el, hl) => paintMine(n, hl));
}

/* ---------------- selection -> FAB ---------------- */
function wireSelection() {
  const fab = document.getElementById('fab');
  const update = () => {
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) { hideFab(); return; }
    const text = s.toString().trim();
    const page = R.pageOfNode(s.anchorNode);
    if (!text || !page) { hideFab(); return; }
    const rects = s.getRangeAt(0).getClientRects();
    const last = rects[rects.length - 1];
    if (!last) { hideFab(); return; }
    fab.style.left = (last.right) + 'px';
    fab.style.top = (last.top) + 'px';
    fab.classList.add('show');
  };
  document.addEventListener('mouseup', () => setTimeout(update, 0));
  document.addEventListener('touchend', () => setTimeout(update, 0), { passive: true });
  document.addEventListener('selectionchange', () => {
    const s = window.getSelection();
    if (!s || s.isCollapsed) hideFab();
  });
  fab.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection
  fab.addEventListener('click', () => { captureSelection(); openComposer('selection'); });
}
function hideFab() { document.getElementById('fab').classList.remove('show'); }

function captureSelection() {
  const s = window.getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) { sel = null; return; }
  const quote = s.toString().replace(/\s+/g, ' ').trim();
  const page = R.pageOfNode(s.anchorNode);
  const pageEl = R.pageEl(page);
  const rects = [];
  if (pageEl) {
    const pr = pageEl.getBoundingClientRect();
    for (const r of s.getRangeAt(0).getClientRects()) {
      // keep only rects that fall within this page box
      if (r.bottom < pr.top || r.top > pr.bottom) continue;
      rects.push({
        x: +clamp((r.left - pr.left) / pr.width).toFixed(4),
        y: +clamp((r.top - pr.top) / pr.height).toFixed(4),
        w: +clamp(r.width / pr.width).toFixed(4),
        h: +clamp(r.height / pr.height).toFixed(4),
      });
    }
  }
  sel = { kind: 'selection', page, quote, rects: rects.slice(0, MAX_RECTS) };
  hideFab();
}
const clamp = (v) => Math.max(0, Math.min(1, v));

/* ---------------- page-level comment ---------------- */
function wirePageButton() {
  const b = document.getElementById('cmtPage');
  if (b) b.onclick = () => { sel = { kind: 'page', page: R.currentPage(), quote: '', rects: [] }; openComposer('page'); };
}

/* ---------------- composer ---------------- */
function wireComposer() {
  document.getElementById('cmtCancel').onclick = closeComposer;
  document.getElementById('cmtSend').onclick = submit;
  document.getElementById('cmtMic').onclick = toggleDictation;
  const rec = document.getElementById('cmtRec');
  if (rec) rec.onclick = toggleRecording;
  window.addEventListener('phd-auth-change', refreshAuthState);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeComposer(); });
}

function openComposer(kind) {
  const c = document.getElementById('composer');
  const q = document.getElementById('cmtQuote');
  const ctx = document.getElementById('cmtCtx');
  q.style.display = (kind === 'selection' && sel && sel.quote) ? '' : 'none';
  if (kind === 'selection' && sel) q.textContent = '“' + (sel.quote.length > 300 ? sel.quote.slice(0, 300) + '…' : sel.quote) + '”';
  ctx.textContent = kind === 'selection'
    ? ('Kommentti — sivu ' + (sel ? sel.page : '?'))
    : ('Kommentti koko sivusta ' + (sel ? sel.page : R.currentPage()));
  document.getElementById('cmtText').value = '';
  audioBlob = null; updateRecUI(false);
  c.classList.add('show');
  positionComposer();
  refreshAuthState();
  composerSent = false;
  R.emit('comment_open', { kind, page: sel ? sel.page : R.currentPage(), quote_len: (kind === 'selection' && sel) ? sel.quote.length : 0 });
  setTimeout(() => document.getElementById('cmtText').focus(), 30);
}
function positionComposer() {
  const c = document.getElementById('composer');
  // center-ish, biased to the right so it doesn't cover the reading column
  c.style.top = Math.max(64, Math.round(window.innerHeight * 0.16)) + 'px';
  c.style.left = Math.round(Math.min(window.innerWidth - c.offsetWidth - 16, window.innerWidth * 0.52)) + 'px';
}
let composerSent = false;
function closeComposer() {
  stopDictation(); stopRecording(true);
  const c = document.getElementById('composer');
  if (c.classList.contains('show') && !composerSent) R.emit('comment_cancel', { page: sel ? sel.page : R.currentPage(), kind: sel ? sel.kind : 'page', typed: document.getElementById('cmtText').value.trim().length });
  c.classList.remove('show');
  sel = null;
}

function refreshAuthState() {
  const note = document.getElementById('cmtSigninNote');
  const send = document.getElementById('cmtSend');
  const id = window.PhdAuth && window.PhdAuth.getIdentity();
  const needSignin = CFG.requireSignIn && !id;
  note.style.display = needSignin ? '' : 'none';
  send.disabled = needSignin;
  send.textContent = id ? ('Lähetä (' + (id.name || id.email) + ')') : 'Lähetä';
}

/* ---------------- dictation (speech-to-text) ---------------- */
function toggleDictation() { recognizing ? stopDictation() : startDictation(); }
function startDictation() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = document.getElementById('cmtMic');
  const ind = document.getElementById('dictindicator');
  if (!SR) { toast('Selain ei tue sanelua. Kokeile Chromea tai Safaria.', true); return; }
  R.emit('voice', { mode: 'dictation', page: sel ? sel.page : R.currentPage() });
  recog = new SR();
  recog.lang = CFG.dictationLang || 'fi-FI';
  recog.interimResults = true; recog.continuous = true;
  const ta = document.getElementById('cmtText');
  const baseLen = ta.value.length ? ta.value.length + 1 : 0;
  let base = ta.value ? ta.value + ' ' : '';
  recog.onresult = (e) => {
    let interim = '', finalTxt = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalTxt += t; else interim += t;
    }
    if (finalTxt) base += finalTxt;
    ta.value = base + interim;
  };
  recog.onerror = (e) => { if (e.error !== 'no-speech') toast('Sanelu: ' + e.error, true); };
  recog.onend = () => { recognizing = false; mic.classList.remove('active'); ind.classList.remove('show'); };
  try { recog.start(); recognizing = true; mic.classList.add('active'); ind.classList.add('show'); }
  catch (_) {}
  void baseLen;
}
function stopDictation() { if (recog && recognizing) { try { recog.stop(); } catch (_) {} } recognizing = false; }

/* ---------------- audio recording (Phase 2: needs CFG.audioEndpoint) ---------------- */
function toggleRecording() { mediaRec && mediaRec.state === 'recording' ? stopRecording(false) : startRecording(); }
async function startRecording() {
  if (!CFG.audioEndpoint) { toast('Äänitallennus otetaan käyttöön pian.', true); return; }
  R.emit('voice', { mode: 'recording', page: sel ? sel.page : R.currentPage() });
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = []; mediaRec = new MediaRecorder(stream);
    mediaRec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mediaRec.onstop = () => { audioBlob = new Blob(chunks, { type: mediaRec.mimeType || 'audio/webm' }); stream.getTracks().forEach((t) => t.stop()); updateRecUI(false); };
    mediaRec.start(); updateRecUI(true);
  } catch (e) { toast('Mikrofonia ei saatu käyttöön.', true); }
}
function stopRecording(discard) {
  if (mediaRec && mediaRec.state === 'recording') { try { mediaRec.stop(); } catch (_) {} }
  if (discard) { audioBlob = null; chunks = []; }
}
function updateRecUI(active) {
  const rec = document.getElementById('cmtRec');
  if (!rec) return;
  rec.classList.toggle('active', !!active);
  rec.textContent = active ? '■ Lopeta äänitys' : (audioBlob ? '● Äänitetty ✓' : '● Äänitä');
}
async function uploadAudio() {
  if (!audioBlob || !CFG.audioEndpoint) return '';
  const fd = new FormData();
  fd.append('audio', audioBlob, 'comment.webm');
  fd.append('site', CFG.site);
  const id = window.PhdAuth && window.PhdAuth.getIdentity();
  if (id) fd.append('idToken', id.idToken);
  const r = await fetch(CFG.audioEndpoint, { method: 'POST', body: fd });
  if (!r.ok) throw new Error('audio upload failed');
  const j = await r.json().catch(() => ({}));
  return j.url || '';
}

/* ---------------- submit ---------------- */
async function submit() {
  const id = window.PhdAuth && window.PhdAuth.getIdentity();
  if (CFG.requireSignIn && !id) { refreshAuthState(); return; }
  const message = document.getElementById('cmtText').value.trim().slice(0, MAX_MSG);
  const category = document.getElementById('cmtCat').value;
  if (!message && !audioBlob) { toast('Kirjoita tai sanele kommentti.', true); return; }

  const send = document.getElementById('cmtSend');
  send.disabled = true; const label = send.textContent; send.textContent = 'Lähetetään…';
  try {
    let audioUrl = '';
    if (audioBlob) { try { audioUrl = await uploadAudio(); } catch (_) { toast('Äänen lataus epäonnistui — teksti lähetetään silti.', true); } }

    const extra = buildExtra(message, category, audioUrl);
    const body = JSON.stringify({
      site: CFG.site, path: location.pathname, event: 'feedback',
      extra,
      user: id ? { email: id.email, name: id.name, sub: id.sub } : undefined,
      idToken: id ? id.idToken : undefined,
    });
    const resp = await fetch(CFG.collectEndpoint, {
      method: 'POST', mode: 'cors', keepalive: true,
      headers: { 'content-type': 'text/plain;charset=UTF-8' }, body,
    });
    if (!resp.ok && resp.status !== 204 && resp.status !== 0) throw new Error('HTTP ' + resp.status);
    saveMine(extra);
    if (sel && sel.kind === 'selection' && R.isRendered(sel.page)) paintMine(sel.page, R.hlLayer(sel.page));
    composerSent = true;
    R.emit('comment_sent', { kind: extra.kind, page: extra.page, category, len: message.length, audio: !!audioUrl });
    toast('Kiitos! Kommentti tallennettu.');
    closeComposer();
  } catch (e) {
    toast('Lähetys epäonnistui: ' + (e.message || e), true);
    send.disabled = false; send.textContent = label;
  }
}

function buildExtra(message, category, audioUrl) {
  const base = {
    kind: sel ? sel.kind : 'page',
    page: sel ? sel.page : R.currentPage(),
    category,
    message,
    v: CFG.buildVersion || 'dev',
    url: location.origin + location.pathname + '#p=' + (sel ? sel.page : R.currentPage()),
  };
  if (audioUrl) base.audioUrl = audioUrl;
  if (sel && sel.kind === 'selection') {
    base.quote = sel.quote;
    base.rects = sel.rects;
  }
  // Keep under the Worker's 4096-char extra cap: trim rects, then quote.
  let s = JSON.stringify(base);
  while (s.length > MAX_EXTRA && base.rects && base.rects.length) { base.rects = base.rects.slice(0, Math.floor(base.rects.length / 2)); s = JSON.stringify(base); }
  if (s.length > MAX_EXTRA && base.quote) { base.quote = base.quote.slice(0, 400); s = JSON.stringify(base); }
  return base;
}

/* ---------------- local echo of the commenter's own notes ---------------- */
function loadMine() { try { return JSON.parse(localStorage.getItem(LS_MINE) || '[]'); } catch (_) { return []; } }
function saveMine(extra) {
  const all = loadMine();
  all.push({ page: extra.page, quote: extra.quote || '', rects: extra.rects || [], message: extra.message, kind: extra.kind, t: Date.now() });
  try { localStorage.setItem(LS_MINE, JSON.stringify(all.slice(-500))); } catch (_) {}
}
function paintMine(n, hl) {
  if (!hl) return;
  // clear previously painted mine markers, keep nothing else (hl is ours)
  hl.querySelectorAll('i.mine').forEach((x) => x.remove());
  const mine = loadMine().filter((c) => c.page === n && c.rects && c.rects.length);
  for (const c of mine) {
    for (const r of c.rects) {
      const i = document.createElement('i');
      i.className = 'mine';
      i.style.left = (r.x * 100) + '%'; i.style.top = (r.y * 100) + '%';
      i.style.width = (r.w * 100) + '%'; i.style.height = (r.h * 100) + '%';
      i.title = c.message ? c.message.slice(0, 200) : 'Oma kommenttisi';
      i.addEventListener('click', () => toast('Oma kommenttisi: ' + (c.message || '(ääni)')));
      hl.appendChild(i);
    }
  }
}

/* ---------------- toast ---------------- */
let toastTimer = 0;
function toast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.toggle('err', !!err); t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3600);
}
