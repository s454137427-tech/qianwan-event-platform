'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTosUploader } = require('../web/tos-upload');
const task = { id: 'fixture-task', chunkSize: 5 * 1024 ** 2 };
const file = new File([new Uint8Array(task.chunkSize * 2 + 128)], 'fixture.mp4');
function fixture(hook = async () => {}) {
  const saved = new Map(),
    parts = new Map(),
    requests = [],
    clients = [];
  let clock = Date.now(),
    grants = 0,
    confirmations = 0,
    inits = 0;
  const storage = {
    getItem: (key) => saved.get(key),
    setItem: (key, value) => saved.set(key, value),
    removeItem: (key) => saved.delete(key)
  };
  const info = () => ({
    accessKeyId: 'temporary-' + grants,
    accessKeySecret: 'temporary-secret',
    stsToken: 'token-' + grants,
    expiration: new Date(clock + 1800000).toISOString(),
    region: 'cn-beijing',
    bucket: 'fixture-bucket',
    endpoint: 'media.gynnai.com',
    key: 'private/user/task.mp4'
  });
  const api = async (url, options) => {
    if (url.endsWith('/complete')) {
      confirmations++;
      await hook('confirm', {});
      return { ok: true };
    }
    assert.ok(options.signal);
    grants++;
    await hook('credentials', {});
    return info();
  };
  const SDK = {
    createUploadClient(options, signal) {
      assert.equal(options.isCustomDomain, true);
      assert.equal(options.secure, true);
      assert.equal(options.endpoint, 'media.gynnai.com');
      assert.equal(options.maxRetryCount, 2);
      clients.push({ options, signal });
      async function request(method, args) {
        requests.push({ method, args, token: options.stsToken });
        await hook(method, args);
        if (method === 'createMultipartUpload') {
          inits++;
          assert.equal(args.acl, 'private');
          return { data: { UploadId: 'upload-id' } };
        }
        if (method === 'listParts')
          return {
            data: {
              Parts: [...parts].map(([n, p]) => ({ PartNumber: n, ETag: p.etag, Size: p.size })),
              IsTruncated: false
            }
          };
        if (method === 'uploadPart') {
          const etag = '"abcdef' + args.partNumber + '"';
          parts.set(args.partNumber, { etag, size: args.body.size });
          return { data: { ETag: etag } };
        }
        assert.equal(args.parts.length, 3);
        assert.deepEqual(
          args.parts.map((p) => p.partNumber),
          [1, 2, 3]
        );
        return { data: { ETag: '"completed"' } };
      }
      return Object.fromEntries(
        ['createMultipartUpload', 'listParts', 'uploadPart', 'completeMultipartUpload'].map(
          (method) => [method, (args) => request(method, args)]
        )
      );
    }
  };
  return {
    saved,
    parts,
    requests,
    clients,
    SDK,
    api,
    storage,
    info,
    advance(ms) {
      clock += ms;
    },
    get grants() {
      return grants;
    },
    get confirmations() {
      return confirmations;
    },
    get inits() {
      return inits;
    },
    uploader() {
      return createTosUploader({
        api,
        storage,
        loadSdk: async () => SDK,
        now: () => clock,
        sleep: async () => {}
      });
    }
  };
}
test('TOS pause preserves checkpoints and a fresh page reconciles saved parts instead of uploading them twice', async () => {
  const controller = new AbortController();
  let stopped = false;
  const f = fixture();
  await assert.rejects(
    f.uploader().upload(task, file, {
      signal: controller.signal,
      progress(percent) {
        if (percent > 0 && !stopped) {
          stopped = true;
          controller.abort();
        }
      }
    }),
    /已暂停/
  );
  assert.ok(f.saved.size);
  const before = new Set(f.parts.keys());
  assert.ok(before.size > 0);
  const index = f.requests.length;
  await f.uploader().upload(task, file, { signal: new AbortController().signal, progress() {} });
  assert.equal(f.inits, 1);
  assert.ok(f.requests.slice(index).some((r) => r.method === 'listParts'));
  assert.ok(
    f.requests
      .slice(index)
      .filter((r) => r.method === 'uploadPart')
      .every((r) => !before.has(r.args.partNumber))
  );
  assert.ok(!/accessKey|stsToken|temporary-secret|"body"/.test([...f.saved.values()].join('')));
  f.uploader().clear(task);
  assert.equal(f.saved.size, 0);
});
test('TOS refreshes expiring credentials before signing a part, and retries a server-rejected expired token', async () => {
  let expired = false;
  const f = fixture(async (method) => {
    if (method === 'uploadPart' && !expired) {
      expired = true;
      throw Object.assign(new Error('expired'), { code: 'ExpiredToken', statusCode: 403 });
    }
  });
  await f.uploader().upload(task, file, { signal: new AbortController().signal, progress() {} });
  assert.ok(f.grants >= 2);
  assert.equal(f.parts.size, 3);
  const g = fixture(async (method) => {
    if (method === 'createMultipartUpload') g.advance(1750000);
  });
  await g.uploader().upload(task, file, { signal: new AbortController().signal, progress() {} });
  assert.ok(g.grants >= 2);
  assert.ok(
    g.requests.filter((r) => r.method === 'uploadPart').every((r) => r.token !== 'token-1')
  );
});
test('TOS restores from server parts after a transient failure and stops after bounded retries or access denial', async () => {
  let failed = false;
  const f = fixture(async (method, args) => {
    if (method === 'uploadPart' && args.partNumber === 2 && !failed) {
      failed = true;
      throw Object.assign(new Error('network'), { statusCode: 503 });
    }
  });
  await f.uploader().upload(task, file, { signal: new AbortController().signal, progress() {} });
  assert.equal(f.inits, 1);
  assert.equal(f.parts.size, 3);
  assert.ok(f.requests.some((r) => r.method === 'listParts'));
  for (const statusCode of [403, 503]) {
    const g = fixture(async (method) => {
      if (method === 'createMultipartUpload')
        throw Object.assign(new Error('failed'), { statusCode });
    });
    await assert.rejects(
      g.uploader().upload(task, file, { signal: new AbortController().signal, progress() {} }),
      /上传中断/
    );
    assert.equal(g.requests.length, statusCode === 403 ? 1 : 4);
  }
});
test('TOS lost merge response is confirmed before restarting a NoSuchUpload checkpoint', async () => {
  let completed = false;
  const f = fixture(async (method) => {
    if (method === 'completeMultipartUpload' && !completed) {
      completed = true;
      throw Object.assign(new Error('lost response'), { statusCode: 503 });
    }
    if (method === 'listParts')
      throw Object.assign(new Error('gone'), { statusCode: 404, code: 'NoSuchUpload' });
  });
  await f.uploader().upload(task, file, { signal: new AbortController().signal, progress() {} });
  assert.equal(f.confirmations, 1);
  assert.equal(f.inits, 1);
});
test('TOS cancelled credential or SDK loading promises end promptly without starting multipart upload', async () => {
  for (const stage of ['sdk', 'credentials']) {
    const controller = new AbortController();
    let started;
    const ready = new Promise((r) => {
      started = r;
    });
    const f = fixture();
    const hold = async () => {
      started();
      return new Promise(() => {});
    };
    const uploader = createTosUploader({
      api: stage === 'credentials' ? hold : f.api,
      storage: f.storage,
      loadSdk: stage === 'sdk' ? hold : async () => f.SDK
    });
    const uploading = uploader.upload(task, file, { signal: controller.signal, progress() {} });
    await ready;
    controller.abort();
    await assert.rejects(uploading, /已暂停/);
    assert.equal(f.requests.length, 0);
  }
});
test('rebuilt official browser SDK signs actual multipart requests for HTTPS CNAME and aborts its XHR transport', async () => {
  const vm = require('node:vm');
  const { browserSdk } = require('../lib/browser-sdk');
  const received = [];
  let hold = false,
    last;
  class XHR {
    upload = { addEventListener() {} };
    onloadend = null;
    headers = {};
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    }
    getAllResponseHeaders() {
      return 'content-type: application/json\r\netag: "abcdef"\r\nx-tos-request-id: fixture\r\n';
    }
    addEventListener() {}
    removeEventListener() {}
    send() {
      last = this;
      received.push(this);
      if (hold) return;
      this.status = 200;
      this.responseText = JSON.stringify(
        this.url.includes('uploads')
          ? { UploadId: 'sdk-upload', Bucket: 'fixture', Key: 'private/test.mp4' }
          : { ETag: '"abcdef"' }
      );
      this.response = this.responseText;
      this.readyState = 4;
      queueMicrotask(() => this.onloadend?.());
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
  }
  const context = vm.createContext({
    XMLHttpRequest: XHR,
    navigator: { userAgent: 'Mozilla/5.0' },
    location: { protocol: 'https:' },
    setTimeout,
    clearTimeout,
    console,
    Blob,
    File,
    FormData,
    AbortController,
    URL,
    URLSearchParams
  });
  context.window = context;
  context.self = context;
  vm.runInContext(await browserSdk(), context, { filename: 'tos-browser-sdk.js' });
  const controller = new AbortController();
  const options = {
    accessKeyId: 'temporary',
    accessKeySecret: 'fixture-secret',
    stsToken: 'fixture-token',
    region: 'cn-beijing',
    bucket: 'fixture',
    endpoint: 'media.gynnai.com',
    isCustomDomain: true,
    secure: true,
    enableCRC: false,
    maxRetryCount: 0
  };
  const client = context.TOS.createUploadClient(options, controller.signal);
  const init = await client.createMultipartUpload({ key: 'private/test.mp4', acl: 'private' });
  assert.equal(init.data.UploadId, 'sdk-upload');
  await client.uploadPart({
    key: 'private/test.mp4',
    uploadId: 'sdk-upload',
    partNumber: 1,
    body: new Blob(['fixture'])
  });
  await client.completeMultipartUpload({
    key: 'private/test.mp4',
    uploadId: 'sdk-upload',
    parts: [{ partNumber: 1, eTag: '"abcdef"' }]
  });
  assert.equal(received.length, 3);
  for (const request of received) {
    assert.match(request.url, /^https:\/\/media\.gynnai\.com\//);
    assert.match(
      request.headers.authorization,
      /TOS4-HMAC-SHA256 Credential=temporary\/\d{8}\/cn-beijing\/tos\/request/
    );
    assert.equal(request.headers['x-tos-security-token'], 'fixture-token');
  }
  assert.equal(received[0].headers['x-tos-acl'], 'private');
  hold = true;
  const pending = client.uploadPart({
    key: 'private/test.mp4',
    uploadId: 'sdk-upload',
    partNumber: 2,
    body: new Blob(['fixture'])
  });
  await new Promise((r) => setImmediate(r));
  controller.abort();
  await assert.rejects(pending);
  assert.equal(last.aborted, true);
});
