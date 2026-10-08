'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

async function setup() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 及以上');
  const root = path.resolve(__dirname, '..');
  for (const [source, destination] of [
    ['.env.example', '.env'],
    ['deploy/.env.production.example', 'deploy/.env.production']
  ]) {
    try {
      await fs.copyFile(
        path.join(root, source),
        path.join(root, destination),
        fs.constants.COPYFILE_EXCL
      );
      await fs.chmod(path.join(root, destination), 0o600);
      console.log(`已创建 ${destination}`);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      console.log(`已保留现有 ${destination}`);
    }
  }
  for (const folder of ['deploy/certs', 'deploy/wechat-verification']) {
    await fs.mkdir(path.join(root, folder), { recursive: true });
  }
  console.log('本地配置已就绪。运行 pnpm start，或双击“启动预览.cmd”。');
  console.log('正式配置保存在 deploy/.env.production，稍后填写域名、微信和云资源。');
}

if (require.main === module)
  setup().catch((error) => {
    console.error('初始化失败：', error.code || error.message);
    process.exitCode = 1;
  });
module.exports = { setup };
