/* Cache-first service worker: every file the app needs, including OCR engine + English model, is cached on first visit. */
const CACHE = 'part-inspect-v3';
const FILES = [
  "./",
  "app.js",
  "icon-192.png",
  "icon-512.png",
  "index.html",
  "manifest.webmanifest",
  "native.js",
  "parse.js",
  "style.css",
  "vendor/core/tesseract-core-lstm.wasm.js",
  "vendor/core/tesseract-core-simd-lstm.wasm.js",
  "vendor/jszip.min.js",
  "vendor/lang/eng.traineddata.gz",
  "vendor/tesseract.min.js",
  "vendor/worker.min.js",
  "vendor/xlsx.full.min.js",
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
