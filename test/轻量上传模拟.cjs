'use strict';
// A local-only control-plane simulation, not a 50 GB upload or COS load test.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

process.env.ADMIN_PASSWORD = 'isolated-upload-simulation-only';
const { createPlatform } = require('../server');
const defaults = require('../lib/config');
const MiB = 1024 ** 2;
const USER_COUNT = 100;
const report = {
  mode: 'local-lightweight-simulation',
  users: USER_COUNT,
  cloudRequests: 0,
  fullVideoUploads: 0,
  checks: [],
  actualUploadedBytes: 0
};
let origin,
  server,
  platform,
  directory,
  guard,
  peakRss = process.memoryUsage().rss;
const started = performance.now();
const maxMs = 60000;
let aborted;
function checkResources() {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  if (peakRss > 256 * MiB || performance.now() - started > maxMs) {
    aborted = new Error('Simulation resource or time limit reached');
    server?.closeAllConnections();
  }
  if (aborted) throw aborted;
}
class Client {
  constructor(index) {
    this.ip = `192.0.2.${index + 1}`;
    this.cookie = '';
    this.csrf = '';
  }
  async request(url, method = 'GET', body) {
    checkResources();
    const headers = { 'X-Forwarded-For': this.ip, Cookie: this.cookie, Origin: origin };
    if (this.csrf) headers['X-CSRF-Token'] = this.csrf;
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const before = performance.now();
    const response = await fetch(origin + url, {
      method,
      body,
      headers,
      signal: AbortSignal.timeout(15000)
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) this.cookie = cookies.map((c) => c.split(';')[0]).join('; ');
    const data = await response.json();
    if (data.csrf) this.csrf = data.csrf;
    checkResources();
    return { status: response.status, data, milliseconds: performance.now() - before };
  }
  async ok(url, method, body) {
    const r = await this.request(url, method, body);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r;
  }
}
async function mapLimited(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    })
  );
}
async function diskBytes(root) {
  let total = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const name = path.join(root, entry.name);
    total += entry.isDirectory() ? await diskBytes(name) : (await fs.stat(name)).size;
  }
  return total;
}
async function main() {
  const video = path.resolve(__dirname, '../测试视频/上传测试-500MB.mp4');
  const videoSize = (await fs.stat(video)).size;
  assert.equal(videoSize, 500 * MiB);
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qianwan-upload-lite-'));
  const config = {
    ...defaults,
    production: false,
    devLogin: true,
    dataDir: directory,
    verificationDir: path.join(directory, 'verification'),
    databaseUrl: '',
    redisUrl: '',
    storage: 'local',
    cos: { SecretId: '', SecretKey: '', Bucket: '', Region: '' },
    wechatAppId: '',
    wechatSecret: '',
    cdn: { origin: '', key: '', confirmed: false },
    videoLimit: videoSize,
    chunkSize: 5 * MiB,
    uploadCapacityBytes: USER_COUNT * videoSize,
    trustProxy: 1,
    deadlines: { creator: '', creatorWork: '', film: '', vote: '' }
  };
  platform = await createPlatform(config);
  server = platform.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  config.origin = origin;
  guard = setInterval(() => {
    try {
      checkResources();
    } catch {
      /* requests observe the guard */
    }
  }, 100);
  const clients = Array.from({ length: USER_COUNT + 1 }, (_, i) => new Client(i));
  await mapLimited(clients, 4, (c) =>
    c.ok('/api/auth/dev', 'POST', { alias: `UploadLite_${c.ip.replaceAll('.', '_')}` })
  );
  report.checks.push({ name: '101 independent local test sessions', passed: true });
  const taskBody = {
    kind: 'video',
    filename: 'upload-test-500MB.mp4',
    mime: 'video/mp4',
    size: videoSize,
    fingerprint: crypto
      .createHash('sha256')
      .update(`${path.basename(video)}:${videoSize}`)
      .digest('hex')
  };
  const burstStart = performance.now();
  const created = await Promise.all(
    clients.slice(0, USER_COUNT).map((c) => c.ok('/api/uploads', 'POST', taskBody))
  );
  report.taskBurstSeconds = Number(((performance.now() - burstStart) / 1000).toFixed(3));
  const durations = created.map((r) => r.milliseconds).sort((a, b) => a - b);
  report.taskLatencyMs = {
    p50: Math.round(durations[49]),
    p95: Math.round(durations[94]),
    maximum: Math.round(durations[99])
  };
  assert.equal(new Set(created.map((r) => r.data.id)).size, USER_COUNT);
  assert.ok(created.every((r) => r.data.totalChunks === 100 && r.data.chunkSize === 5 * MiB));
  const totals = (await platform.db.query('SELECT COUNT(*) AS n,SUM(size) AS bytes FROM uploads'))
    .rows[0];
  assert.equal(Number(totals.n), USER_COUNT);
  assert.equal(Number(totals.bytes), USER_COUNT * videoSize);
  report.virtualReservedBytes = Number(totals.bytes);
  report.checks.push({
    name: '100 simultaneous 500 MiB task requests: distinct owners, exact reservation, 100 chunks each',
    passed: true
  });
  const extra = await clients[USER_COUNT].request('/api/uploads', 'POST', taskBody);
  assert.equal(extra.status, 503);
  report.checks.push({
    name: '101st task rejected at the configured global capacity',
    passed: true
  });
  const tooLarge = await clients[0].request('/api/uploads', 'POST', {
    ...taskBody,
    size: videoSize + 1,
    fingerprint: 'over-limit'
  });
  assert.equal(tooLarge.status, 400);
  report.checks.push({ name: '500 MiB plus 1 byte rejected', passed: true });
  const stranger = await clients[1].request(`/api/uploads/${created[0].data.id}`);
  assert.equal(stranger.status, 400);
  report.checks.push({ name: 'another user cannot inspect an upload task', passed: true });
  const handle = await fs.open(video, 'r');
  try {
    const buffer = Buffer.alloc(5 * MiB);
    for (let user = 0; user < 2; user++) {
      for (const index of [0, 99]) {
        const read = await handle.read(buffer, 0, buffer.length, index * buffer.length);
        assert.equal(read.bytesRead, buffer.length);
        const part = new FormData();
        part.append('chunk', new Blob([buffer]), 'part');
        await clients[user].ok(
          `/api/uploads/${created[user].data.id}/chunks/${index}`,
          'POST',
          part
        );
        report.actualUploadedBytes += buffer.length;
      }
      const restored = await clients[user].ok('/api/uploads', 'POST', taskBody);
      assert.equal(restored.data.id, created[user].data.id);
      assert.deepEqual(restored.data.parts, [0, 99]);
      const incomplete = await clients[user].request(
        `/api/uploads/${created[user].data.id}/complete`,
        'POST'
      );
      assert.equal(incomplete.status, 400);
    }
  } finally {
    await handle.close();
  }
  report.checks.push({
    name: 'actual first/last chunks of the 500 MiB MP4 accepted for 2 users',
    passed: true
  });
  report.checks.push({
    name: 'resume returns the same task and received chunks [0,99]',
    passed: true
  });
  report.checks.push({ name: 'incomplete videos cannot be marked ready', passed: true });
  report.temporaryDiskBytes = await diskBytes(directory);
  report.status = 'passed';
}
(async () => {
  try {
    await main();
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    if (guard) clearInterval(guard);
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (platform) await platform.close();
    const resolved = directory && path.resolve(directory);
    if (
      resolved &&
      path.dirname(resolved) === path.resolve(os.tmpdir()) &&
      path.basename(resolved).startsWith('qianwan-upload-lite-')
    ) {
      await fs.rm(resolved, { recursive: true, force: true });
      report.temporaryDataRemoved = true;
    }
    report.peakProcessRssMiB = Number(
      (Math.max(peakRss, process.memoryUsage().rss) / MiB).toFixed(1)
    );
    report.elapsedSeconds = Number(((performance.now() - started) / 1000).toFixed(2));
    report.limits = [
      'Local SQLite simulation only; no COS, PostgreSQL, Redis or production HTTP path tested.',
      'Only 2 users sent 4 real 5 MiB chunks sequentially; 100 complete videos were not sent.',
      'Local response timing is not a production capacity or internet bandwidth measurement.'
    ];
    const output = path.resolve(__dirname, '../测试视频/100人轻量模拟结果.json');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  }
})();
