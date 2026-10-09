const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
process.env.ADMIN_PASSWORD = 'test-only-admin-password-2026';
const { createPlatform } = require('../server');
const defaults = require('../lib/config');
let platform,
  server,
  origin,
  directory,
  admin,
  author,
  outsider,
  identityId,
  videoId,
  filmWork,
  filmApplication;
class Client {
  constructor() {
    this.cookie = '';
    this.csrf = null;
  }
  async request(url, method = 'GET', body, options = {}) {
    const headers = {
      Cookie: this.cookie,
      ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}),
      ...options.headers
    };
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const response = await fetch(origin + url, { method, headers, body, redirect: 'manual' });
    const jar = new Map(
      this.cookie
        .split('; ')
        .filter(Boolean)
        .map((pair) => pair.split('='))
    );
    for (const line of response.headers.getSetCookie()) {
      const [name, value] = line.split(';')[0].split('=');
      if (!value || /Max-Age=0/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
    this.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
    if (data.csrf) this.csrf = data.csrf;
    return { status: response.status, data, headers: response.headers };
  }
  async ok(url, method, body) {
    const result = await this.request(url, method, body);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
}
async function participant(alias) {
  const c = new Client();
  await c.ok('/api/auth/dev', 'POST', { alias });
  return c;
}
function bytes(kind, size = 128) {
  const buffer = Buffer.alloc(size, 1);
  if (kind === 'video') {
    buffer.writeUInt32BE(24, 0);
    buffer.write('ftypisom', 4);
  } else Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  return buffer;
}
async function task(client, kind, buffer) {
  return client.ok('/api/uploads', 'POST', {
    kind,
    filename: kind === 'video' ? 'fixture.mp4' : 'fixture.png',
    mime: kind === 'video' ? 'video/mp4' : 'image/png',
    size: buffer.length,
    fingerprint: crypto.createHash('sha256').update(buffer).digest('hex')
  });
}
async function sendPart(client, item, index, buffer) {
  const form = new FormData();
  form.append('chunk', new Blob([buffer]), 'part');
  return client.ok(`/api/uploads/${item.id}/chunks/${index}`, 'POST', form);
}
async function upload(client, kind) {
  const buffer = bytes(kind);
  const item = await task(client, kind, buffer);
  await sendPart(client, item, 0, buffer);
  await client.ok(`/api/uploads/${item.id}/complete`, 'POST');
  return item.id;
}
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qianwan-platform-test-'));
  const config = {
    ...defaults,
    production: false,
    devLogin: true,
    dataDir: directory,
    verificationDir: path.join(directory, 'wechat-verification'),
    databaseUrl: '',
    redisUrl: '',
    storage: 'local',
    deadlines: { registration: '', film: '', vote: '' }
  };
  platform = await createPlatform(config);
  server = platform.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  config.origin = origin;
  admin = new Client();
  await admin.ok('/api/auth/admin', 'POST', {
    username: 'admin',
    password: process.env.ADMIN_PASSWORD
  });
  author = await participant('TestFilmAuthor');
  outsider = await participant('TestOutside');
});
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  if (platform) await platform.close();
  // Verify the exact temporary target before removing test fixtures recursively.
  const resolved = path.resolve(directory || '');
  const parent = path.resolve(os.tmpdir());
  if (
    directory &&
    path.dirname(resolved) === parent &&
    path.basename(resolved).startsWith('qianwan-platform-test-')
  )
    await fs.rm(resolved, { recursive: true, force: true });
});
test('public visitors cannot read the backend, use legacy demo endpoints, or write without CSRF', async () => {
  const guest = new Client();
  assert.equal((await guest.request('/api/admin/works')).status, 401);
  assert.equal((await guest.request('/vendor/cos.js')).status, 200);
  assert.equal((await guest.request('/api/demo/login', 'POST')).status, 404);
  assert.equal(
    (await author.request('/api/uploads', 'POST', {}, { headers: { 'X-CSRF-Token': '' } })).status,
    403
  );
  assert.equal(
    (
      await author.request(
        '/api/applications/creator',
        'PUT',
        {},
        { headers: { Origin: 'https://untrusted.example' } }
      )
    ).status,
    403
  );
  assert.equal((await guest.request('/uploads/id_guess.png')).status, 404);
});
test('resumable uploads bind to their owner, reject bad indexes, and finalize idempotently', async () => {
  const buffer = bytes('video', defaults.chunkSize + 64),
    item = await task(author, 'video', buffer);
  await sendPart(author, item, 0, buffer.subarray(0, defaults.chunkSize));
  const restored = await task(author, 'video', buffer);
  assert.equal(restored.id, item.id);
  assert.deepEqual(restored.parts, [0]);
  assert.equal((await author.request(`/api/uploads/${item.id}/complete`, 'POST')).status, 400);
  assert.equal((await outsider.request(`/api/uploads/${item.id}`)).status, 400);
  const form = new FormData();
  form.append('chunk', new Blob([bytes('video')]), 'part');
  assert.equal(
    (await author.request(`/api/uploads/${item.id}/chunks/-1`, 'POST', form)).status,
    400
  );
  await sendPart(author, item, 1, buffer.subarray(defaults.chunkSize));
  await author.ok(`/api/uploads/${item.id}/complete`, 'POST');
  await author.ok(`/api/uploads/${item.id}/complete`, 'POST');
  videoId = item.id;
  identityId = await upload(author, 'identity');
});
test('film submission requires identity review before publication and never discloses personal fields', async () => {
  const payload = {
    realName: '测试创作者',
    phone: '13800000000',
    idType: '学生证',
    idNumber: 'TEST-ID-NOT-REAL',
    identityId,
    consent: true
  };
  await author.ok('/api/applications/film', 'PUT', { payload, submit: false });
  filmApplication = (await author.ok('/api/applications/film', 'PUT', { payload, submit: true }))
    .application.id;
  const request = {
    competition: 'film',
    title: '测试影像',
    author: '创作者',
    description: '自动化测试素材',
    videoId,
    submissionKey: 'film-idempotency-1'
  };
  filmWork = (await author.ok('/api/works', 'POST', request)).work.id;
  assert.equal((await author.ok('/api/works', 'POST', request)).work.id, filmWork);
  const guest = new Client();
  assert.equal((await guest.request(`/api/media/${videoId}`)).status, 403);
  assert.equal((await guest.request(`/api/media/${identityId}`)).status, 403);
  assert.equal(
    (await admin.request(`/api/admin/works/${filmWork}/review`, 'POST', { status: 'approved' }))
      .status,
    400
  );
  await admin.ok(`/api/admin/applications/${filmApplication}/review`, 'POST', {
    status: 'approved'
  });
  await admin.ok(`/api/admin/works/${filmWork}/review`, 'POST', { status: 'approved' });
  const wall = await guest.ok('/api/works?competition=film');
  assert.equal(wall.items.length, 1);
  assert.ok(!JSON.stringify(wall).includes('13800000000'));
  assert.ok(!JSON.stringify(wall).includes('TEST-ID'));
  assert.deepEqual(
    Object.keys(wall.items[0]).sort(),
    [
      'id',
      'competition',
      'title',
      'author',
      'description',
      'votes',
      'videoUrl',
      'judgeScore',
      'networkScore',
      'finalScore'
    ].sort()
  );
  assert.equal((await guest.request(`/api/media/${videoId}`)).status, 200);
  assert.equal((await guest.request(`/api/media/${identityId}`)).status, 403);
});
test('concurrent repeats create one vote, and invalid or out-of-range scores are rejected', async () => {
  const results = await Promise.all(
    Array.from({ length: 12 }, () => outsider.request(`/api/votes/${filmWork}`, 'POST'))
  );
  assert.ok(results.every((r) => r.status === 200));
  const row = (await platform.db.query('SELECT votes FROM works WHERE id=$1', [filmWork])).rows[0];
  assert.equal(row.votes, 1);
  assert.equal(
    Number(
      (await platform.db.query('SELECT COUNT(*) AS n FROM votes WHERE work_id=$1', [filmWork]))
        .rows[0].n
    ),
    1
  );
  for (const score of ['not-a-number', '', -1, 101])
    assert.equal(
      (await admin.request(`/api/admin/works/${filmWork}/score`, 'POST', { score })).status,
      400
    );
  await admin.ok(`/api/admin/works/${filmWork}/score`, 'POST', { score: 90 });
  const wall = await outsider.ok('/api/works?competition=film');
  assert.equal(wall.items[0].finalScore, 94);
});
test('cancelled competition rejects all old entry points and retained records stay inactive', async () => {
  const guest = new Client();
  assert.equal(
    (await author.request('/api/applications/creator', 'PUT', { payload: {}, submit: false }))
      .status,
    400
  );
  assert.equal(
    (await author.request('/api/works', 'POST', { competition: 'creator' })).status,
    400
  );
  for (const url of [
    '/api/works?competition=creator',
    '/api/admin/applications?competition=creator',
    '/api/admin/works?competition=creator',
    '/api/admin/export?competition=creator',
    '/api/admin/export/works?competition=creator'
  ])
    assert.equal((await admin.request(url)).status, 400);
  assert.equal((await admin.request('/api/admin/checkin', 'POST', { code: 'old' })).status, 404);
  const oldAuthor = await participant('RetainedHistory');
  const userId = (await oldAuthor.ok('/api/session')).user.id;
  const applicationId = crypto.randomUUID(),
    approvedId = crypto.randomUUID(),
    rejectedId = crypto.randomUUID(),
    now = Date.now();
  await platform.db.query(
    'INSERT INTO applications(id,user_id,competition,payload,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [applicationId, userId, 'creator', '{}', 'pending', now, now]
  );
  const oldVideo = await upload(oldAuthor, 'video');
  for (const [id, status] of [
    [approvedId, 'approved'],
    [rejectedId, 'rejected']
  ])
    await platform.db.query(
      'INSERT INTO works(id,user_id,competition,title,author,description,video_id,status,created_at,updated_at,submission_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        id,
        userId,
        'creator',
        '历史作品',
        '历史作者',
        '',
        id === approvedId ? oldVideo : null,
        status,
        now,
        now,
        id
      ]
    );
  assert.equal(
    (
      await admin.request('/api/admin/applications/' + applicationId + '/review', 'POST', {
        status: 'approved'
      })
    ).status,
    400
  );
  assert.equal(
    (await oldAuthor.request('/api/me/applications/' + applicationId + '/qr')).status,
    404
  );
  assert.equal(
    (
      await admin.request('/api/admin/works/' + approvedId + '/review', 'POST', {
        status: 'rejected',
        note: 'test'
      })
    ).status,
    400
  );
  assert.equal(
    (await admin.request('/api/admin/works/' + approvedId + '/score', 'POST', { score: 90 }))
      .status,
    400
  );
  assert.equal(
    (await oldAuthor.request('/api/works/' + rejectedId, 'PUT', { title: 'test', author: 'test' }))
      .status,
    400
  );
  assert.equal(
    (
      await oldAuthor.request('/api/works', 'POST', {
        competition: 'film',
        title: 'test',
        author: 'test',
        submissionKey: approvedId
      })
    ).status,
    400
  );
  assert.equal((await author.request('/api/votes/' + approvedId, 'POST')).status, 400);
  assert.equal((await guest.request('/api/media/' + oldVideo)).status, 403);
  const me = await oldAuthor.ok('/api/me');
  assert.deepEqual(me.applications, []);
  assert.deepEqual(me.works, []);
  assert.deepEqual(me.votes, []);
  const overview = await admin.ok('/api/admin/overview');
  for (const row of [...overview.applications, ...overview.works])
    assert.equal(row.competition, 'film');
  assert.ok(!(await guest.ok('/api/works')).items.some((row) => row.id === approvedId));
  assert.ok(
    !(await admin.ok('/api/admin/applications')).items.some((row) => row.id === applicationId)
  );
  assert.ok(!(await admin.ok('/api/admin/works')).items.some((row) => row.id === approvedId));
  assert.ok(!(await admin.ok('/api/admin/export')).includes(applicationId));
  assert.ok(!(await admin.ok('/api/admin/export/works')).includes(approvedId));
  assert.equal(
    (await platform.db.query('SELECT id FROM applications WHERE id=$1', [applicationId])).rows
      .length,
    1
  );
  assert.equal(
    (await platform.db.query('SELECT status FROM works WHERE id=$1', [approvedId])).rows[0].status,
    'approved'
  );
  assert.equal(
    (await platform.db.query('SELECT COUNT(*) AS n FROM votes WHERE work_id=$1', [approvedId]))
      .rows[0].n,
    0
  );
});

