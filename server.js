'use strict';
const createPlatform = (...args) => require('./lib/platform').createPlatform(...args);
async function start() {
  const platform = await createPlatform();
  const server = platform.app.listen(platform.config.port, platform.config.host);
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (error) {
    await platform.close();
    throw error;
  }
  console.log(
    `前湾印象城MEGA：${platform.config.origin}\n后台：${platform.config.origin}/admin.html\n模式：${platform.config.production ? '正式环境' : '本地预览'}`
  );
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => process.exit(1), 15000);
    timer.unref();
    server.close(async () => {
      try {
        await platform.close();
      } catch {
        console.error('资源关闭失败，请检查服务日志');
        process.exitCode = 1;
      } finally {
        clearTimeout(timer);
      }
    });
    server.closeIdleConnections();
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
if (require.main === module)
  start().catch((e) => {
    console.error(
      '启动失败：',
      e.code === 'EADDRINUSE' ? '端口已被占用，请关闭旧服务或修改 PORT' : e.code || e.message
    );
    process.exitCode = 1;
  });
module.exports = { createPlatform };
