'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : /\.(?:js|mjs)$/.test(entry.name) ? [target] : [];
  });
}

const files = [
  path.join(root, 'server.js'),
  ...['lib', 'scripts', 'test', 'web'].flatMap((folder) => walk(path.join(root, folder)))
];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    console.error(result.stderr || result.error.message);
    process.exit(1);
  }
}
console.log(`代码检查通过：${files.length} 个 JavaScript 文件。`);
