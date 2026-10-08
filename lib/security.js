const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
async function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
async function passwordMatches(password, encoded) {
  if (!encoded) return false;
  const [salt, digest] = encoded.split(':');
  const candidate = await scrypt(password, salt, 64);
  const expected = Buffer.from(digest, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}
function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((s) => s.trim().split('='))
      .filter((p) => p.length === 2)
  );
}
async function createLimiter(config) {
  let redis;
  if (config.redisUrl) {
    redis = require('redis').createClient({
      url: config.redisUrl,
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: (retries) => Math.min(retries * 200, 3000)
      },
      disableOfflineQueue: true
    });
    redis.on('error', () => {});
    let startupTimer;
    try {
      await Promise.race([
        redis.connect(),
        new Promise((resolve, reject) => {
          startupTimer = setTimeout(() => reject(new Error('缓存连接超时，请检查正式资源')), 7000);
        })
      ]);
    } catch (error) {
      if (redis.isOpen) redis.destroy();
      throw error;
    } finally {
      clearTimeout(startupTimer);
    }
  }
  const buckets = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of buckets) if (value.until < now) buckets.delete(key);
  }, 60000);
  cleanup.unref();
  return {
    async ready() {
      if (redis && (!redis.isReady || (await redis.ping()) !== 'PONG')) {
        const error = new Error('缓存正在恢复');
        error.status = 503;
        throw error;
      }
    },
    async check(key, limit, seconds) {
      let count;
      if (redis) {
        if (!redis.isReady) {
          const e = new Error('服务正在恢复，请稍后重试');
          e.status = 503;
          throw e;
        }
        count = Number(
          await redis.eval(
            "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
            { keys: [`events:limit:${key}`], arguments: [String(seconds)] }
          )
        );
      } else {
        const now = Date.now();
        const entry = buckets.get(key);
        if (!entry || entry.until < now) {
          buckets.set(key, { count: 1, until: now + seconds * 1000 });
          count = 1;
        } else count = ++entry.count;
      }
      if (count > limit) {
        const e = new Error('操作太频繁，请稍后再试');
        e.status = 429;
        e.retryAfter = seconds;
        throw e;
      }
    },
    close: async () => {
      clearInterval(cleanup);
      if (redis) await redis.close();
    }
  };
}
module.exports = { hash, randomToken, passwordHash, passwordMatches, cookies, createLimiter };
