/* ══════════════════════════════════════════════════════════════════
   S&S Companion — Service Worker
   ══════════════════════════════════════════════════════════════════
   Estrategia:
   · App shell  → precache + cache-first (funciona 100% offline).
   · Google Fonts → stale-while-revalidate en caché aparte.
   · Versionado: subir CACHE_VERSION invalida el caché anterior; el
     cliente recibe el aviso "Nueva versión disponible" (boot.js) y al
     tocarlo se envía {type:'SKIP_WAITING'} que este worker atiende.
   ══════════════════════════════════════════════════════════════════ */
'use strict';

const CACHE_VERSION = 'ss-companion-v3';
const FONT_CACHE    = 'ss-fonts-v1';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/main.css',
  './js/data.js',
  './js/constants.js',
  './js/storage.js',
  './js/ui-dialogs.js',
  './js/app.js',
  './js/boot.js',
  './Bind_Pact_Weapon.webp',
];

/* ── Install: precachear el app shell ─────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // addAll falla en bloque si un recurso no existe (p. ej. el icono
      // aún no subido); cachear uno a uno tolera ausencias sin romper.
      .then((cache) => Promise.allSettled(
        APP_SHELL.map((url) => cache.add(url))
      ))
  );
});

/* ── Activate: limpiar cachés de versiones anteriores ─────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((k) => k !== CACHE_VERSION && k !== FONT_CACHE)
        .map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

/* ── Mensajes desde la página (actualización inmediata) ───────── */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ── Fetch ─────────────────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Google Fonts: stale-while-revalidate (rápido + se actualiza solo).
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((res) => { if (res.ok) cache.put(request, res.clone()); return res; })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Mismo origen: cache-first con respaldo de red y actualización del caché.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) =>
        cached ||
        fetch(request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(request, copy));
          }
          return res;
        }).catch(() =>
          // Navegación sin red ni caché → devolver el shell.
          request.mode === 'navigate' ? caches.match('./index.html') : undefined
        )
      )
    );
  }
});
