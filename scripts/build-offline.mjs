import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const files = await readdir('dist/assets');
const assets = ['/','/index.html','/edition-icon.svg',...files.map(file=>'/assets/'+file)];
const hash=createHash('sha256').update(await readFile('dist/index.html')).digest('hex').slice(0,12);
await writeFile('dist/sw.js', `// Generated with the production build. Business records are never cached here.
const CACHE = 'myfin-edition-${hash}';
const ASSETS = ${JSON.stringify(assets)};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('myfin-edition-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/index.html')));
  } else if (ASSETS.includes(new URL(event.request.url).pathname)) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});
`);
console.log(`Offline shell: ${assets.length} local assets, version ${hash}`);
