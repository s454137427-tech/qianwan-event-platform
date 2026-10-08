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
  t.mock.method(COS.prototype, 'headObject', (options, callback) =>
    callback(null, { headers: { 'content-length': '12', etag: '"etag"' } })
  );
  const storage = await createStorage(config);
  await assert.rejects(storage.complete(task), /大小不一致/);
  t.mock.method(COS.prototype, 'headObject', (options, callback) =>
    callback(null, { headers: { 'content-length': '128', etag: '"etag"' } })
  );
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
