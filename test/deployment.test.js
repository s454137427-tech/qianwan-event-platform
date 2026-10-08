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
