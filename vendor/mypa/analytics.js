/*!
 * MyPublicAnalytics beacon — selainpuolen snippet.
 *
 * Lähetys:
 *   - 'pageview' automaattisesti sivun latautuessa
 *   - Custom-eventit: window.mypa.send('section_view', { section: 'experience' })
 *
 * Sivukohtainen perus-extra (valinnainen, aseta ennen latausta):
 *   window.__MYPA_EXTRA__ = { assignment: '0018' };   // liitetään joka eventtiin
 *
 * HUOM: lähetettävä `path` on pathname + search — location.hash EI koskaan
 * kulje mukana. Salatut sivut (MyAssistant) pitävät purkuavaimen juuri
 * #-osassa, joten avain ei päädy analytiikkaan.
 *
 * Käyttää navigator.sendBeacon() (eloonjäänti sivu-vaihdoksen yli) ja
 * fetch keepalive:n fallbackia.
 *
 * Self-tagging (oman vierailusi erottelu):
 *   Käy kerran sivulla URL:lla ?_mypa_self=1 → localStorageen tallentuu lippu,
 *   ja kaikki tulevat eventit lähetetään {self:true}. Pois: ?_mypa_self=0.
 */
(function () {
  if (typeof window === "undefined") return;
  if (window.mypa && window.mypa.__initialized) return;

  var SITE = window.__MYPA_SITE__ || "unknown";
  var ENDPOINT = window.__MYPA_ENDPOINT__ || "";
  var AUTO_EVENT = window.__MYPA_AUTO_EVENT__ || "pageview";

  if (!ENDPOINT) return;

  // Perus-extra, joka liitetään JOKAISEEN tämän sivun eventtiin. Julkaisija
  // asettaa tämän ennen beaconin latausta, esim. MyAssistantin salattu
  // raportti: window.__MYPA_EXTRA__ = { assignment: '0018', doc: 0 }.
  // Näin sivukohtainen identiteetti kulkee mukana ilman että polkuun tai
  // otsikkoon tarvitsee laittaa mitään sisällöstä kertovaa.
  var BASE_EXTRA = null;
  try {
    var be = window.__MYPA_EXTRA__;
    if (be && typeof be === "object") BASE_EXTRA = be;
  } catch (e) {}

  // Self-marker: URL-parametri tai localStorage-lippu.
  var SELF = false;
  try {
    var sp = new URLSearchParams(window.location.search);
    if (sp.get("_mypa_self") === "1") {
      try { localStorage.setItem("mypa_self", "1"); } catch (e) {}
    } else if (sp.get("_mypa_self") === "0") {
      try { localStorage.removeItem("mypa_self"); } catch (e) {}
    }
    try { SELF = localStorage.getItem("mypa_self") === "1"; } catch (e) {}
  } catch (e) {}

  function utm() {
    try {
      var p = new URLSearchParams(window.location.search);
      return {
        source: p.get("utm_source") || null,
        medium: p.get("utm_medium") || null,
        campaign: p.get("utm_campaign") || null,
      };
    } catch (e) {
      return { source: null, medium: null, campaign: null };
    }
  }

  // Käyttäjäidentiteetti (esim. Google Sign-In) jaetusta localStoragesta.
  // Kirjoitettu muotoon { email, name, sub, idToken, t }. Worker varmentaa
  // idTokenin RS256/JWKS:llä; user-kenttä on varauloskäynti (varmentamaton).
  var IDENTITY_KEY = window.__MYPA_IDENTITY_KEY__ || "unitas:identity";
  function identity() {
    try {
      var raw = localStorage.getItem(IDENTITY_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.email) return null;
      return o;
    } catch (e) {
      return null;
    }
  }

  // Korkean entropian UA Client Hints (tarkka laitemalli). Vain Chromium.
  // navigator.userAgentData.getHighEntropyValues on asynkroninen, joten
  // populoimme tämän kertaalleen ja liitämme sen kaikkiin lähetettäviin
  // eventteihin. resolveHighEntropy() kutsuu callbackin joka tapauksessa —
  // myös silloin kun rajapintaa ei ole tai se hylkää — jottei pageview jää
  // lähettämättä.
  var UACH = null;
  function resolveHighEntropy(cb) {
    try {
      var uad = navigator.userAgentData;
      if (uad && typeof uad.getHighEntropyValues === "function") {
        uad
          .getHighEntropyValues([
            "model",
            "platformVersion",
            "architecture",
            "bitness",
            "uaFullVersion",
          ])
          .then(function (he) {
            UACH = {
              model: he.model || null,
              platform_version: he.platformVersion || null,
              arch: he.architecture || null,
              bitness: he.bitness || null,
              full_version: he.uaFullVersion || null,
            };
          })
          .catch(function () {})
          .then(function () { cb(); });
        return;
      }
    } catch (e) {}
    cb();
  }

  function clientContext() {
    var ctx = {};
    try {
      ctx.screen_w = window.screen && screen.width || null;
      ctx.screen_h = window.screen && screen.height || null;
      ctx.viewport_w = window.innerWidth || null;
      ctx.viewport_h = window.innerHeight || null;
      ctx.dpr = window.devicePixelRatio || null;
      ctx.language = (navigator.language || "").slice(0, 16);
      ctx.languages = Array.isArray(navigator.languages)
        ? navigator.languages.slice(0, 4).join(",")
        : null;
      ctx.color_scheme =
        (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches)
          ? "dark" : "light";
      ctx.tz =
        (Intl && Intl.DateTimeFormat &&
         new Intl.DateTimeFormat().resolvedOptions().timeZone) || null;
      ctx.tz_offset = -new Date().getTimezoneOffset();
      var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (c) {
        ctx.net_type = c.effectiveType || null;
        ctx.net_downlink = c.downlink || null;
        ctx.net_rtt = c.rtt || null;
        ctx.net_save_data = !!c.saveData;
      }
      ctx.touch = ("ontouchstart" in window) || (navigator.maxTouchPoints > 0);
      ctx.hardware_concurrency = navigator.hardwareConcurrency || null;
      ctx.device_memory = navigator.deviceMemory || null;
    } catch (e) {}
    return ctx;
  }

  function send(event, extra) {
    try {
      // Liitä client-konteksti pageview-eventtiin (kerran per session).
      var ev = event || "pageview";
      var enriched = Object.assign({}, BASE_EXTRA || {}, extra || {});
      if (ev === "pageview" || ev === "login_pageview") {
        Object.assign(enriched, clientContext());
      }
      var id = identity();
      var body = JSON.stringify({
        site: SITE,
        path: window.location.pathname + window.location.search,
        event: ev,
        referrer: document.referrer || "",
        utm: utm(),
        extra: Object.keys(enriched).length ? enriched : null,
        ch: UACH || undefined,
        self: SELF || undefined,
        user: id ? { email: id.email, name: id.name, sub: id.sub } : undefined,
        idToken: id && id.idToken ? id.idToken : undefined,
      });
      if (
        navigator.sendBeacon &&
        navigator.sendBeacon(
          ENDPOINT,
          new Blob([body], { type: "text/plain;charset=UTF-8" }),
        )
      ) {
        return;
      }
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: body,
        keepalive: true,
        mode: "cors",
        credentials: "omit",
      }).catch(function () {});
    } catch (e) {}
  }

  function autoSend() {
    // Odota korkean entropian client hintit ennen ensimmäistä lähetystä, jotta
    // laitemalli ehtii mukaan. UACH jää talteen myös custom-eventtejä varten.
    resolveHighEntropy(function () { send(AUTO_EVENT); });
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    autoSend();
  } else {
    document.addEventListener("DOMContentLoaded", autoSend);
  }

  window.mypa = { send: send, __initialized: true, __self: SELF };
})();