test('public configuration exposes only film and registration deadline closes applications', async () => {
  const guest = new Client(),
    config = await guest.ok('/api/config');
  assert.equal(config.siteName, '前湾印象城MEGA');
  assert.deepEqual(config.competitions, ['film']);
  assert.deepEqual(Object.keys(config.rules), ['film']);
  const deadline = platform.config.deadlines.registration;
  platform.config.deadlines.registration = '2020-01-01T00:00:00+08:00';
  try {
    const response = await (
      await participant('ClosedRegistration')
    ).request('/api/applications/film', 'PUT', { payload: {}, submit: false });
    assert.equal(response.status, 400);
    assert.match(response.data.error, /截止/);
  } finally {
    platform.config.deadlines.registration = deadline;
  }
});

test('reviewer and judge roles cannot cross permissions or access private identity material', async () => {
  for (const role of ['judge', 'reviewer'])
    await admin.ok('/api/admin/staff', 'POST', {
      username: `test_${role}`,
      nickname: role,
      role,
      password: 'test-role-password-2026'
    });
  const judge = new Client();
  await judge.ok('/api/auth/admin', 'POST', {
    username: 'test_judge',
    password: 'test-role-password-2026'
  });
  assert.equal((await judge.request('/api/admin/applications')).status, 403);
  assert.equal((await judge.request(`/api/media/${identityId}`)).status, 403);
  assert.equal(
    (await judge.request(`/api/admin/works/${filmWork}/review`, 'POST', { status: 'approved' }))
      .status,
    403
  );
  await judge.ok(`/api/admin/works/${filmWork}/score`, 'POST', { score: 80 });
  const wall = await judge.ok('/api/works?competition=film');
  assert.equal(wall.items[0].judgeScore, 85);
  const reviewer = new Client();
  await reviewer.ok('/api/auth/admin', 'POST', {
    username: 'test_reviewer',
    password: 'test-role-password-2026'
  });
  assert.equal(
    (await reviewer.request(`/api/admin/works/${filmWork}/score`, 'POST', { score: 100 })).status,
    403
  );
  assert.equal((await reviewer.request(`/api/media/${identityId}`)).status, 200);
});
test('closing voting prevents new votes and rejects files with deceptive extensions', async () => {
  await admin.ok('/api/admin/settings', 'PUT', {
    registrationOpen: true,
    votingOpen: false
  });
  assert.equal((await author.request(`/api/votes/${filmWork}`, 'POST')).status, 400);
  const item = await task(author, 'video', Buffer.alloc(32, 65));
  await sendPart(author, item, 0, Buffer.alloc(32, 65));
  assert.equal((await author.request(`/api/uploads/${item.id}/complete`, 'POST')).status, 400);
});
test('production refuses to start with missing resources and preview defaults', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./lib/config')"], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: '',
      REDIS_URL: '',
      WECHAT_APPID: '',
      WECHAT_SECRET: '',
      STORAGE_DRIVER: 'local'
    },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /禁止以预览配置启动/);
});

