/* PhD public reader — Google Sign-In (Google Identity Services).
 *
 * Stores the verified identity under CFG.identityKey (default 'unitas:identity',
 * the same localStorage key the MyPublicAnalytics Worker already reads), so a
 * feedback POST carries {user,idToken} and the Worker stamps user_verified=1.
 *
 * Exposes window.PhdAuth: { getIdentity(), signOut(), prompt() } and fires a
 * 'phd-auth-change' event on window whenever sign-in state changes.
 */
let CFG = {};
let gisReady = false;

export function initAuth(cfg) {
  CFG = cfg || {};
  window.PhdAuth = { getIdentity, signOut, prompt: () => promptSignIn(), isReady: () => gisReady };
  renderWho();
  loadGis();
}

function loadGis() {
  if (document.getElementById('gis-sdk')) return;
  const s = document.createElement('script');
  s.id = 'gis-sdk';
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = onGisLoad;
  s.onerror = () => { gisReady = false; renderWho(); };
  document.head.appendChild(s);
}

function onGisLoad() {
  if (!window.google || !google.accounts || !google.accounts.id) return;
  try {
    google.accounts.id.initialize({
      client_id: CFG.googleClientId,
      callback: onCredential,
      auto_select: true,
      use_fedcm_for_prompt: true,
    });
    gisReady = true;
    renderWho();
  } catch (e) { console.warn('GIS init failed', e); }
}

function onCredential(resp) {
  if (!resp || !resp.credential) return;
  const claims = decodeJwt(resp.credential);
  if (!claims) return;
  const id = {
    email: claims.email || '',
    name: claims.name || claims.email || '',
    sub: claims.sub || '',
    picture: claims.picture || '',
    idToken: resp.credential,
    exp: claims.exp || 0,
    t: Date.now(),
  };
  try { localStorage.setItem(CFG.identityKey || 'unitas:identity', JSON.stringify(id)); } catch (_) {}
  renderWho();
  window.dispatchEvent(new CustomEvent('phd-auth-change', { detail: { signedIn: true, id } }));
}

export function getIdentity() {
  try {
    const raw = localStorage.getItem(CFG.identityKey || 'unitas:identity');
    if (!raw) return null;
    const id = JSON.parse(raw);
    if (id && id.exp && id.exp * 1000 < Date.now() - 5000) return null; // token expired
    return id && id.email ? id : null;
  } catch (_) { return null; }
}

export function signOut() {
  try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (_) {}
  try { localStorage.removeItem(CFG.identityKey || 'unitas:identity'); } catch (_) {}
  renderWho();
  window.dispatchEvent(new CustomEvent('phd-auth-change', { detail: { signedIn: false } }));
}

function promptSignIn() {
  if (!gisReady) { loadGis(); return; }
  try { google.accounts.id.prompt(); } catch (e) { console.warn(e); }
}

/* ---- UI ---- */
function renderWho() {
  const who = document.getElementById('who');
  const gbtn = document.getElementById('gbtn');
  if (!who || !gbtn) return;
  const id = getIdentity();
  if (id) {
    gbtn.style.display = 'none';
    who.innerHTML = '';
    if (id.picture) { const img = document.createElement('img'); img.src = id.picture; img.alt = ''; who.appendChild(img); }
    const span = document.createElement('span'); span.textContent = id.name || id.email; who.appendChild(span);
    const out = document.createElement('button'); out.className = 'btn'; out.textContent = 'Kirjaudu ulos';
    out.onclick = signOut; who.appendChild(out);
    who.style.display = 'flex';
  } else {
    who.style.display = 'none';
    gbtn.style.display = '';
    gbtn.innerHTML = '';
    if (gisReady && window.google) {
      try {
        google.accounts.id.renderButton(gbtn, { type: 'standard', theme: 'outline', size: 'medium', text: 'signin_with', shape: 'pill' });
      } catch (_) { fallbackBtn(gbtn); }
    } else {
      fallbackBtn(gbtn);
    }
  }
}

function fallbackBtn(gbtn) {
  const b = document.createElement('button');
  b.className = 'btn primary';
  b.textContent = 'Kirjaudu Googlella';
  b.onclick = promptSignIn;
  gbtn.appendChild(b);
}

function decodeJwt(t) {
  try {
    const p = t.split('.')[1];
    const json = atob(p.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch (_) { return null; }
}
