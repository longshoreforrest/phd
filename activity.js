/* PhD public reader — behaviour analytics (ES module).
 *
 * Sends every reader action to MyPublicAnalytics (site='phd') through the
 * vendored beacon (window.mypa.send → Worker /collect → D1). Identity comes
 * from the shared localStorage key the beacon already reads, so a signed-in
 * reader's events carry user_email (verified server-side via the Google id
 * token; later events in the same session inherit it).
 *
 * Events (all with `page` = current page where meaningful):
 *   pageview        (beacon, on load; client context)
 *   page_view       reader settled on a page (≥ SETTLE_MS)          {page, from, method}
 *   page_dwell      left a page after ≥ DWELL_MIN_MS                {page, ms, active_ms, scroll_ms}
 *   nav             explicit navigation                             {method: prev|next|input|key|hash, page, from}
 *   link            clicked a PDF link                              {kind: internal|external, page, to|href}
 *   back            ↩ / Alt+←                                       {from}
 *   zoom            zoom changed                                    {zoom, from, method: button|keyboard|wheel|pinch|fit}
 *   search_open / search / search_nav / search_close                {q, hits, i, of, page}
 *   comment_open / comment_cancel / comment_sent                    {kind, page, category, len, audio}
 *   feedback        the comment itself (comments.js)
 *   voice           dictation / recording started                   {mode}
 *   signin / signout                                                {}
 *   heartbeat       every HEARTBEAT_MS while visible                {page, active_ms, scroll_ms, pages_seen, max_page, …}
 *   engagement_end  tab hidden / page closed                        {visible_ms, active_ms, scroll_ms, scroll_events, pages_seen,
 *                                                                    max_page, last_page, zooms, searches, links, comments, min_zoom, max_zoom, reason}
 */