test('upload pause preserves resumability and concurrent reservations respect per-user limits', async () => {
  const client = await participant('UploadGateFixture');
  const buffer = bytes('video', 256),
    item = await task(client, 'video', buffer);
  await admin.ok('/api/admin/storage', 'PUT', { uploadsOpen: false });
  try {
    assert.equal((await task(client, 'video', buffer)).id, item.id);
    assert.equal(
      (
        await client.request('/api/uploads', 'POST', {
          kind: 'video',
          filename: 'new.mp4',
          size: 128,
          fingerprint: 'new-fingerprint'
        })
      ).status,
      503
    );
    await sendPart(client, item, 0, buffer);
    await client.ok(`/api/uploads/${item.id}/complete`, 'POST');
    const summary = await admin.ok('/api/admin/storage');
    assert.equal(summary.uploadsOpen, false);
    assert.ok(summary.readyBytes >= buffer.length);
    assert.equal(summary.retention.automaticDeletion, false);
  } finally {
    await admin.ok('/api/admin/storage', 'PUT', { uploadsOpen: true });
  }
  const old = platform.config.uploadQuotaCount;
  platform.config.uploadQuotaCount = 1;
  try {
    const limited = await participant('UploadQuotaFixture');
    const results = await Promise.all(
      [1, 2].map((n) =>
        limited.request('/api/uploads', 'POST', {
          kind: 'video',
          filename: `${n}.mp4`,
          size: 128,
          fingerprint: `quota-${n}`
        })
      )
    );
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 400).length, 1);
  } finally {
    platform.config.uploadQuotaCount = old;
  }
});

