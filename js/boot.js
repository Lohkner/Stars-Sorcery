// ── Boot sequence ──────────────────────────────────────────
// Single entry point. Uses addEventListener (not assignment) so it
// never conflicts with other listeners and never misses an already-
// fired 'load' event (readyState guard handles that case).
(function boot() {
  function dismissLoader() {
    const l = document.getElementById('ss-loader');
    if (!l) return;
    l.classList.add('fade-out');
    setTimeout(() => { if (l.parentNode) l.parentNode.removeChild(l); }, TIMING.LOADER_DISMISS * 2);
  }

  function startApp() {
    try {
      app.init();
    } catch(err) {
      console.error('S&S init error:', err);
    }
    // Dismiss loader after init — short delay so first paint is ready
    setTimeout(dismissLoader, TIMING.LOADER_DISMISS);
  }

  // Register SW independently (non-blocking, no relation to app init).
  // Update-aware: when a new SW takes control, prompt the user to reload so
  // they actually receive the latest version instead of a stale cache.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      // A new worker is installing → watch it.
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          // Installed + an existing controller means this is an UPDATE, not first install.
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            try {
              app.toast('Nueva versión disponible — toca para actualizar', 'info', () => {
                nw.postMessage && nw.postMessage({ type: 'SKIP_WAITING' });
                location.reload();
              });
            } catch(e) { /* toast may not support action; ignore */ }
          }
        });
      });
      // Check for updates each launch.
      reg.update && reg.update();
    }).catch(() => {});

    // When the controlling worker changes, reload once to pick up new assets.
    let _reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (_reloaded) return; _reloaded = true; location.reload();
    });
  }

  // Fire as soon as DOM is ready — app needs DOM only, not external resources
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp, { once: true });
  } else {
    // 'interactive' or 'complete' — DOM already parsed
    setTimeout(startApp, 0);
  }

  // Safety net: if something hangs, dismiss loader after 5s regardless
  setTimeout(dismissLoader, TIMING.LOADER_TIMEOUT);
})();
