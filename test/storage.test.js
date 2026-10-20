'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { TosClient } = require('@volcengine/tos-sdk');
const { STSClient, AssumeRoleCommand } = require('@volcengine/sts');
const { createStorage, uploadPolicy } = require('../lib/storage');
const { config, task } = require('./tos-storage-fixture.cjs');
function header() {
  const b = Buffer.alloc(64);
  b.write('ftypisom', 4);
  return b;
}
function head(size = 128, mime = 'video/mp4', etag = '"fixture-etag"') {
  return { data: { 'content-length': String(size), 'content-type': mime, etag } };
}
test('the SDK compatibility patch is applied to the production entrypoint and signs the region, not the endpoint', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const {TosClient}=require('@volcengine/tos-sdk');
    const c=new TosClient({accessKeyId:'fixture',accessKeySecret:'fixture',region:'cn-beijing',endpoint:'tos-cn-beijing.ivolces.com'});
    const u=new URL(c.getPreSignedUrl({bucket:'fixture',key:'a.mp4',alternativeEndpoint:'media.gynnai.com',isCustomDomain:true}));
    console.log(u.searchParams.get('X-Tos-Credential').split('/')[2]);
  `
    ],
    {
      cwd: require('node:path').resolve(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'production' },
      encoding: 'utf8'
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'cn-beijing');
});
test('TOS confirmation freezes one private conditional copy, rejects changed input, and supports 2 GiB', async (t) => {
  let copies = 0,
    size = 128,
    content = header(),
    missing = false,
    changed = false,
    badFrozen = false;
  t.mock.method(TosClient.prototype, '_fetchObject', async (o, method, query, headers) => {
    if (method === 'HEAD') {
      if (missing)
        throw Object.assign(new Error('missing'), { statusCode: 404, code: 'NoSuchKey' });
      return head(
        size,
        'video/mp4',
        badFrozen && o.key.startsWith('protected/') ? '"changed"' : '"fixture-etag"'
      );
    }
    if (method === 'GET') {
      assert.equal(headers.range, 'bytes=0-63');
      assert.equal(headers['if-match'], '"fixture-etag"');
      return { data: content, headers: {} };
    }
    copies++;
    assert.equal(o.srcKey, task.object_key);
    assert.match(o.key, /^protected\//);
    assert.equal(headers['x-tos-copy-source-if-match'], '"fixture-etag"');
    assert.equal(headers['x-tos-acl'], 'private');
    assert.equal(headers['x-tos-metadata-directive'], 'REPLACE');
    assert.equal(headers['content-type'], 'video/mp4');
    assert.equal(headers['cache-control'], 'private, no-store');
    if (changed)
      throw Object.assign(new Error('source changed'), {
        statusCode: 412,
        code: 'PreconditionFailed'
      });
    return { data: { ETag: '"fixture-etag"' } };
  });
  const storage = await createStorage(config);
  const result = await Promise.all([storage.complete(task), storage.complete(task)]);
  assert.equal(copies, 1);
  assert.deepEqual(result[0], result[1]);
  size = 2 * 1024 ** 3;
  assert.match((await storage.complete({ ...task, size })).objectKey, /^protected\//);
  assert.equal(copies, 2);
  size = 12;
  await assert.rejects(storage.complete(task), /大小不一致/);
  size = 128;
  content = Buffer.from('<html>bad</html>');
  await assert.rejects(storage.complete(task), /文件内容/);
  content = header();
  changed = true;
  await assert.rejects(storage.complete(task), { code: 'PreconditionFailed' });
  changed = false;
  badFrozen = true;
  await assert.rejects(storage.complete(task), /确认未完成/);
  missing = true;
  await assert.rejects(storage.complete(task), { status: 404 });
});
test('Volcengine AssumeRole command intersects upload role with one exact object and denies public ACL writes', async (t) => {
  t.mock.method(STSClient.prototype, 'send', async function (command) {
    assert.ok(command instanceof AssumeRoleCommand);
    assert.equal(this.config.host, 'sts.cn-beijing.volcengineapi.com');
    const o = command.input;
    assert.equal(o.RoleTrn, config.tos.roleTrn);
    assert.equal(o.DurationSeconds, 1800);
    const p = JSON.parse(o.Policy);
    assert.deepEqual(p.Statement[0], {
      Effect: 'Allow',
      Action: ['tos:PutObject', 'tos:ListMultipartUploadParts', 'tos:AbortMultipartUpload'],
      Resource: ['trn:tos:::qianwan-test/' + task.object_key]
    });
    assert.ok(!p.Statement[0].Action.some((a) => /Get|ListBucket|Acl/.test(a)));
    // 火山 STS 不识别 x-tos-acl 条件键，任何 Condition 都会导致 HTTP 400，策略必须只有一条 Allow。
    assert.equal(p.Statement.length, 1);
    assert.equal(p.Statement[0].Effect, 'Allow');
    assert.ok(!p.Statement[0].Action.includes('tos:PutObjectAcl'));
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
  const s = await createStorage(config),
    r = await s.credentials(task);
  assert.equal(r.endpoint, 'media.gynnai.com');
  assert.equal(r.key, task.object_key);
  assert.equal(r.accessKeyId, 'temporary');
  assert.ok(!JSON.stringify(r).includes('fixture-secret'));
  assert.throws(() =>
    uploadPolicy(config.tos.bucket, task.object_key.replace('private/', 'protected/'))
  );
});
test('TOS signed playback uses actual HTTPS CNAME, Host-bound V4 signature and 600-second lifetime', async () => {
  const s = await createStorage({
    ...config,
    tos: { ...config.tos, endpoint: 'tos-cn-beijing.ivolces.com' }
  });
  const t = { ...task, object_key: task.object_key.replace('private/', 'protected/') };
  const u = new URL(await s.signedUrl(t));
  assert.equal(u.origin, 'https://media.gynnai.com');
  assert.equal(u.pathname, '/' + t.object_key);
  assert.equal(u.searchParams.get('X-Tos-Algorithm'), 'TOS4-HMAC-SHA256');
  assert.equal(u.searchParams.get('X-Tos-Expires'), '600');
  assert.ok(u.searchParams.get('X-Tos-SignedHeaders').includes('host'));
  assert.equal(u.searchParams.get('response-content-disposition'), 'inline');
  assert.equal(u.searchParams.get('X-Tos-Credential').split('/')[2], config.tos.region);
  assert.ok(!u.href.includes('fixture-secret'));
  assert.equal(s.publishedVideoUrl(t), null);
  await assert.rejects(s.signedUrl(task), /尚未保护/);
});
test('real TOS Node SDK serializes V4, Range/If-Match and conditional private copy over a local HTTP fixture', async () => {
  const http = require('node:http'),
    received = [];
  const server = http.createServer((req, res) => {
    received.push(req);
    if (req.method === 'GET') {
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-63/128' });
      return res.end(header());
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ETag: '"copied"' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const c = new TosClient({
      ...config.tos,
      endpoint: '127.0.0.1:' + server.address().port,
      isCustomDomain: true,
      secure: false,
      enableCRC: false,
      maxRetryCount: 0
    });
    await c.getObjectV2({
      key: task.object_key,
      rangeStart: 0,
      rangeEnd: 63,
      ifMatch: '"etag"',
      dataType: 'buffer'
    });
    const r = await c.copyObject({
      key: 'protected/test.mp4',
      srcBucket: config.tos.bucket,
      srcKey: task.object_key,
      copySourceIfMatch: '"etag"',
      acl: 'private',
      contentType: 'video/mp4',
      metadataDirective: 'REPLACE',
      contentDisposition: 'inline',
      cacheControl: 'private, no-store'
    });
    assert.equal(r.data.ETag, '"copied"');
    assert.equal(received[0].headers.range, 'bytes=0-63');
    assert.equal(received[0].headers['if-match'], '"etag"');
    const h = received[1].headers;
    assert.match(h.authorization, /^TOS4-HMAC-SHA256 /);
    assert.equal(h['x-tos-copy-source-if-match'], '"etag"');
    assert.equal(h['x-tos-acl'], 'private');
    assert.equal(h['x-tos-metadata-directive'], 'REPLACE');
    assert.equal(h['content-type'], 'video/mp4');
    assert.equal(h['cache-control'], 'private, no-store');
    assert.ok(h['x-tos-copy-source'].includes('qianwan-test'));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('local finalization waits for in-flight parts, rejects late writes and removes failed temporary files', async (t) => {
  const fs = require('node:fs/promises'),
    os = require('node:os'),
    path = require('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qianwan-storage-test-'));
  const originalRename = fs.rename;
  const local = { ...config, storage: 'local', dataDir: directory, chunkSize: 128 };
  const storage = await createStorage(local);
  const buffer = Buffer.alloc(128, 1);
  buffer.write('ftypisom', 4);
  let release, entered;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const mock = t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination.endsWith('.part')) {
      entered();
      await held;
    }
    return originalRename(source, destination);
  });
  try {
    const write = storage.putPart(task, 0, buffer);
    await started;
    const complete = storage.complete(task);
    release();
    await write;
    assert.equal(await complete, 'video/mp4');
    assert.deepEqual(await fs.readFile(storage.location(task)), buffer);
    await assert.rejects(storage.putPart(task, 0, buffer), { status: 409 });
    mock.mock.restore();
    const other = { ...task, id: crypto.randomUUID() };
    const failure = t.mock.method(fs, 'rename', async () => {
      throw Object.assign(new Error('disk fixture'), { code: 'ENOSPC' });
    });
    await assert.rejects(storage.putPart(other, 0, buffer), { code: 'ENOSPC' });
    assert.deepEqual(await fs.readdir(path.dirname(storage.location(other))), []);
    failure.mock.restore();
    await storage.putPart(other, 0, buffer);
    assert.equal(await storage.complete(other), 'video/mp4');
  } finally {
    release();
    mock.mock.restore();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('qianwan-storage-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
