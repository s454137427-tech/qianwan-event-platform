'use strict';
// Configuration inspection only: does not connect, provision, purchase or mutate data.
try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要Node.js 24及以上');
  if (process.env.NODE_ENV !== 'production')
    throw new Error('此命令只检查正式环境，请加载deploy/.env.production');
  const required = [
    'APP_ORIGIN',
    'DATABASE_URL',
    'REDIS_URL',
    'COS_SECRET_ID',
    'COS_SECRET_KEY',
    'COS_BUCKET',
    'COS_REGION',
    'WECHAT_APPID',
    'WECHAT_SECRET',
    'ADMIN_PASSWORD',
    'ORGANIZER_NAME',
    'CONTACT_TEXT',
    'PRIVACY_NOTICE'
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error('待填写配置：' + missing.join('、'));
  const config = require('../lib/config');
  if (new URL(config.origin).hostname.endsWith('.example.com'))
    throw new Error('APP_ORIGIN 仍是示例域名，请填写正式子域名');
  const warnings = [];
  if (
    !config.databaseUrl.startsWith('postgresql://') &&
    !config.databaseUrl.startsWith('postgres://')
  )
    throw new Error('数据库必须使用PostgreSQL连接地址');
  if (!config.redisUrl.startsWith('redis://') && !config.redisUrl.startsWith('rediss://'))
    throw new Error('缓存必须使用Redis连接地址');
  if (!config.databaseSsl) warnings.push('数据库未启用TLS，请确认实际私有网络及连接策略');
  if (!config.cdn.origin) warnings.push('未配置视频CDN：生产播放容量仍需根据实际方案验收');
  if (Object.values(config.deadlines).some((value) => !value))
    warnings.push('仍有截止时间未填写，相关阶段不会自动按时间关闭');
  if (!config.eventEndAt) warnings.push('活动结束时间未确认：15天保留计划尚无具体清理日期');
  console.log(
    JSON.stringify(
      {
        ok: true,
        scope: 'configuration-only',
        storage: 'cos',
        database: 'postgresql',
        redis: 'configured',
        cdn: !!config.cdn.origin,
        applicationInstances: 2,
        databasePoolPerInstance: config.dbPoolSize,
        warnings,
        remaining: [
          '实际资源连通与权限',
          '微信真机登录',
          'COS直传和冻结副本',
          'CDN鉴权和播放',
          '备份恢复',
          '目标规模容量验收'
        ]
      },
      null,
      2
    )
  );
} catch (error) {
  // Do not echo environment values or full connector errors containing credentials.
  console.error(
    '部署配置未就绪：',
    error instanceof TypeError ? '请检查网址与必填配置' : error.message
  );
  process.exitCode = 1;
}
