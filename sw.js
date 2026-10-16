// Uygulama dosyalarını önbelleğe alır; tablet internete bağlı olmasa da uygulama açılır.
// İnternet varsa her zaman sunucudaki en yeni dosya kullanılır (güncellemeler hemen gelir);
// internet yoksa ya da sunucu birkaç saniye içinde cevap vermezse önbellekteki kopya açılır.
const CACHE = 'not-defteri-v12';
const NETWORK_TIMEOUT_MS = 4000;
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/backup.js',
  'js/db.js',
  'js/editor.js',
  'js/icons.js',
  'js/library.js',
  'js/pdf.js',
  'js/render.js',
  'js/shapes.js',
  'js/ui.js',
  'js/util.js',
  'vendor/pdf.min.mjs',
  'vendor/pdf.worker.min.mjs',
  'vendor/pdf-lib.min.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'icons/mascot.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const key = req.mode === 'navigate' ? 'index.html' : req;
  try {
    // no-cache: tarayıcının kendi HTTP önbelleğindeki eski kopyayı değil, sunucudakini doğrula.
    const res = await Promise.race([
      fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS)),
    ]);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch {
    const cached = await cache.match(key, { ignoreSearch: true });
    return cached || Response.error();
  }
}
