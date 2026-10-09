'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { renderGateway } = require('../scripts/prepare-deployment');
const root = path.resolve(__dirname, '..');

test('deployment gateway uses one domain and rejects unsafe or placeholder origins', () => {
  const template = fs.readFileSync(path.join(root, 'deploy/nginx.conf.template'), 'utf8');
  const result = renderGateway('https://competition.test.cn', template);
  assert.ok(!result.includes('event.example.com'));
  assert.match(result, /server_name competition\.test\.cn;/);
  assert.match(result, /return 301 https:\/\/competition\.test\.cn\$request_uri;/);
  for (const origin of [
    'https://event.example.com',
    'http://test.cn',
    'https://test.cn:4430',
    'https://test.cn/path',
    'https://user:password@test.cn',
    'https://test.cn?arg=1',
    'garbage'
  ])
    assert.throws(() => renderGateway(origin, template));
});

test('invalid connection configuration fails without exposing secrets', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "try { require('./lib/config'); } catch (error) { console.error(error.message); process.exit(1); }"
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        DATABASE_URL: 'not-a-url-secret-fixture',
        REDIS_URL: '',
        WECHAT_APPID: '',
        WECHAT_SECRET: ''
      }
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL/);
  assert.ok(!result.stderr.includes('secret-fixture'));
});

test('release allowlist excludes credentials, operational data and review copies', () => {
  const { files } = require('../scripts/package-release');
  for (const name of files) {
    assert.ok(fs.existsSync(path.join(root, name)), `Missing release input: ${name}`);
    assert.ok(
      !/^(?:var|data|public|legacy|review-package|client-review|_publish_work|node_modules)(?:\/|$)/.test(
        name
      )
    );
    assert.ok(!/\.env(?:\.production)?$/.test(name));
  }
  for (const name of ['server.js', 'lib', 'web', 'Dockerfile', 'deploy/compose.yaml'])
    assert.ok(files.includes(name));
});

test('login dialog offers one QR flow for both desktop and WeChat, and ignores closed requests', async () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'web/wechat-login-ui.js'), 'utf8');
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  for (const userAgent of ['Desktop Browser', 'iPhone MicroMessenger']) {
    const elements = new Map(
      [...html.matchAll(/id="([^"]+)"/g)].map((m) => [
        m[1],
        {
          hidden: true,
          open: false,
          textContent: '',
          listeners: {},
          addEventListener(name, callback) {
            this.listeners[name] = callback;
          },
          showModal() {
            this.open = true;
          },
          close() {
            this.open = false;
            this.listeners.close?.();
          }
        }
      ])
    );
    const calls = [],
      timers = new Set();
    let resolveRequest;
    const context = vm.createContext({
      document: {
        hidden: false,
        getElementById: (id) => {
          assert.ok(elements.has(id), `Unknown page element ${id}`);
          return elements.get(id);
        }
      },
      window: {},
      navigator: { userAgent },
      AbortSignal,
      Date,
      setTimeout: (fn) => {
        timers.add(fn);
        return fn;
      },
      setInterval: (fn) => {
        timers.add(fn);
        return fn;
      },
      clearTimeout: (fn) => timers.delete(fn),
      clearInterval: (fn) => timers.delete(fn),
      fetch: (url) => {
        calls.push(url);
        return new Promise((resolve) => {
          resolveRequest = resolve;
        });
      }
    });
    vm.runInContext(source, context);
    context.window.eventWechatLogin.open({ config: { wechat: false }, onSuccess() {} });
    assert.deepEqual(calls, []);
    assert.equal(elements.get('loginQrEmpty').textContent, '扫码登录暂未开放');
    elements.get('loginDialog').close();
    context.window.eventWechatLogin.open({
      config: { wechat: true },
      returnTo: 'wall',
      onSuccess() {}
    });
    assert.deepEqual(calls, ['/api/auth/qr']);
    resolveRequest({
      ok: true,
      json: async () => ({
        id: 'test-qr',
        qrImage: 'data:image/png;base64,test',
        displayCode: '123456',
        expiresAt: Date.now() + 300000
      })
    });
    await flush();
    assert.equal(elements.get('loginQrImage').hidden, false);
    assert.equal(elements.get('loginQrCode').textContent, '123456');
    assert.equal(elements.get('loginQrDeviceNote').hidden, userAgent === 'Desktop Browser');
    elements.get('loginDialog').close();
    assert.equal(timers.size, 0);
    context.window.eventWechatLogin.open({ config: { wechat: true }, onSuccess() {} });
    await flush();
    elements.get('loginDialog').close();
    resolveRequest({
      ok: true,
      json: async () => ({
        id: 'stale-qr',
        qrImage: 'data:image/png;base64,stale',
        displayCode: '999999',
        expiresAt: Date.now() + 300000
      })
    });
    await flush();
    assert.equal(elements.get('loginQrImage').hidden, true);
    assert.equal(timers.size, 0);
    assert.ok(calls.every((url) => url === '/api/auth/qr'));
  }
});
