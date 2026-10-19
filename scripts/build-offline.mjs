import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const files = (await readdir('dist/assets', { withFileTypes: true }))
  .filter(entry => entry.isFile())
  .map(entry => entry.name)
  .sort();
const cachedFiles = ['index.html', 'edition-icon.svg', ...files.map(file => `assets/${file}`)];
const assets = ['/', ...cachedFiles.map(file => `/${file}`)];
const indexPath = join('dist', 'index.html');
const builtIndex = await readFile(indexPath, 'utf8');
const index = builtIndex.replace(/<meta name="myfin-release" content="[a-f0-9]+"[ \t]*\/?>\r?\n?/g, '');
const digest = createHash('sha256');
for (const file of cachedFiles) {
  digest.update(file);
  digest.update('\0');
  digest.update(file === 'index.html' ? index : await readFile(join('dist', file)));
  digest.update('\0');
}
const hash = digest.digest('hex').slice(0, 12);
if (!index.includes('</head>')) throw new Error('Built index is missing </head>');
const releasedIndex = index.replace('</head>', `<meta name="myfin-release" content="${hash}">\n</head>`);
const worker = `// Generated with the production build. Business records are never cached here.
const CACHE = 'myfin-edition-${hash}';
const ASSETS = ${JSON.stringify(assets)};
const CLIENT_RELEASE = /^[a-f0-9]{12}$/;
const clientReleases = new Map();
async function removeUnusedCaches() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const clientIds = new Set(clients.map(client => client.id));
  for (const id of clientReleases.keys()) if (!clientIds.has(id)) clientReleases.delete(id);
  const missing = clients.filter(client => !clientReleases.has(client.id));
  if (missing.length) {
    for (const client of missing) client.postMessage({ type: 'REQUEST_CLIENT_RELEASE' });
    return;
  }
  const retained = new Set([CACHE, ...clientReleases.values()].map(release => release.startsWith('myfin-edition-') ? release : 'myfin-edition-' + release));
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith('myfin-edition-') && !retained.has(key)).map(key => caches.delete(key)));
}
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.source?.postMessage({ type: 'APP_UPDATE_ACCEPTED' });
    event.waitUntil(self.skipWaiting());
  } else if (event.data?.type === 'CLIENT_RELEASE' && event.source?.id && CLIENT_RELEASE.test(event.data.release)) {
    clientReleases.set(event.source.id, event.data.release);
    event.waitUntil(removeUnusedCaches());
  }
});
self.addEventListener('activate', event => event.waitUntil(self.clients.claim().then(async () => {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: 'REQUEST_CLIENT_RELEASE' });
})));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  let path;
  try { path = decodeURIComponent(new URL(event.request.url).pathname); } catch { return; }
  if (path.split('/').filter(Boolean)[0] === 'api') return;
  if (event.request.mode === 'navigate') {
    const shell = () => caches.open(CACHE).then(cache => cache.match('/index.html'));
    event.respondWith(fetch(event.request).then(response => response.ok ? response : shell().then(cached => cached || response)).catch(shell));
  } else if (ASSETS.includes(path)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(event.request)).then(cached => cached || fetch(event.request)));
  } else if (path.startsWith('/assets/')) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});
`;
await Promise.all([
  writeFile(indexPath, releasedIndex),
  writeFile(join('dist', 'release.json'), `${JSON.stringify({ release: hash })}\n`),
  writeFile(join('dist', 'offline-worker'), worker),
  writeFile(join('dist', 'sw.js'), worker),
]);
console.log(`Offline shell: ${assets.length} local assets, version ${hash}`);
