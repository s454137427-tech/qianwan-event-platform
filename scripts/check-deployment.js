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
    'TOS_ACCESS_KEY_ID',
    'TOS_ACCESS_KEY_SECRET',
    'TOS_BUCKET',
    'TOS_REGION',
    'TOS_ENDPOINT',
    'TOS_UPLOAD_ROLE_TRN',
    'TOS_PUBLIC_ORIGIN',
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
  if (
    config.origin !== 'https://mega.gynnai.com' ||
    config.tos.publicOrigin !== 'https://media.gynnai.com'
  )
    throw new Error('正式域名须使用已确认的mega.gynnai.com与media.gynnai.com');
  const warnings = [];
  if (
    !config.databaseUrl.startsWith('postgresql://') &&
    !config.databaseUrl.startsWith('postgres://')
  )
    throw new Error('数据库必须使用PostgreSQL连接地址');
  if (!config.redisUrl.startsWith('redis://') && !config.redisUrl.startsWith('rediss://'))
    throw new Error('缓存必须使用Redis连接地址');
  if (!config.databaseSsl) warnings.push('数据库未启用TLS，请确认实际私有网络及连接策略');
  if (new URL(config.tos.publicOrigin).hostname.endsWith('.example.com'))
    throw new Error('TOS_PUBLIC_ORIGIN仍是示例域名，请填写绑定TOS桶的媒体子域名');
  warnings.push('TOS直连播放：CDN未启用，实际公网流量费用和容量须验收');
  if (Object.values(config.deadlines).some((value) => !value))
    warnings.push('仍有截止时间未填写，相关阶段不会自动按时间关闭');
  if (!config.eventEndAt) warnings.push('活动结束时间未确认：15天保留计划尚无具体清理日期');
  console.log(
    JSON.stringify(
      {
        ok: true,
        scope: 'configuration-only',
        storage: 'tos',
        database: 'postgresql',
        redis: 'configured',
        cdn: false,
        applicationInstances: 2,
        databasePoolPerInstance: config.dbPoolSize,
        warnings,
        remaining: [
          '实际资源连通与权限',
          '微信真机登录',
          'TOS直传、STS权限、续传和冻结副本',
          '自定义域名、HTTPS、CORS、Range和微信视频播放',
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
