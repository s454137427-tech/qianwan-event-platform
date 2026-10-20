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

test('production TOS preflight accepts only the supported private-domain configuration and rejects legacy CDN', () => {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    STORAGE_DRIVER: 'tos',
    APP_ORIGIN: 'https://mega.gynnai.com',
    DATABASE_URL: 'postgresql://fixture:fixture@postgres:5432/event',
    REDIS_URL: 'redis://:fixture@redis:6379',
    DATABASE_SSL: 'false',
    TOS_ACCESS_KEY_ID: 'fixture-id',
    TOS_ACCESS_KEY_SECRET: 'fixture-secret',
    TOS_BUCKET: 'fixture-bucket',
    TOS_REGION: 'cn-beijing',
    TOS_ENDPOINT: 'tos-cn-beijing.volces.com',
    TOS_PUBLIC_ORIGIN: 'https://media.gynnai.com',
    TOS_UPLOAD_ROLE_TRN: 'trn:iam::2000012345:role/uploader',
    WECHAT_APPID: 'fixture-appid',
    WECHAT_SECRET: 'fixture-wechat-secret',
    ADMIN_PASSWORD: 'fixture-password-123456',
    ORGANIZER_NAME: '测试',
    CONTACT_TEXT: '测试',
    PRIVACY_NOTICE: '测试',
    RULES_CONFIRMED: 'true',
    ALLOW_DEV_LOGIN: 'false',
    VIDEO_CDN_ORIGIN: '',
    VIDEO_CDN_AUTH_KEY: '',
    VIDEO_CDN_AUTH_CONFIRMED: 'false'
  };
  const run = (overrides) =>
    spawnSync(process.execPath, ['scripts/check-deployment.js'], {
      cwd: root,
      env: { ...env, ...overrides },
      encoding: 'utf8'
    });
  const good = run({});
  assert.equal(good.status, 0, good.stderr);
  const result = JSON.parse(good.stdout);
  assert.equal(result.scope, 'configuration-only');
  assert.equal(result.storage, 'tos');
  assert.equal(result.cdn, false);
  for (const overrides of [
    { STORAGE_DRIVER: 'cos' },
    { STORAGE_DRIVER: 'local' },
    { TOS_ACCESS_KEY_ID: '' },
    { TOS_PUBLIC_ORIGIN: 'http://media.test.cn' },
    { TOS_PUBLIC_ORIGIN: 'https://bucket.oss-cn-hangzhou.aliyuncs.com' },
    { TOS_PUBLIC_ORIGIN: 'https://127.0.0.1' },
    { TOS_PUBLIC_ORIGIN: 'https://media.test.cn/path' },
    { TOS_PUBLIC_ORIGIN: 'https://mega.gynnai.com' },
    { TOS_REGION: 'ap-shanghai' },
    { TOS_UPLOAD_ROLE_TRN: '*' },
    { TOS_ENDPOINT: '' },
    { TOS_ENDPOINT: 'tos-s3-cn-beijing.volces.com' },
    { TOS_ENDPOINT: 'tos-cn-shanghai.volces.com' },
    { STORAGE_DRIVER: 'oss' },
    {
      VIDEO_CDN_ORIGIN: 'https://cdn.test.cn',
      VIDEO_CDN_AUTH_KEY: 'fixture-key',
      VIDEO_CDN_AUTH_CONFIRMED: 'true'
    },
    { ALLOW_DEV_LOGIN: 'true' }
  ]) {
    const bad = run(overrides);
    assert.notEqual(bad.status, 0);
    assert.ok(!bad.stderr.includes('fixture-secret'));
    assert.ok(!bad.stdout.includes('fixture-secret'));
  }
});

// 手机号+密码登录界面的行为测试：元素必须存在于页面，校验在前端先拦一道。
function accountLoginElements(html) {
  return new Map(
    [...html.matchAll(/id="([^"]+)"/g)].map((m) => [
      m[1],
      {
        hidden: true,
        open: false,
        disabled: false,
        textContent: '',
        value: '',
        attributes: {},
        listeners: {},
        classList: {
          toggled: [],
          toggle(name, on) {
            this.toggled.push([name, on]);
          }
        },
        addEventListener(name, callback) {
          this.listeners[name] = callback;
        },
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        getAttribute(name) {
          return this.attributes[name];
        },
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
          this.listeners.close?.();
        },
        focus() {}
      }
    ])
  );
}