export function initActivity(R, CFG) {
  if (!CFG || CFG.analytics === false) return;
  const SETTLE_MS = 800, DWELL_MIN_MS = 2500, HEARTBEAT_MS = 60000, IDLE_MS = 15000, SCROLL_GAP_MS = 1200;
  const stage = document.getElementById('stage');

  const now = () => Date.now();
  const t = {
    start: now(), lastActivity: now(), lastVisible: now(), visibleMs: 0, activeMs: 0,
    scrollMs: 0, scrollEvents: 0, lastScroll: 0,
    page: R.currentPage() || 1, pageSince: now(), pageActiveMs: 0, pageScrollMs: 0, pageMethod: 'load',
    pagesSeen: new Set(), maxPage: 1, zooms: 0, searches: 0, links: 0, comments: 0, backs: 0,
    minZoom: 1, maxZoom: 1, settleTimer: 0, ended: false, lastHeartbeat: now(),
  };

  function send(ev, extra) {
    try { if (window.mypa && window.mypa.send) window.mypa.send(ev, Object.assign({ page: t.page }, extra || {})); } catch (_) {}
  }
  // The beacon is a classic deferred script; wait for it (max ~5 s) before the first custom event.
  const queue = [];
  function sendQ(ev, extra) { if (window.mypa && window.mypa.send) { flush(); send(ev, extra); } else queue.push([ev, extra]); }
  function flush() { while (queue.length) { const [e, x] = queue.shift(); send(e, x); } }
  let waited = 0; const wt = setInterval(() => { if (window.mypa || (waited += 250) > 5000) { clearInterval(wt); flush(); } }, 250);

  /* ---- activity / visibility accounting ---- */
  function tick() {
    const n = now();
    if (document.visibilityState === 'visible') {
      t.visibleMs += n - t.lastVisible;
      if (n - t.lastActivity < IDLE_MS) { t.activeMs += n - t.lastVisible; t.pageActiveMs += n - t.lastVisible; }
    }
    t.lastVisible = n;
  }
  const activityEvents = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];
  for (const e of activityEvents) window.addEventListener(e, () => { t.lastActivity = now(); }, { passive: true, capture: true });
  setInterval(tick, 1000);

  stage.addEventListener('scroll', () => {
    const n = now();
    t.scrollEvents++;
    if (t.lastScroll && n - t.lastScroll < SCROLL_GAP_MS) { t.scrollMs += n - t.lastScroll; t.pageScrollMs += n - t.lastScroll; }
    t.lastScroll = n;
  }, { passive: true });

  /* ---- page dwell ---- */
  // A navigation (button, link, search…) smooth-scrolls through intermediate
  // pages; only the page the reader SETTLES on (SETTLE_MS without change) gets
  // a page_view, attributed to the pending navigation method and to the
  // previously settled page. Intermediate pages never reach DWELL_MIN_MS.
  let settled = t.page, pendingMethod = null, pendingUntil = 0;
  function leavePage(next) {
    tick();
    const ms = now() - t.pageSince;
    if (ms >= DWELL_MIN_MS) sendQ('page_dwell', { page: t.page, ms, active_ms: t.pageActiveMs, scroll_ms: t.pageScrollMs });
    t.page = next; t.pageSince = now(); t.pageActiveMs = 0; t.pageScrollMs = 0;
    t.maxPage = Math.max(t.maxPage, next);
    clearTimeout(t.settleTimer);
    t.settleTimer = setTimeout(() => {
      const method = (pendingMethod && now() < pendingUntil) ? pendingMethod : 'scroll';
      pendingMethod = null;
      const from = settled; settled = next; t.pagesSeen.add(next);
      if (from !== next) sendQ('page_view', { page: next, from, method });
    }, SETTLE_MS);
  }
  t.pagesSeen.add(t.page);
  function intent(method) { pendingMethod = method; pendingUntil = now() + 2500; }
  R.on('nav', (d) => { intent(d.method); sendQ('nav', { method: d.method, page: d.page, from: d.from }); });
  R.on('page', (d) => { if (d.page !== t.page) leavePage(d.page); });

  /* ---- discrete actions ---- */
  R.on('link', (d) => { t.links++; if (d.kind === 'internal') intent('link'); sendQ('link', d); });
  R.on('back', (d) => { t.backs++; intent('back'); sendQ('back', d); });
  R.on('zoom', (d) => { t.zooms++; t.minZoom = Math.min(t.minZoom, d.zoom); t.maxZoom = Math.max(t.maxZoom, d.zoom); sendQ('zoom', d); });
  R.on('search_open', (d) => sendQ('search_open', d));
  let lastSearchQ = '';
  R.on('search', (d) => { if (!d.q || d.q === lastSearchQ) return; lastSearchQ = d.q; t.searches++; intent('search'); sendQ('search', d); });
  R.on('search_nav', (d) => { intent('search'); sendQ('search_nav', d); });
  R.on('search_close', (d) => sendQ('search_close', d));
  R.on('comment_open', (d) => sendQ('comment_open', d));
  R.on('comment_cancel', (d) => sendQ('comment_cancel', d));
  R.on('comment_sent', (d) => { t.comments++; sendQ('comment_sent', d); });
  R.on('voice', (d) => sendQ('voice', d));
  window.addEventListener('phd-auth-change', (e) => sendQ(e.detail && e.detail.signedIn ? 'signin' : 'signout', {}));

  /* ---- heartbeat + engagement_end ---- */
  function summary(reason) {
    tick();
    return {
      reason, page: t.page, visible_ms: t.visibleMs, active_ms: t.activeMs, total_ms: now() - t.start,
      scroll_ms: t.scrollMs, scroll_events: t.scrollEvents, pages_seen: t.pagesSeen.size, max_page: t.maxPage,
      last_page: t.page, zooms: t.zooms, searches: t.searches, links: t.links, backs: t.backs, comments: t.comments,
      min_zoom: t.minZoom, max_zoom: t.maxZoom, num_pages: R.numPages || 0,
    };
  }
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (now() - t.lastActivity > HEARTBEAT_MS * 2) return;   // idle tab: stay quiet
    sendQ('heartbeat', summary('heartbeat'));
  }, HEARTBEAT_MS);
  let hiddenSent = false;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (!hiddenSent) { hiddenSent = true; sendQ('engagement_end', summary('hidden')); } }
    else { hiddenSent = false; t.lastVisible = now(); t.lastActivity = now(); }
  });
  window.addEventListener('pagehide', () => { if (!hiddenSent) { hiddenSent = true; sendQ('engagement_end', summary('pagehide')); } });

  return { summary };
}
