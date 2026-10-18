import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerFiles } from '../src/files.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function fixture(root) {
  const routes = new Map(), files = new Map(), calls = [];
  const app = {
    async register() {},
    post(path, options, handler) { routes.set(`POST ${path}`, handler || options); },
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    patch(path, handler) { routes.set(`PATCH ${path}`, handler); },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
  };
  const client = { async query(sql, params = []) {
    calls.push({ sql, params });
    if (sql.includes('pg_advisory_xact_lock')) return { rows:[], rowCount:1 };
    if (sql.includes('FROM myfin.auth_session')) return { rows:[{ id:'session-a' }], rowCount:1 };
    if (sql.includes('FROM myfin.app_identities')) return { rows:[{ id:'owner-a', is_super:true }], rowCount:1 };
    if (sql.includes('FROM myfin.companies') && sql.includes('archived_at'))
      return { rows:[{ id:'company-a', workspace_id:'workspace-a' }], rowCount:1 };
    if (sql.includes('INSERT INTO myfin.files')) {
      files.set(params[0], { id:params[0], company_id:params[1], actor_id:params[2], kind:params[3],
        mime:params[4], size:params[5], label:params[6], alt_text:'', created_at:'created' });
      return { rows:[], rowCount:1 };
    }
    if (sql.includes('INSERT INTO myfin.activities')) return { rows:[], rowCount:1 };
    if (sql.includes("WHERE company_id=$1 AND kind='assets' ORDER BY"))
      return { rows:[...files.values()].filter(row => row.company_id === params[0] && row.kind === 'assets'),
        rowCount:files.size };
    if (sql.includes('UPDATE myfin.files SET label=')) {
      const row = files.get(params[1]);
      if (!row || row.company_id !== params[0] || row.kind !== 'assets') return { rows:[], rowCount:0 };
      Object.assign(row, { label:params[2], alt_text:params[3] });
      return { rows:[row], rowCount:1 };
    }
    if (sql.includes("WHERE id=$1 AND kind='assets'")) {
      const row = files.get(params[0]);
      return row?.kind === 'assets' ? { rows:[row], rowCount:1 } : { rows:[], rowCount:0 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  } };
  return registerFiles(app, { database:{ transaction:fn => fn(client) }, uploadDir:root })
    .then(() => ({ routes, files, calls }));
}

const request = (params = {}) => ({
  params:{ company:'company-a', ...params },
  identity:{ id:'owner-a', role:'super_admin', username:'Owner' },
  authLevel:'password', authSessionId:'session-a',
});

test('storefront assets upload once, retain reusable metadata, and stream only through the public asset route', async t => {
  const root = await mkdtemp(join(tmpdir(), 'myfin-assets-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const { routes, files } = await fixture(root);
  const upload = await routes.get('POST /api/companies/:company/files/:kind')({
    ...request({ kind:'assets' }),
    file:async () => ({ filename:'  Campus hero.png  ', file:{ truncated:false }, toBuffer:async () => png }),
  });
  assert.match(upload.id, /^[0-9a-f-]{36}$/);
  assert.equal(upload.url, `/api/files/${upload.id}`);
  assert.equal(upload.publicUrl, `/api/public/storefront-assets/${upload.id}`);
  assert.equal(upload.label, 'Campus hero.png');
  assert.deepEqual(await readFile(join(root, upload.id)), png);

  const listed = await routes.get('GET /api/companies/:company/storefront/assets')(request());
  assert.equal(listed.assets.length, 1);
  assert.equal(listed.assets[0].publicUrl, upload.publicUrl);
  const updated = await routes.get('PATCH /api/companies/:company/storefront/assets/:id')({
    ...request({ id:upload.id }), body:{ label:'Campus launch', altText:'Students collecting drinks' },
  });
  assert.equal(updated.asset.label, 'Campus launch');
  assert.equal(updated.asset.altText, 'Students collecting drinks');

  const headers = {};
  const reply = { header(name, value) { headers[name.toLowerCase()] = value; return this; }, send(value) { return value; } };
  const stream = await routes.get('GET /api/public/storefront-assets/:id')({ params:{ id:upload.id } }, reply);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), png);
  assert.equal(headers['cache-control'], 'public, max-age=31536000, immutable');

  files.set('2c179bbb-d0ce-4f02-87fa-68ad6f7abe25', { id:'2c179bbb-d0ce-4f02-87fa-68ad6f7abe25',
    company_id:'company-a', kind:'receipts', mime:'image/png', size:png.length });
  await assert.rejects(routes.get('GET /api/public/storefront-assets/:id')(
    { params:{ id:'2c179bbb-d0ce-4f02-87fa-68ad6f7abe25' } }, reply,
  ), error => error.statusCode === 404 && error.message === 'not_found');
});

test('storefront asset migration permits only bounded reusable image paths', async () => {
  const sql = await readFile(new URL('../../db/migrations/0048_storefront_asset_library.sql', import.meta.url), 'utf8');
  assert.match(sql, /kind IN \('products','receipts','assets'\)/);
  assert.match(sql, /kind <> 'assets' OR mime IN \('image\/jpeg','image\/png','image\/webp'\)/);
  assert.match(sql, /storefront_settings_logo_url_check/);
  assert.match(sql, /\/api\/public\/storefront-assets\//);
  assert.doesNotMatch(sql, /GRANT .*PUBLIC/i);
});