function runAccountLogin(responses) {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'web/account-login-ui.js'), 'utf8');
  const elements = accountLoginElements(html);
  const calls = [];
  const context = vm.createContext({
    document: {
      getElementById: (id) => {
        assert.ok(elements.has(id), `Unknown page element ${id}`);
        return elements.get(id);
      }
    },
    window: {},
    AbortSignal,
    Date,
    JSON,
    encodeURIComponent,
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) });
      const next = responses.shift();
      if (!next) throw new Error('Unexpected request: ' + url);
      return next;
    }
  });
  vm.runInContext(source, context);
  return { elements, calls, api: context.window.eventAccountLogin };
}

test('account login dialog switches tabs and blocks invalid input before any request', async () => {
  const { elements, calls, api } = runAccountLogin([]);
  api.open({ onSuccess() {} });
  assert.equal(elements.get('loginDialog').open, true);
  assert.equal(elements.get('loginTitle').textContent, '手机号登录');
  assert.equal(elements.get('loginSubmit').textContent, '登录 ↗');
  assert.equal(elements.get('loginConfirmRow').hidden, true);
  assert.equal(elements.get('loginTabLogin').getAttribute('aria-selected'), 'true');
  assert.equal(elements.get('loginTabRegister').getAttribute('aria-selected'), 'false');

  elements.get('loginTabRegister').listeners.click();
  assert.equal(elements.get('loginTitle').textContent, '注册参赛账号');
  assert.equal(elements.get('loginSubmit').textContent, '注册并登录 ↗');
  assert.equal(elements.get('loginConfirmRow').hidden, false);
  assert.equal(elements.get('loginTabRegister').getAttribute('aria-selected'), 'true');

  const submit = elements.get('accountLoginForm').listeners.submit;
  await submit({ preventDefault() {} });
  assert.equal(calls.length, 0);
  assert.match(elements.get('loginHint').textContent, /11位手机号/);

  elements.get('loginPhone').value = '13800138000';
  elements.get('loginPassword').value = 'abc';
  await submit({ preventDefault() {} });
  assert.equal(calls.length, 0);
  assert.match(elements.get('loginHint').textContent, /至少需要6位/);

  elements.get('loginPassword').value = 'abc123';
  elements.get('loginConfirm').value = 'abc124';
  await submit({ preventDefault() {} });
  assert.equal(calls.length, 0);
  assert.match(elements.get('loginHint').textContent, /两次输入的密码不一致/);

  elements.get('loginTabLogin').listeners.click();
  assert.equal(elements.get('loginConfirmRow').hidden, true);
  assert.equal(elements.get('loginTitle').textContent, '手机号登录');
  assert.equal(elements.get('loginPhone').value, '13800138000');
});

test('account login posts to the matching endpoint and falls back to login when the phone exists', async () => {
  const { elements, calls, api } = runAccountLogin([
    { ok: false, status: 409, json: async () => ({ error: '该手机号已注册，请直接登录' }) },
    { ok: true, status: 200, json: async () => ({ ok: true, user: { id: 'u1' }, csrf: 'c1' }) }
  ]);
  const successes = [];
  api.open({ onSuccess: (data) => successes.push(data) });
  elements.get('loginTabRegister').listeners.click();
  elements.get('loginPhone').value = '13800138000';
  elements.get('loginPassword').value = 'abc123';
  elements.get('loginConfirm').value = 'abc123';
  const submit = elements.get('accountLoginForm').listeners.submit;

  await submit({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/auth/register');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { phone: '13800138000', password: 'abc123' });
  // 已注册时回到登录页签，保留手机号，不关闭弹窗。
  assert.equal(elements.get('loginSubmit').textContent, '登录 ↗');
  assert.equal(elements.get('loginConfirmRow').hidden, true);
  assert.equal(elements.get('loginPhone').value, '13800138000');
  assert.match(elements.get('loginHint').textContent, /已注册/);
  assert.equal(elements.get('loginDialog').open, true);
  assert.equal(successes.length, 0);

  elements.get('loginPassword').value = 'abc123';
  await submit({ preventDefault() {} });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/api/auth/login');
  assert.deepEqual(calls[1].body, { phone: '13800138000', password: 'abc123' });
  assert.equal(successes.length, 1);
  assert.equal(successes[0].csrf, 'c1');
  assert.equal(elements.get('loginDialog').open, false);
  assert.equal(elements.get('loginPassword').value, '');
});
