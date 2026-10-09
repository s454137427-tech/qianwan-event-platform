'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createLimiter } = require('../lib/security');

test('participant saves queue snapshots in order and send the most recently saved revision', async () => {
  const vm = require('node:vm'),
    fs = require('node:fs'),
    path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
  const elements = new Map(
    [...html.matchAll(/id="([^"]+)"/g)].map((m) => [
      m[1],
      {
        hidden: true,
        textContent: '',
        classList: { toggle() {} },
        addEventListener() {},
        querySelectorAll() {
          return [];
        }
      }
    ])
  );
  const calls = [],
    me = { applications: [], works: [], votes: [] };
  let resolveFirst;
  const context = vm.createContext({
    document: { getElementById: (id) => elements.get(id), querySelectorAll: () => [] },
    window: { addEventListener() {} },
    location: { hash: '#home' },
    FormData,
    AbortSignal,
    Date,
    setTimeout,
    clearTimeout,
    fetch: async (url, options) => {
      if (url === '/api/config') return new Promise(() => {});
      if (url === '/api/me') return { ok: true, json: async () => me };
      const body = JSON.parse(options.body);
      calls.push(body);
      if (calls.length === 1)
        await new Promise((resolve) => {
          resolveFirst = resolve;
        });
      const application = {
        id: 'draft-fixture',
        competition: 'film',
        status: 'draft',
        updated_at: 100 + calls.length,
        payload: body.payload
      };
      me.applications = [application];
      return { ok: true, json: async () => ({ application }) };
    }
  });
  vm.runInContext(source, context);
  vm.runInContext(
    "state.user = { id: 'fixture-user' }; state.me = { applications: [], works: [], votes: [] };",
    context
  );
  const first = vm.runInContext(
    "saveApplication(false, true, { event: 'film', payload: { realName: 'first' } })",
    context
  );
  const second = vm.runInContext(
    "saveApplication(false, true, { event: 'film', payload: { realName: 'second' } })",
    context
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].revision, null);
  resolveFirst();
  await Promise.all([first, second]);
  assert.deepEqual(
    calls.map((body) => body.payload.realName),
    ['first', 'second']
  );
  assert.equal(calls[1].revision, 101);
  assert.equal(me.applications[0].payload.realName, 'second');
});

test(
  'a connected but unresponsive Redis times out, reconnects and closes without hanging',
  { timeout: 15000 },
  async () => {
    let stalled = false;
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      let pending = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length) {
          const end = pending.indexOf('\r\n');
          if (end < 0) return;
          const count = Number(pending.subarray(1, end).toString());
          let offset = end + 2;
          const args = [];
          for (let i = 0; i < count; i++) {
            const next = pending.indexOf('\r\n', offset);
            if (next < 0) return;
            const size = Number(pending.subarray(offset + 1, next).toString());
            if (pending.length < next + 2 + size + 2) return;
            args.push(pending.subarray(next + 2, next + 2 + size).toString());
            offset = next + 2 + size + 2;
          }
          pending = pending.subarray(offset);
          if (!stalled)
            socket.write(
              args[0] === 'PING' ? '+PONG\r\n' : args[0] === 'EVAL' ? ':1\r\n' : '+OK\r\n'
            );
        }
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    let limiter;
    try {
      limiter = await createLimiter({ redisUrl: `redis://127.0.0.1:${server.address().port}` });
      await limiter.ready();
      await limiter.check('test-fixture', 10, 60);
      stalled = true;
      const started = Date.now();
      await Promise.all([
        assert.rejects(limiter.ready()),
        assert.rejects(limiter.check('stalled-fixture', 10, 60))
      ]);
      assert.ok(Date.now() - started < 7000, 'Cache failures must not wait indefinitely');
      stalled = false;
      for (const socket of sockets) socket.destroy();
      const deadline = Date.now() + 3000;
      while (true) {
        try {
          await limiter.ready();
          break;
        } catch (error) {
          if (Date.now() > deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      await limiter.check('reconnected-fixture', 10, 60);
    } finally {
      await limiter?.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  }
);
