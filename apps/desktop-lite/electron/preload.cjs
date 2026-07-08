// Preload bridge — intentionally empty in v1.
//
// The dashboard (web/) communicates with the backend over standard HTTP/WS, so
// no contextBridge surface is needed to get a working app. Phase 3 gaps
// (reveal-in-explorer, trash, native folder dialog) will expose a minimal
// `window.hermesShell` here, each guarded so web/ degrades safely in a real
// browser. See apps/desktop-lite/CUSTOM_ROADMAP.md, Phase 3.
