'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const COS = require('cos-nodejs-sdk-v5');
const STS = require('qcloud-cos-sts');
const { createStorage, cdnUrl } = require('../lib/storage');
const config = {
  dataDir: '.',
  storage: 'cos',
  cos: {
    SecretId: 'test-id',
    SecretKey: 'test-key',
    Bucket: 'test-1234567890',
    Region: 'ap-shanghai'
  }
};
const task = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  kind: 'video',
  filename: 'fixture.mp4',
  size: 128,
  object_key:
    'private/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111.mp4'
};

test('COS completion freezes one ETag-checked protected copy for concurrent requests', async (t) => {
  const header = Buffer.alloc(64);
  header.write('ftypisom', 4);
  let copies = 0;
  t.mock.method(COS.prototype, 'headObject', (options, callback) =>
    callback(null, { headers: { 'content-length': '128', etag: '"test-etag"' } })
  );
  t.mock.method(COS.prototype, 'getObject', (options, callback) => {
    assert.equal(options.IfMatch, '"test-etag"');
    assert.equal(options.Range, 'bytes=0-63');
    callback(null, { Body: header });
  });
  t.mock.method(COS.prototype, 'putObjectCopy', (options, callback) => {
    copies++;
    assert.equal(options.CopySourceIfMatch, '"test-etag"');
    assert.match(options.Key, /^protected\//);
    assert.equal(options.ContentType, 'video/mp4');
    callback(null, {});
  });
  const storage = await createStorage(config);
  const results = await Promise.all([storage.complete(task), storage.complete(task)]);
  assert.equal(copies, 1);
  assert.deepEqual(results[0], results[1]);
  assert.match(results[0].objectKey, /^protected\//);
});

test('COS rejects mismatched size and propagates conditional copy failures', async (t) => {
  let size = '12';
  t.mock.method(COS.prototype, 'headObject', (options, callback) =>
    callback(null, { headers: { 'content-length': size, etag: '"etag"' } })
  );
  const storage = await createStorage(config);
  await assert.rejects(storage.complete(task), /大小不一致/);
  size = '128';
  const header = Buffer.alloc(64);
  header.write('ftypisom', 4);
  t.mock.method(COS.prototype, 'getObject', (options, callback) =>
    callback(null, { Body: header })
  );
  t.mock.method(COS.prototype, 'putObjectCopy', (options, callback) =>
    callback(Object.assign(new Error('source changed'), { code: 'PreconditionFailed' }))
  );
  await assert.rejects(storage.complete(task), { code: 'PreconditionFailed' });
});

test('STS upload policy is restricted to the task staging object', async (t) => {
  t.mock.method(STS, 'getCredential', (options, callback) => {
    const policy = options.policy.statement[0];
    assert.deepEqual(policy.resource, [
      `qcs::cos:ap-shanghai:uid/1234567890:test-1234567890/${task.object_key}`
    ]);
    assert.ok(policy.action.includes('name/cos:UploadPart'));
    assert.ok(
      policy.action.every((action) => !/GetObject|DeleteObject|PutObjectCopy/.test(action))
    );
    assert.equal(options.durationSeconds, 1800);
    callback(null, { credentials: { tmpSecretId: 'temporary-test-id' }, expiredTime: 1234567890 });
  });
  const storage = await createStorage(config),
    result = await storage.credentials(task);
  assert.equal(result.Key, task.object_key);
  assert.equal(result.Bucket, config.cos.Bucket);
});

test('the upgraded Node COS SDK signs HTTP requests and parses copy results', async () => {
  const http = require('node:http');
  const received = [];
  const server = http.createServer((req, res) => {
    received.push(req.headers);
    assert.match(req.headers.authorization, /q-sign-algorithm=sha1/);
    if (req.method === 'HEAD')
      return res.writeHead(200, { 'Content-Length': '128', ETag: '"fixture-etag"' }).end();
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(
      '<CopyObjectResult><ETag>"copied-etag"</ETag><LastModified>2026-10-09T00:00:00Z</LastModified></CopyObjectResult>'
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const cos = new COS({
      SecretId: 'fixture-id',
      SecretKey: 'fixture-key',
      Domain: `127.0.0.1:${server.address().port}`,
      Protocol: 'http:',
      Timeout: 2000
    });
    const call = (method, options) =>
      new Promise((resolve, reject) =>
        cos[method](
          {
            Bucket: config.cos.Bucket,
            Region: config.cos.Region,
            Key: task.object_key,
            ...options
          },
          (error, result) => (error ? reject(error) : resolve(result))
        )
      );
    const head = await call('headObject', {});
    assert.equal(head.headers.etag, '"fixture-etag"');
    assert.equal(Number(head.headers['content-length']), 128);
    const copy = await call('putObjectCopy', {
      CopySource: `${config.cos.Bucket}.cos.ap-shanghai.myqcloud.com/${task.object_key}`,
      CopySourceIfMatch: head.headers.etag
    });
    assert.equal(copy.ETag, '"copied-etag"');
    assert.equal(received[1]['x-cos-copy-source-if-match'], '"fixture-etag"');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('CDN signature applies only to protected video objects', () => {
  const key = task.object_key.replace('private/', 'protected/');
  const cdn = { origin: 'https://video.test.cn', key: 'TestOnlyKey123' };
  const url = new URL(cdnUrl(cdn, key));
  const [timestamp, random, userId, signature] = url.searchParams.get('sign').split('-');
  assert.equal(userId, '0');
  assert.equal(url.pathname, '/' + key);
  assert.equal(
    signature,
    crypto
      .createHash('md5')
      .update(`${url.pathname}-${timestamp}-${random}-${userId}-${cdn.key}`)
      .digest('hex')
  );
  assert.throws(() => cdnUrl(cdn, task.object_key));
  assert.throws(() => cdnUrl(cdn, key.replace('.mp4', '.png')));
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
