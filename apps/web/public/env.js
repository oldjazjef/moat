// Runtime configuration, read by core/config/runtime-env.ts before the app boots.
//
// NOT bundled into the JS — a static asset loaded by a plain <script> in index.html, so one build
// artefact serves every environment. Moat Desktop does not use this file: its app:// protocol
// generates env.js with authMode 'local' (apps/desktop/src/main/lib/web-protocol.ts).
window.__MT_ENV__ = {
  // Empty = same origin.
  apiBaseUrl: '',
  // 'local' = Moat Desktop (no sign-in). The Cloud's own sign-in joins as another mode.
  authMode: 'local',
};
