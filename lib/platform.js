const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const defaults = require('./config');
const { openDatabase } = require('./database');
const { createStorage } = require('./storage');
const { hash, cookies, createLimiter, passwordHash } = require('./security');
function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
const uid = () => crypto.randomUUID();
const text = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const staff = ['admin', 'reviewer', 'judge', 'checker'];
async function createPlatform(config = defaults) {
  await fs.mkdir(config.dataDir, { recursive: true });
  const db = await openDatabase(config);
  let storage, limiter;
  try {
    storage = await createStorage(config);
    limiter = await createLimiter(config);
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    app.use((req, res, next) => {
      req.requestId = uid();
      res.set('X-Request-Id', req.requestId);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Referrer-Policy', 'same-origin');
      res.set('X-Frame-Options', 'DENY');
      res.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https://*.myqcloud.com https://*.tencentcos.cn; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      );
      if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000');
      next();
    });
    app.use(express.json({ limit: '64kb' }));
    const one = async (s, p = [], c = db) => (await c.query(s, p)).rows[0];
    const auth = (req, res, next) =>
      req.user ? next() : next(Object.assign(new Error('请先登录'), { status: 401 }));
    const csrf = (req, res, next) =>
      req.user && req.headers['x-csrf-token'] === req.user.csrf
        ? next()
        : next(Object.assign(new Error('页面已过期，请刷新重试'), { status: 403 }));
    const role =
      (...roles) =>
      (req, res, next) =>
        req.user && roles.includes(req.user.role)
          ? next()
          : next(Object.assign(new Error('没有此操作的权限'), { status: 403 }));
    const rate =
      (name, max, seconds = 60) =>
      async (req, res, next) => {
        try {
          await limiter.check(`${name}:${req.user?.id || hash(req.ip)}`, max, seconds);
          next();
        } catch (e) {
          next(e);
        }
      };
    const settings = async () =>
      Object.fromEntries(
        (await db.query('SELECT key,value FROM settings')).rows.map((r) => [r.key, r.value])
      );
    const lockUser = (c, id) =>
      one(
        `SELECT id FROM users WHERE id=$1${c.dialect === 'postgres' ? ' FOR UPDATE' : ''}`,
        [id],
        c
      );
    const audit = (actor, action, target, detail = {}, c = db) =>
      c.query(
        'INSERT INTO audit(id,actor_id,action,target_id,detail,created_at) VALUES($1,$2,$3,$4,$5,$6)',
        [uid(), actor, action, target, JSON.stringify(detail), Date.now()]
      );
    const competition = (value) => {
      if (!['creator', 'film'].includes(value)) fail(400, '赛事不存在');
      return value;
    };
    const deadline = (type) => {
      if (config.deadlines[type] && Date.now() > Date.parse(config.deadlines[type]))
        fail(400, '本阶段已截止');
    };
    const applicationView = (row) => ({
      ...row,
      payload: JSON.parse(row.payload),
      checked_at: row.checked_at ? Number(row.checked_at) : null,
      seat_count: Number(row.seat_count)
    });
    const publicUser = (u) =>
      u ? { id: u.id, nickname: u.nickname, role: u.role, avatar: u.avatar_url || '' } : null;
    const ownUpload = async (id, user, ready = false, c = db) => {
      if (!/^[a-f0-9-]{36}$/.test(id || '')) fail(400, '文件编号不正确');
      const task = await one('SELECT * FROM uploads WHERE id=$1 AND user_id=$2', [id, user], c);
      if (!task || (ready && task.status !== 'ready')) fail(400, '文件尚未就绪或不属于当前账号');
      return task;
    };
    app.use('/api', async (req, res, next) => {
      res.set('Cache-Control', 'no-store');
      try {
        if (
          !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
          ((req.headers.origin && req.headers.origin !== config.origin) ||
            req.headers['sec-fetch-site'] === 'cross-site')
        )
          fail(403, '请从活动页面操作');
        const token = cookies(req).event_session;
        if (token)
          req.user = await one(
            'SELECT u.id,u.nickname,u.role,s.csrf,p.avatar_url FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN wechat_profiles p ON p.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>$2',
            [hash(token), Date.now()]
          );
        next();
      } catch (e) {
        next(e);
      }
    });
    const adminName = process.env.ADMIN_USERNAME || 'admin';
    if (!(await one('SELECT id FROM users WHERE identity_key=$1', [`staff:${adminName}`]))) {
      const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url');
      await db.query(
        'INSERT INTO users(id,identity_key,nickname,role,password_hash,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(identity_key) DO NOTHING',
        [
          uid(),
          `staff:${adminName}`,
          '活动管理员',
          'admin',
          await passwordHash(password),
          Date.now()
        ]
      );
      if (!process.env.ADMIN_PASSWORD)
        await fs.writeFile(
          path.join(config.dataDir, '本地后台登录.txt'),
          `仅供本机预览，请勿分享或发布此文件。\n后台：${config.origin}/admin.html\n账号：${adminName}\n密码：${password}\n`,
          { mode: 0o600 }
        );
    }
    for (const [key, value] of Object.entries({
      capacity: String(config.capacity),
      registrationOpen: String(!config.production),
      votingOpen: String(!config.production),
      uploadGate: 'open'
    }))
      await db.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING', [
        key,
        value
      ]);
    const context = {
      app,
      db,
      config,
      storage,
      limiter,
      one,
      auth,
      csrf,
      role,
      rate,
      settings,
      lockUser,
      audit,
      competition,
      deadline,
      applicationView,
      publicUser,
      ownUpload,
      fail,
      text,
      uid,
      staff
    };
    require('./routes-auth')(context);
    require('./routes-participation')(context);
    require('./routes-admin')(context);
    app.get('/api/health', async (req, res) => {
      await db.query('SELECT 1');
      res.json({ ok: true, service: 'qianwan-events' });
    });
    app.get('/api/ready', async (req, res) => {
      await db.query('SELECT 1');
      await limiter.ready();
      res.json({ ok: true, service: 'qianwan-events' });
    });
    app.get('/api/config', async (req, res) => {
      const s = await settings();
      res.json({
        preview: !config.production,
        devLogin: config.devLogin,
        wechat: !!(config.wechatAppId && config.wechatSecret),
        wechatModes: {
          inWechat: !!(config.wechatAppId && config.wechatSecret),
          browserScan: !!(config.wechatAppId && config.wechatSecret)
        },
        organizer: config.organizer,
        contact: config.contact,
        privacyNotice: config.privacyNotice,
        launchDate: '2026-10-25',
        maxVideoMb: config.videoLimit / 1024 ** 2,
        expectedVideoSeconds: config.expectedVideoSeconds,
        retentionDays: config.retentionDays,
        uploadQuotaMb: config.uploadQuotaBytes / 1024 ** 2,
        uploadMaxFiles: config.uploadQuotaCount,
        chunkSize: config.chunkSize,
        storage: storage.driver,
        capacity: Number(s.capacity),
        registrationOpen: s.registrationOpen === 'true',
        votingOpen: s.votingOpen === 'true',
        deadlines: config.deadlines,
        rules: {
          film: '同一账号对同一作品全赛期1票。综合分=评委平均分×60%+网络分×40%。',
          creator: '同一账号全赛期3票，分别投给不同作品。'
        }
      });
    });
    app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
    app.get(/^\/MP_verify_[A-Za-z0-9]+\.txt$/, (req, res) => {
      res.type('text/plain').set('Cache-Control', 'no-store');
      res.sendFile(path.basename(req.path), { root: config.verificationDir, dotfiles: 'deny' });
    });
    app.get('/vendor/cos.js', (req, res) =>
      res.sendFile(require.resolve('cos-js-sdk-v5/dist/cos-js-sdk-v5.min.js'), {
        dotfiles: 'allow'
      })
    );
    app.use(express.static(path.join(__dirname, '..', 'web'), { maxAge: 0, dotfiles: 'deny' }));
    app.use((error, req, res, next) => {
      if (res.headersSent) return next(error);
      const status =
        error.status >= 400 && error.status <= 599
          ? error.status
          : error.name === 'MulterError'
            ? 400
            : 500;
      if (status >= 500)
        console.error(
          JSON.stringify({
            requestId: req.requestId,
            method: req.method,
            route: req.path,
            error: error.code || error.name
          })
        );
      if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
      res.status(status).json({
        error:
          status >= 500
            ? '服务暂时不可用，请保留资料稍后重试'
            : error.name === 'MulterError'
              ? '文件分片不符合要求'
              : error.message,
        requestId: req.requestId
      });
    });
    const cleanup = setInterval(() => {
      for (const table of ['sessions', 'oauth_states', 'wechat_oauth_states', 'qr_logins'])
        db.query('DELETE FROM ' + table + ' WHERE expires_at<$1', [Date.now()]).catch(() => {});
    }, 3600000);
    cleanup.unref();
    return {
      app,
      db,
      config,
      close: async () => {
        clearInterval(cleanup);
        await limiter.close();
        await db.close();
      }
    };
  } catch (error) {
    await Promise.allSettled([limiter?.close(), db.close()]);
    throw error;
  }
}
module.exports = { createPlatform };
