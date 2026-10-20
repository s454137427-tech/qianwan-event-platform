'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TosClient: TOS } = require('@volcengine/tos-sdk');
const { STSClient } = require('@volcengine/sts');
const defaults = require('../lib/config');
const { createPlatform } = require('../server');
test('TOS HTTP flow enforces ownership, CSRF, private material, publication and immutable submitted copies', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qianwan-tos-test-'));
  const objects = new Map();
  let copies = 0,
    grants = 0;
  t.mock.method(TOS.prototype, '_fetchObject', async (options, method, query, headers) => {
    const object = objects.get(options.key);
    if (method === 'HEAD') {
      if (!object)
        throw Object.assign(new Error('missing'), { statusCode: 404, code: 'NoSuchKey' });
      return {
        data: {
          'content-length': String(object.content.length),
          etag: object.etag,
          'content-type': object.mime
        }
      };
    }
    if (method === 'GET') {
      assert.equal(headers['if-match'], object.etag);
      return { data: object.content.subarray(0, 64), headers: {} };
    }
    const source = objects.get(options.srcKey);
    copies++;
    assert.equal(options.copySourceIfMatch, source.etag);
    objects.set(options.key, {
      content: Buffer.from(source.content),
      etag: source.etag,
      mime: options.contentType
    });
    return { data: { ETag: source.etag } };
  });
  t.mock.method(STSClient.prototype, 'send', async (command) => {
    grants++;
    const policy = JSON.parse(command.input.Policy);
    assert.equal(policy.Statement[0].Resource.length, 1);
    assert.ok(!policy.Statement[0].Resource[0].includes('protected/'));
    return {
      Result: {
        Credentials: {
          AccessKeyId: 'temporary',
          SecretAccessKey: 'temporary-secret',
          SessionToken: 'token',
          ExpiredTime: new Date(Date.now() + 1800000).toISOString()
        }
      }
    };
  });
  const password = 'test-only-admin-password-2026';
  const oldPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = password;
  let platform, server, origin;
  function client() {
    let cookie = '',
      csrf = '';
    const request = async (url, method = 'GET', body, custom = {}) => {
      const response = await fetch(origin + url, {
        method,
        redirect: 'manual',
        headers: {
          Cookie: cookie,
          'X-CSRF-Token': csrf,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...custom
        },
        body: body ? JSON.stringify(body) : undefined
      });
      if (response.headers.getSetCookie().length)
        cookie = response.headers
          .getSetCookie()
          .map((s) => s.split(';')[0])
          .join('; ');
      const data = await response.text();
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        json = data;
      }
      if (json.csrf) csrf = json.csrf;
      return { status: response.status, data: json, headers: response.headers };
    };
    return {
      request,
      async ok(...args) {
        const r = await request(...args);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        return r.data;
      }
    };
  }
  try {
    const config = {
      ...defaults,
      production: false,
      storage: 'tos',
      devLogin: true,
      databaseUrl: '',
      redisUrl: '',
      dataDir: dir,
      tos: {
        accessKeyId: 'fixture-id',
        accessKeySecret: 'fixture-secret',
        bucket: 'qianwan-fixture',
        region: 'cn-beijing',
        endpoint: 'tos-cn-beijing.volces.com',
        roleTrn: 'trn:iam::2000012345:role/upload',
        publicOrigin: 'https://media.test.cn'
      }
    };
    platform = await createPlatform(config);
    server = platform.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    config.origin = origin = `http://127.0.0.1:${server.address().port}`;
    const author = client(),
      outsider = client(),
      guest = client(),
      admin = client();
    await author.ok('/api/auth/dev', 'POST', { alias: 'TosAuthor' });
    await outsider.ok('/api/auth/dev', 'POST', { alias: 'TosOutsider' });
    await admin.ok('/api/auth/admin', 'POST', { username: 'admin', password });
    const page = await guest.request('/');
    assert.match(
      page.headers.get('content-security-policy'),
      /connect-src 'self' https:\/\/media\.test\.cn;/
    );
    assert.ok(!page.headers.get('content-security-policy').includes('tencent'));
    assert.equal((await guest.request('/vendor/tos.js')).status, 200);
    assert.equal((await guest.request('/vendor/cos.js')).status, 404);
    async function upload(kind) {
      const item = await author.ok('/api/uploads', 'POST', {
        kind,
        filename: kind === 'video' ? 'fixture.mp4' : 'fixture.png',
        size: 128,
        fingerprint: 'fixture-' + kind
      });
      assert.equal(item.driver, 'tos');
      assert.equal(
        (await guest.request(`/api/uploads/${item.id}/credentials`, 'POST')).status,
        401
      );
      assert.equal(
        (await outsider.request(`/api/uploads/${item.id}/credentials`, 'POST')).status,
        400
      );
      assert.equal(
        (await outsider.request(`/api/uploads/${item.id}/complete`, 'POST')).status,
        400
      );
      assert.equal(
        (
          await author.request(
            `/api/uploads/${item.id}/credentials`,
            'POST',
            {},
            { 'X-CSRF-Token': '' }
          )
        ).status,
        403
      );
      const response = await author.request(`/api/uploads/${item.id}/credentials`, 'POST');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      const info = response.data;
      assert.equal(info.accessKeyId, 'temporary');
      assert.ok(!JSON.stringify(info).includes('fixture-secret'));
      const content = Buffer.alloc(128, 1);
      if (kind === 'video') content.write('ftypisom', 4);
      else Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(content);
      objects.set(info.key, { content, etag: '"fixture-etag"' });
      await Promise.all([
        author.ok(`/api/uploads/${item.id}/complete`, 'POST'),
        author.ok(`/api/uploads/${item.id}/complete`, 'POST')
      ]);
      assert.equal(
        (await author.request(`/api/uploads/${item.id}/credentials`, 'POST')).status,
        400
      );
      const stored = (await platform.db.query('SELECT * FROM uploads WHERE id=$1', [item.id]))
        .rows[0];
      assert.match(stored.object_key, /^protected\//);
      // Old upload credentials may still mutate staging; submitted bytes stay frozen.
      objects.get(info.key).content = Buffer.alloc(128);
      assert.deepEqual(objects.get(stored.object_key).content, content);
      await author.ok(`/api/uploads/${item.id}/complete`, 'POST');
      return item.id;
    }
    const videoId = await upload('video'),
      identityId = await upload('identity');
    assert.equal(copies, 2);
    assert.equal(grants, 2);
    assert.equal((await guest.request(`/api/media/${videoId}`)).status, 403);
    assert.equal((await guest.request(`/api/media/${identityId}`)).status, 403);
    assert.equal((await outsider.request(`/api/media/${videoId}`)).status, 403);

    const ownMedia = await author.request(`/api/media/${videoId}`);
    assert.equal(ownMedia.status, 302);
    assert.equal(ownMedia.headers.get('cache-control'), 'private, no-store');
    const url = new URL(ownMedia.headers.get('location'));
    assert.equal(url.origin, 'https://media.test.cn');
    assert.equal(url.searchParams.get('X-Tos-Expires'), '600');
    assert.equal(url.searchParams.get('X-Tos-Algorithm'), 'TOS4-HMAC-SHA256');
    const application = await author.ok('/api/applications/film', 'PUT', {
      submit: true,
      payload: {
        realName: '测试',
        phone: '13800000000',
        idType: '学生证',
        idNumber: 'FIXTURE',
        identityId,
        consent: true
      }
    });
    const work = await author.ok('/api/works', 'POST', {
      competition: 'film',
      title: '测试',
      author: '测试',
      description: '测试',
      theme: '未来生活想象',
      aiTools: '测试工具',
      creationProcess: '生成后剪辑',
      videoId,
      submissionKey: 'tos-fixture-work'
    });
    await admin.ok(`/api/admin/applications/${application.application.id}/review`, 'POST', {
      status: 'approved'
    });
    await admin.ok(`/api/admin/works/${work.work.id}/review`, 'POST', { status: 'approved' });
    assert.equal((await guest.request(`/api/media/${videoId}`)).status, 302);
    assert.equal((await guest.request(`/api/media/${identityId}`)).status, 403);
    for (const role of ['judge', 'reviewer']) {
      await admin.ok('/api/admin/staff', 'POST', {
        username: 'tos_' + role,
        nickname: role,
        role,
        password
      });
      const staff = client();
      await staff.ok('/api/auth/admin', 'POST', { username: 'tos_' + role, password });
      assert.equal(
        (await staff.request(`/api/media/${identityId}`)).status,
        role === 'judge' ? 403 : 302
      );
    }
    await admin.ok(`/api/admin/works/${work.work.id}/review`, 'POST', {
      status: 'rejected',
      note: '测试下架'
    });

    assert.equal((await guest.request(`/api/media/${videoId}`)).status, 403);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    await platform?.close();
    if (oldPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = oldPassword;
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('qianwan-tos-test-'));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
