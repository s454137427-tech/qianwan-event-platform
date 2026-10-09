'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// Explicit allowlist: previews, historical source, credentials and real data never enter a release.
const files = [
  'server.js',
  'lib',
  'web',
  'scripts/setup.js',
  'scripts/check-source.js',
  'scripts/check-deployment.js',
  'scripts/prepare-deployment.js',
  'scripts/package-release.js',
  'test/platform.test.js',
  'test/deployment.test.js',
  'test/storage.test.js',
  'package.json',
  'pnpm-lock.yaml',
  '.prettierrc.json',
  '.env.example',
  '.gitignore',
  '.gitattributes',
  '.github/workflows/ci.yml',
  '.dockerignore',
  'Dockerfile',
  'README.md',
  '启动预览.cmd',
  'deploy/compose.yaml',
  'deploy/.env.production.example',
  'deploy/nginx.conf.template',
  'deploy/接入与验收.md'
];

async function packageRelease() {
  const root = path.resolve(__dirname, '..');
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const directory = path.join(root, 'releases');
  await fs.mkdir(directory, { recursive: true });
  const output = path.join(directory, `qianwan-events-${version}.tar.gz`);
  const result = spawnSync('tar', ['-czf', output, '-C', root, ...files], { encoding: 'utf8' });
  if (result.error || result.status !== 0)
    throw new Error('打包失败，请确认系统已安装 tar：' + (result.error?.code || result.stderr));
  const digest = crypto
    .createHash('sha256')
    .update(await fs.readFile(output))
    .digest('hex');
  await fs.writeFile(output + '.sha256', `${digest}  ${path.basename(output)}\n`);
  console.log(`部署包：${output}\n已生成 SHA256 校验文件；不包含密钥、账号数据或历史审阅包。`);
}

if (require.main === module)
  packageRelease().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { files, packageRelease };
