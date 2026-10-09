import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { authConfig } from '../src/auth.js';

const root = new URL('../../', import.meta.url);
const read = file => readFile(new URL(file, root), 'utf8');

test('voucher HMAC key is loaded from a protected file and never required inline', async () => {
  const directory = await mkdtemp(path.join(tmpdir(),'myfin-voucher-secret-'));
  try {
    const files = {};
    for (const name of ['auth','pos-code','pos-session','voucher']) {
      files[name] = path.join(directory,`${name}.secret`);
      await writeFile(files[name],`${name.padEnd(36,'x')}\n`,{mode:0o600});
    }
    const config = authConfig({ NODE_ENV:'production',AUTH_BASE_URL:'https://admin.finn3.com',
      AUTH_ALLOWED_HOSTS:'*.finn3.com',AUTH_CONTROL_HOSTS:'admin.finn3.com',PUBLIC_ROOT_DOMAIN:'finn3.com',
      AUTH_SECRET_FILE:files.auth,POS_CODE_SECRET_FILE:files['pos-code'],
      POS_SESSION_SECRET_FILE:files['pos-session'],VOUCHER_HMAC_SECRET_FILE:files.voucher });
    assert.equal(config.voucherHmacSecret,'voucher'.padEnd(36,'x'));
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('student programmes are registered and deployment mounts the dedicated secret', async () => {
  const [business,compose,development,production] = await Promise.all([
    read('server/src/business.js'),read('deploy/compose.yml'),
    read('deploy/development.env.example'),read('deploy/production.env.example'),
  ]);
  assert.match(business,/registerStudentPrograms\(app,\{scoped,audit,voucherPepper:authOptions\.voucherHmacSecret\}\)/);
  assert.match(compose,/VOUCHER_HMAC_SECRET_FILE: \/run\/secrets\/voucher_hmac_secret/);
  assert.match(compose,/voucher_hmac_secret:/);
  assert.match(development,/MYFIN_VOUCHER_HMAC_SECRET_FILE=.*voucher-hmac\.secret/);
  assert.match(production,/MYFIN_VOUCHER_HMAC_SECRET_FILE=.*voucher-hmac\.secret/);
});

test('runtime student grants preserve immutable histories and trigger-owned counters', async () => {
  const grants = await Promise.all([
    read('db/grant-development-runtime.sql'),read('db/grant-production-runtime.sql'),
  ]);
  for (const source of grants) {
    assert.match(source,/GRANT SELECT,INSERT,UPDATE ON myfin\.student_eligibilities,myfin\.promotions/);
    assert.match(source,/GRANT SELECT,INSERT ON myfin\.student_eligibility_events,myfin\.promotion_versions/);
    assert.match(source,/GRANT SELECT ON myfin\.promotion_usage_counters,myfin\.promotion_customer_usage_counters,[\s\S]*myfin\.promotion_voucher_usage_counters,myfin\.promotion_voucher_customer_usage_counters/);
    for (const table of ['student_eligibility_events','promotion_versions','promotion_version_products',
      'promotion_version_categories','promotion_version_customers','promotion_voucher_versions'])
      assert.doesNotMatch(source,new RegExp(`GRANT[^;]*(?:UPDATE|DELETE)[^;]*myfin\\.${table}`));
    for (const table of ['promotion_usage_counters','promotion_customer_usage_counters',
      'promotion_voucher_usage_counters','promotion_voucher_customer_usage_counters'])
      assert.doesNotMatch(source,new RegExp(`GRANT[^;]*(?:INSERT|UPDATE|DELETE)[^;]*myfin\\.${table}`));
  }
});