test('WeChat OAuth and QR login bind the browser, require confirmation, expire and resist replay', async (t) => {
  const QRCode = require('qrcode');
  const originalQR = QRCode.toDataURL.bind(QRCode),
    originalFetch = globalThis.fetch;
  const old = { appid: platform.config.wechatAppId, secret: platform.config.wechatSecret };
  platform.config.wechatAppId = 'wx-test-app';
  platform.config.wechatSecret = 'test-only-secret';
  let ticket,
    providerCalls = 0;
  t.mock.method(QRCode, 'toDataURL', async (...args) => {
    const url = new URL(args[0]);
    assert.equal(url.origin, origin);
    ticket = new URLSearchParams(url.hash.slice(1)).get('ticket');
    return originalQR(...args);
  });
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.hostname !== 'api.weixin.qq.com') return originalFetch(input, options);
    providerCalls++;
    if (url.pathname === '/sns/oauth2/access_token')
      return Response.json({ openid: 'test-openid', access_token: 'test-access-token' });
    assert.equal(url.pathname, '/sns/userinfo');
    return Response.json({
      openid: 'test-openid',
      nickname: '微信测试用户',
      headimgurl: 'http://thirdwx.qlogo.cn/test/avatar'
    });
  });
  try {
    const browser = new Client(),
      phone = new Client(),
      guest = new Client();
    assert.equal((await guest.request('/api/auth/wechat?returnTo=wall')).status, 404);
    assert.equal((await phone.request('/api/auth/wechat/prepare', 'POST', {})).status, 400);
    assert.equal(
      (await phone.request('/api/auth/wechat/prepare', 'POST', { ticket: 'invalid' })).status,
      400
    );
    const retired = new Client(),
      legacyState = 'retired-direct-oauth-state';
    retired.cookie = `oauth_state=${legacyState}`;
    await platform.db.query(
      'INSERT INTO wechat_oauth_states(state_hash,scan_hash,destination,expires_at) VALUES($1,$2,$3,$4)',
      [
        crypto.createHash('sha256').update(legacyState).digest('hex'),
        null,
        'account',
        Date.now() + 60000
      ]
    );
    assert.equal(
      (
        await retired.request(`/api/auth/wechat/callback?state=${legacyState}&code=test-code`)
      ).headers.get('location'),
      '/wechat-login.html#error=authorization'
    );
    assert.equal((await retired.ok('/api/session')).user, null);
    assert.equal(providerCalls, 0);
    const qr = await browser.ok('/api/auth/qr', 'POST', { returnTo: 'wall' });
    assert.match(qr.qrImage, /^data:image\/png;base64,/);
    assert.equal((await guest.request(`/api/auth/qr/${qr.id}`)).status, 404);
    assert.equal((await browser.request(`/api/auth/qr/${qr.id}/complete`, 'POST')).status, 409);
    const prepared = await phone.ok('/api/auth/wechat/prepare', 'POST', { ticket });
    const state = new URL(prepared.url).searchParams.get('state');
    const replay = new Client();
    replay.cookie = phone.cookie;
    const mismatch = await phone.request(`/api/auth/wechat/callback?state=wrong&code=test-code`);
    assert.equal(mismatch.headers.get('location'), '/wechat-login.html#error=authorization');
    const callback = await phone.request(`/api/auth/wechat/callback?state=${state}&code=test-code`);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), `/wechat-login.html#ticket=${ticket}`);
    assert.equal(
      (await replay.request(`/api/auth/wechat/callback?state=${state}&code=test-code`)).headers.get(
        'location'
      ),
      '/wechat-login.html#error=expired'
    );
    assert.equal(providerCalls, 2);
    const user = (await phone.ok('/api/session')).user;
    assert.equal(user.nickname, '微信测试用户');
    assert.match(user.avatar, /^https:/);
    await phone.ok('/api/auth/qr/scan', 'POST', { ticket });
    assert.equal((await browser.ok(`/api/auth/qr/${qr.id}`)).status, 'scanned');
    assert.equal((await browser.request(`/api/auth/qr/${qr.id}/complete`, 'POST')).status, 409);
    await phone.ok('/api/auth/qr/decision', 'POST', { ticket, decision: 'approve' });
    const complete = await Promise.all([
      browser.request(`/api/auth/qr/${qr.id}/complete`, 'POST'),
      browser.request(`/api/auth/qr/${qr.id}/complete`, 'POST')
    ]);
    assert.equal(complete.filter((r) => r.status === 200).length, 1);
    assert.equal(complete.find((r) => r.status === 200).data.destination, 'wall');
    assert.equal((await browser.ok('/api/session')).user.id, user.id);
    const renewed = await browser.ok('/api/auth/qr', 'POST', {});
    await phone.ok('/api/auth/qr/scan', 'POST', { ticket });
    await phone.ok('/api/auth/qr/decision', 'POST', { ticket, decision: 'reject' });
    assert.equal((await browser.ok(`/api/auth/qr/${renewed.id}`)).status, 'rejected');
    assert.equal(
      (await browser.request(`/api/auth/qr/${renewed.id}/complete`, 'POST')).status,
      409
    );
    const expired = await browser.ok('/api/auth/qr', 'POST', {});
    await platform.db.query('UPDATE qr_logins SET expires_at=$1 WHERE id=$2', [
      Date.now() - 1,
      expired.id
    ]);
    assert.equal((await browser.ok(`/api/auth/qr/${expired.id}`)).status, 'expired');
    assert.equal((await phone.request('/api/auth/qr/scan', 'POST', { ticket })).status, 410);
    assert.equal(
      (await browser.request(`/api/auth/qr/${expired.id}/complete`, 'POST')).status,
      410
    );
  } finally {
    platform.config.wechatAppId = old.appid;
    platform.config.wechatSecret = old.secret;
  }
});

test('domain verification serves only expected text files and health endpoints stay available', async () => {
  await fs.mkdir(platform.config.verificationDir, { recursive: true });
  await fs.writeFile(
    path.join(platform.config.verificationDir, 'MP_verify_Test123.txt'),
    'test-verification-token'
  );
  await fs.writeFile(path.join(platform.config.verificationDir, 'secret.txt'), 'private-fixture');
  const guest = new Client();
  const verified = await guest.ok('/MP_verify_Test123.txt');
  assert.equal(verified, 'test-verification-token');
  assert.equal((await guest.request('/secret.txt')).status, 404);
  assert.equal((await guest.request('/.env')).status, 404);
  assert.equal((await guest.request('/MP_verify_missing.txt')).status, 404);
  assert.equal((await guest.ok('/api/ready')).ok, true);
  assert.equal((await guest.ok('/api/health')).ok, true);
  assert.equal(
    (await platform.db.query('SELECT COUNT(*) AS count FROM schema_migrations')).rows[0].count,
    1
  );
});
