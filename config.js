/* PhD public reader — runtime config (classic script, loaded first in <head>).
 *
 * This is the ONE place to tune endpoints/keys. The publish script copies this
 * file verbatim into the `phd` repo, so editing it here changes the live site
 * on the next publish. No secrets belong here — everything is public by design
 * (the Google client id and the MyPA endpoint are already public on other
 * longshoreforrest.github.io sites).
 */
window.PHD_VIEWER_CONFIG = {
  // The compressed dissertation PDF, sitting next to reader.html in the phd repo.
  pdfUrl: './thesis.pdf',

  // Human title shown in the top bar + browser tab.
  title: 'Tapio Pitkäranta — Väitöskirja',

  // ---- Feedback channel (reuse the existing MyPublicAnalytics Cloudflare Worker) ----
  // Proven in production by the calculus-fennicus reader. Comments POST here as
  // event:'feedback' with site:'phd'. Owner reads them privately (D1 export /
  // MyPA dashboard filtered to site='phd'); they never render on this page.
  site: 'phd',
  collectEndpoint: 'https://mypa.longshoreforrest.workers.dev/collect',

  // ---- Google Sign-In (Google Identity Services) ----
  // Reuse the client id the MyPA Worker already verifies against, so tokens land
  // as user_verified=1. REQUIRES that this site's origin be listed under the
  // client's "Authorized JavaScript origins" in Google Cloud Console:
  //   https://longshoreforrest.github.io   and   http://localhost:8732
  googleClientId: '605639423178-s3pu2m6mkf9r50u69709u0mhchf0ha97.apps.googleusercontent.com',
  identityKey: 'unitas:identity', // shared localStorage key (same as MyPA beacon)
  requireSignIn: true,            // must be signed in to submit a comment

  // ---- Voice ----
  dictationLang: 'fi-FI',         // Web Speech API dictation language

  // ---- Phase 2: real audio recording ----
  // Leave '' to keep audio OFF (dictation-to-text still works). Set to the
  // deployed phd-audio Worker URL to enable MediaRecorder capture + upload.
  audioEndpoint: '',

  // Local build/version stamp (publish script overwrites this).
  buildVersion: '20260827-1813',
};
