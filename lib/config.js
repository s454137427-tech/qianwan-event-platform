const path = require('node:path');
const production = process.env.NODE_ENV === 'production';
function urlValue(value, name, protocols) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name}网址格式不正确`);
  }
  if (!protocols.includes(url.protocol)) throw new Error(`${name}协议不正确`);
  return url;
}
function integer(name, fallback, min, max) {
  const n = Number(process.env[name] || fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}配置不合法`);
  return n;
}
const config = {
  production,
  host: process.env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
  port: integer('PORT', 3000, 1, 65535),
  origin: process.env.APP_ORIGIN || `http://127.0.0.1:${process.env.PORT || 3000}`,
  devLogin: !production && process.env.ALLOW_DEV_LOGIN === 'true',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'var')),
  verificationDir: path.resolve(
    process.env.WECHAT_VERIFICATION_DIR ||
      path.join(__dirname, '..', 'deploy', 'wechat-verification')
  ),
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl: process.env.DATABASE_SSL === 'true',
  redisUrl: process.env.REDIS_URL || '',
  storage: process.env.STORAGE_DRIVER || 'local',
  videoLimit: integer('MAX_VIDEO_MB', 500, 1, 2048) * 1024 * 1024,
  expectedVideoSeconds: integer('VIDEO_EXPECTED_SECONDS', 180, 1, 7200),
  retentionDays: integer('DATA_RETENTION_DAYS', 15, 1, 3650),
  eventEndAt: process.env.EVENT_END_AT || '',
  uploadQuotaBytes: integer('USER_UPLOAD_QUOTA_MB', 3072, 5, 102400) * 1024 * 1024,
  uploadQuotaCount: integer('USER_UPLOAD_MAX_FILES', 50, 1, 1000),
  uploadCapacityBytes: integer('TOTAL_UPLOAD_CAPACITY_GB', 1024, 1, 102400) * 1024 ** 3,
  dbPoolSize: integer('DB_POOL_SIZE', 12, 2, 64),
  chunkSize: 5 * 1024 * 1024,
  trustProxy: integer('TRUST_PROXY_HOPS', 0, 0, 5),
  deadlines: {
    registration: process.env.REGISTRATION_DEADLINE || '',
    film: process.env.FILM_DEADLINE || '',
    vote: process.env.VOTING_DEADLINE || ''
  },
  wechatAppId: process.env.WECHAT_APPID || '',
  wechatSecret: process.env.WECHAT_SECRET || '',
  organizer: process.env.ORGANIZER_NAME || '',
  contact: process.env.CONTACT_TEXT || '',
  privacyNotice: process.env.PRIVACY_NOTICE || '',
  rulesConfirmed: process.env.RULES_CONFIRMED === 'true',
  cdn: {
    origin: process.env.VIDEO_CDN_ORIGIN || '',
    key: process.env.VIDEO_CDN_AUTH_KEY || '',
    confirmed: process.env.VIDEO_CDN_AUTH_CONFIRMED === 'true',
    ttl: integer('VIDEO_CDN_AUTH_TTL', 600, 60, 86400)
  },
  tos: {
    accessKeyId: process.env.TOS_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.TOS_ACCESS_KEY_SECRET || '',
    bucket: process.env.TOS_BUCKET || '',
    region: process.env.TOS_REGION || '',
    endpoint: process.env.TOS_ENDPOINT || '',
    roleTrn: process.env.TOS_UPLOAD_ROLE_TRN || '',
    publicOrigin: process.env.TOS_PUBLIC_ORIGIN || ''
  }
};
for (const date of [...Object.values(config.deadlines), config.eventEndAt]) {
  if (
    date &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(date) ||
      !Number.isFinite(Date.parse(date)))
  )
    throw new Error('截止时间请使用包含时区的完整时间，例如2026-10-25T18:00:00+08:00');
}
const originUrl = urlValue(config.origin, 'APP_ORIGIN', ['http:', 'https:']);
if (
  !['http:', 'https:'].includes(originUrl.protocol) ||
  originUrl.username ||
  originUrl.password ||
  originUrl.search ||
  originUrl.hash ||
  originUrl.pathname !== '/'
)
  throw new Error('APP_ORIGIN只能填写网站来源，例如https://event.example.com，不带路径或参数');
config.origin = originUrl.origin;
if (config.databaseUrl) urlValue(config.databaseUrl, 'DATABASE_URL', ['postgres:', 'postgresql:']);
if (config.redisUrl) urlValue(config.redisUrl, 'REDIS_URL', ['redis:', 'rediss:']);
if (!!config.wechatAppId !== !!config.wechatSecret)
  throw new Error('微信AppID和Secret必须同时填写');
if (config.cdn.origin || config.cdn.key || config.cdn.confirmed)
  throw new Error('旧VIDEO_CDN鉴权已禁用；TOS仅支持直接绑定桶的HTTPS自定义域名');
if (!['local', 'tos'].includes(config.storage))
  throw new Error('STORAGE_DRIVER必须为local或tos，旧OSS/COS配置不可直接使用');
if (config.storage === 'tos') {
  if (Object.values(config.tos).some((value) => !value.trim())) throw new Error('TOS配置不完整');
  if (
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.tos.bucket) ||
    !/^[a-z]{2}-[a-z]+(?:-[a-z0-9]+)*$/.test(config.tos.region) ||
    !/^trn:iam::[0-9]+:role\/[a-zA-Z0-9._@-]+$/.test(config.tos.roleTrn)
  )
    throw new Error('TOS桶名、地域或上传角色TRN格式不正确');
  const endpoint = urlValue(
    config.tos.endpoint.includes('://') ? config.tos.endpoint : 'https://' + config.tos.endpoint,
    'TOS_ENDPOINT',
    ['https:']
  );
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash ||
    ![
      'tos-' + config.tos.region + '.volces.com',
      'tos-' + config.tos.region + '.ivolces.com'
    ].includes(endpoint.hostname)
  )
    throw new Error(
      'TOS_ENDPOINT须为实际地域的TOS原生Endpoint，不带桶名、路径或端口，不使用S3端点'
    );
  config.tos.endpoint = endpoint.hostname;
  const media = urlValue(config.tos.publicOrigin, 'TOS_PUBLIC_ORIGIN', ['https:']);
  if (
    media.username ||
    media.password ||
    media.port ||
    media.pathname !== '/' ||
    media.search ||
    media.hash ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(media.hostname) ||
    /\.(?:volces|ivolces|aliyuncs|myqcloud)\.com$/.test(media.hostname) ||
    media.origin === config.origin
  )
    throw new Error('TOS_PUBLIC_ORIGIN须为独立绑定TOS桶的HTTPS自定义域名，不带路径、端口或参数');
  config.tos.publicOrigin = media.origin;
}
if (production) {
  if (
    !config.origin.startsWith('https://') ||
    !config.databaseUrl ||
    !config.redisUrl ||
    config.storage !== 'tos' ||
    !config.wechatAppId ||
    !config.wechatSecret
  ) {
    throw new Error('正式环境缺少HTTPS、PostgreSQL、Redis、TOS或微信配置，禁止以预览配置启动');
  }
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 16)
    throw new Error('正式环境需配置至少16位的后台初始化密码');
  if (process.env.ALLOW_DEV_LOGIN === 'true') throw new Error('正式环境禁止开启体验登录');
  if (!config.organizer || !config.contact || !config.privacyNotice || !config.rulesConfirmed)
    throw new Error('正式环境需确认运营主体、咨询方式、隐私说明和赛事规则');
}
module.exports = config;
