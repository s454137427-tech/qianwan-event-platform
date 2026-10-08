'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

function renderGateway(origin, template) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('APP_ORIGIN 请填写正式 HTTPS 域名');
  }
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname) ||
    url.hostname.endsWith('.example.com')
  ) {
    throw new Error('APP_ORIGIN 需使用实际 HTTPS 域名，不带端口、路径或参数');
  }
  return template.replaceAll('event.example.com', url.hostname);
}

async function prepareDeployment() {
  if (process.env.NODE_ENV !== 'production')
    throw new Error('请加载 deploy/.env.production 正式配置');
  const root = path.resolve(__dirname, '..');
  const template = await fs.readFile(path.join(root, 'deploy/nginx.conf.template'), 'utf8');
  const gateway = renderGateway(process.env.APP_ORIGIN, template);
  const output = path.join(root, 'deploy/nginx.container.conf');
  await fs.writeFile(output, gateway);
  for (const folder of ['certs', 'wechat-verification'])
    await fs.mkdir(path.join(root, 'deploy', folder), { recursive: true });
  console.log('已从 APP_ORIGIN 生成 deploy/nginx.container.conf，域名无需重复修改。');
  console.log('请放置 TLS 证书：deploy/certs/fullchain.pem 与 privkey.pem。');
  console.log('微信域名验证文件放入 deploy/wechat-verification/。');
}

if (require.main === module)
  prepareDeployment().catch((error) => {
    console.error('部署准备失败：', error.code || error.message);
    process.exitCode = 1;
  });
module.exports = { renderGateway, prepareDeployment };
