const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { hash, randomToken, passwordMatches, cookies } = require('./security');
const QR_LIFETIME = 5 * 60000;
const destinations = new Set(['home', 'participate', 'wall', 'account']);
module.exports = function register({
  app,
  db,
  config,
  limiter,
  one,
  auth,
  csrf,
  rate,
  publicUser,
  fail,
  text,
  uid,
  staff
}) {
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: config.production };
  const configured = () => !!(config.wechatAppId && config.wechatSecret);
  const qrLimit =
    (name, max, seconds = 60) =>
    async (req, res, next) => {
      try {
        const owner = cookies(req).qr_browser;
        const ticket = text(req.body?.ticket, 100);
        if (owner || ticket)
          await limiter.check('qr:' + name + ':' + hash(owner || ticket), max, seconds);
        next();
      } catch (e) {
        next(e);
      }
    };
  const createSession = async (user, c = db) => {
    const token = randomToken(),
      csrfToken = randomToken();
    await c.query('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,$4)', [
      hash(token),
      user.id,
      csrfToken,
      Date.now() + 7 * 86400000
    ]);
    return { token, user: publicUser(user), csrf: csrfToken };
  };
  const sendSession = (res, result) => {
    res.cookie('event_session', result.token, {
      ...cookieOptions,
      maxAge: 7 * 86400000,
      path: '/'
    });
    return { user: result.user, csrf: result.csrf };
  };
  const session = async (res, user) => sendSession(res, await createSession(user));
  const identity = async (key, nickname) => {
    await db.query(
      'INSERT INTO users(id,identity_key,nickname,role,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(identity_key) DO NOTHING',
      [uid(), key, nickname, 'participant', Date.now()]
    );
    return one('SELECT id,nickname,role FROM users WHERE identity_key=$1', [key]);
  };
  const avatar = (raw) => {
    try {
      const u = new URL(raw);
      if (
        !['http:', 'https:'].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.port ||
        !(u.hostname === 'qlogo.cn' || u.hostname.endsWith('.qlogo.cn'))
      )
        return '';
      u.protocol = 'https:';
      return u.toString();
    } catch {
      return '';
    }
  };
  const profile = async (openid, info) => {
    const key = 'wechat:' + openid,
      nickname = text(info.nickname, 60) || '参赛者';
    const user = await identity(key, nickname);
    await db.query('UPDATE users SET nickname=$1 WHERE id=$2', [nickname, user.id]);
    const image = avatar(info.headimgurl);
    await db.query(
      'INSERT INTO wechat_profiles(user_id,avatar_url,updated_at) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET avatar_url=$2,updated_at=$3',
      [user.id, image, Date.now()]
    );
    return { ...user, nickname, avatar_url: image };
  };
  const scanHash = (ticket) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket || '')) fail(400, '二维码无效，请在原网页刷新');
    return hash(ticket);
  };
  const liveScan = async (ticket, c = db, lock = false, terminalUser) => {
    const row = await one(
      'SELECT * FROM qr_logins WHERE scan_hash=$1' +
        (lock && c.dialect === 'postgres' ? ' FOR UPDATE' : ''),
      [scanHash(ticket)],
      c
    );
    if (!row || Number(row.expires_at) <= Date.now()) fail(410, '二维码已过期，请在原网页刷新');
    if (
      !['pending', 'scanned'].includes(row.status) &&
      !(
        terminalUser &&
        row.user_id === terminalUser &&
        ['approved', 'rejected', 'consumed'].includes(row.status)
      )
    )
      fail(410, '此二维码已结束，请在原网页重新登录');
    return row;
  };
  const wechatUser = async (req) =>
    req.user &&
    req.user.role === 'participant' &&
    (await one('SELECT id FROM users WHERE id=$1 AND identity_key LIKE $2', [
      req.user.id,
      'wechat:%'
    ]));
  const browserTicket = async (req, c = db, lock = false) => {
    const browser = cookies(req).qr_browser;
    if (!/^[a-f0-9-]{36}$/.test(req.params.id || '') || !browser)
      fail(404, '登录请求不存在，请刷新二维码');
    const row = await one(
      'SELECT * FROM qr_logins WHERE id=$1 AND browser_hash=$2' +
        (lock && c.dialect === 'postgres' ? ' FOR UPDATE' : ''),
      [req.params.id, hash(browser)],
      c
    );
    if (!row) fail(404, '登录请求不存在，请刷新二维码');
    return row;
  };
  const prepareOAuth = async (req, res, ticket) => {
    if (!configured()) fail(503, '微信登录尚未配置');
    if (config.production && !/MicroMessenger/i.test(req.headers['user-agent'] || ''))
      fail(400, '请在微信中打开授权页面');
    const row = await liveScan(ticket);
    const state = randomToken();
    await db.query(
      'INSERT INTO wechat_oauth_states(state_hash,scan_hash,destination,expires_at) VALUES($1,$2,$3,$4)',
      [hash(state), row.scan_hash, row.destination, Date.now() + QR_LIFETIME]
    );
    res.cookie('oauth_state', state, {
      ...cookieOptions,
      maxAge: QR_LIFETIME,
      path: '/api/auth/wechat/callback'
    });
    res.cookie('qr_scan', ticket, {
      ...cookieOptions,
      maxAge: QR_LIFETIME,
      path: '/api/auth/wechat/callback'
    });
    const url = new URL('https://open.weixin.qq.com/connect/oauth2/authorize');
    Object.entries({
      appid: config.wechatAppId,
      redirect_uri: config.origin + '/api/auth/wechat/callback',
      response_type: 'code',
      scope: 'snsapi_userinfo',
      state
    }).forEach(([k, v]) => url.searchParams.set(k, v));
    url.hash = 'wechat_redirect';
    return url.toString();
  };
  app.get('/api/session', (req, res) =>
    res.json({ user: publicUser(req.user), csrf: req.user?.csrf || null })
  );
  app.post('/api/auth/dev', rate('dev-login', 15), async (req, res) => {
    if (!config.devLogin) fail(404, '体验登录未开放');
    const alias = text(req.body.alias, 30);
    if (!/^[\p{L}\p{N}_-]{2,30}$/u.test(alias))
      fail(400, '体验昵称须为2至30个中英文字、数字或下划线');
    res.json({ ok: true, ...(await session(res, await identity('preview:' + alias, alias))) });
  });
  app.post('/api/auth/admin', rate('admin-login', 10, 900), async (req, res) => {
    const user = await one('SELECT * FROM users WHERE identity_key=$1', [
      'staff:' + text(req.body.username, 40)
    ]);
    const password = req.body.password;
    if (
      typeof password !== 'string' ||
      password.length > 200 ||
      !user ||
      !staff.includes(user.role) ||
      !(await passwordMatches(password, user.password_hash))
    )
      fail(401, '账号或密码不正确');
    res.json({ ok: true, ...(await session(res, user)) });
  });
  app.post('/api/auth/logout', auth, csrf, async (req, res) => {
    await db.query('DELETE FROM sessions WHERE token_hash=$1', [hash(cookies(req).event_session)]);
    res.clearCookie('event_session', { ...cookieOptions, path: '/' });
    res.json({ ok: true });
  });
  app.post(
    '/api/auth/wechat/prepare',
    rate('wechat-prepare', 2000),
    qrLimit('prepare', 15),
    async (req, res) => res.json({ url: await prepareOAuth(req, res, text(req.body.ticket, 100)) })
  );
  app.get('/api/auth/wechat/callback', rate('wechat-callback', 3000), async (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    const state = text(req.query.state, 100),
      code = text(req.query.code, 200),
      jar = cookies(req);
    if (!configured() || !state || state !== jar.oauth_state || !code)
      return res.redirect('/wechat-login.html#error=authorization');
    const result = await db.query(
      'DELETE FROM wechat_oauth_states WHERE state_hash=$1 AND expires_at>$2 RETURNING *',
      [hash(state), Date.now()]
    );
    if (!result.rowCount) return res.redirect('/wechat-login.html#error=expired');
    const flow = result.rows[0];
    let target = '/wechat-login.html#error=authorization';
    try {
      if (!flow.scan_hash || !jar.qr_scan || hash(jar.qr_scan) !== flow.scan_hash)
        fail(400, '扫码状态不匹配');
      await liveScan(jar.qr_scan);
      const url = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
      Object.entries({
        appid: config.wechatAppId,
        secret: config.wechatSecret,
        code,
        grant_type: 'authorization_code'
      }).forEach(([k, v]) => url.searchParams.set(k, v));
      const token = await (await fetch(url, { signal: AbortSignal.timeout(10000) })).json();
      if (token.errcode || !token.openid || !token.access_token) fail(400, '微信授权失败，请重试');
      const infoUrl = new URL('https://api.weixin.qq.com/sns/userinfo');
      Object.entries({
        access_token: token.access_token,
        openid: token.openid,
        lang: 'zh_CN'
      }).forEach(([k, v]) => infoUrl.searchParams.set(k, v));
      const info = await (await fetch(infoUrl, { signal: AbortSignal.timeout(10000) })).json();
      if (info.errcode || info.openid !== token.openid) fail(400, '无法读取微信身份');
      await session(res, await profile(token.openid, info));
      target = '/wechat-login.html#ticket=' + jar.qr_scan;
    } catch (error) {
      // Never expose provider tokens, codes or identity details in errors.
      console.warn(
        JSON.stringify({
          requestId: req.requestId,
          route: 'wechat-callback',
          error: error.code || error.name || 'authorization'
        })
      );
    }
    res.clearCookie('oauth_state', { ...cookieOptions, path: '/api/auth/wechat/callback' });
    res.clearCookie('qr_scan', { ...cookieOptions, path: '/api/auth/wechat/callback' });
    res.redirect(target);
  });
  app.post(
    '/api/auth/qr',
    rate('qr-create', 2000, 600),
    qrLimit('create', 12, 600),
    async (req, res) => {
      if (!configured()) fail(503, '微信登录尚未配置');
      const browser = cookies(req).qr_browser || randomToken(),
        ticket = randomToken(),
        id = uid();
      const expiresAt = Date.now() + QR_LIFETIME,
        code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const qrImage = await QRCode.toDataURL(
        config.origin + '/wechat-login.html#ticket=' + ticket,
        {
          width: 280,
          margin: 2,
          errorCorrectionLevel: 'M',
          color: { dark: '#07111f', light: '#ffffff' }
        }
      );
      await db.transaction(async (c) => {
        await c.query(
          "UPDATE qr_logins SET status='cancelled' WHERE browser_hash=$1 AND status IN ('pending','scanned','approved')",
          [hash(browser)]
        );
        await c.query(
          'INSERT INTO qr_logins(id,scan_hash,browser_hash,display_code,status,expires_at,destination) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            id,
            hash(ticket),
            hash(browser),
            code,
            'pending',
            expiresAt,
            destinations.has(req.body.returnTo) ? req.body.returnTo : 'account'
          ]
        );
      });
      res.cookie('qr_browser', browser, {
        ...cookieOptions,
        sameSite: 'strict',
        path: '/api/auth/qr',
        maxAge: QR_LIFETIME
      });
      res.json({ id, qrImage, displayCode: code, expiresAt });
    }
  );
  app.get('/api/auth/qr/:id', qrLimit('poll', 80), async (req, res) => {
    const row = await browserTicket(req);
    res.json({
      status: Number(row.expires_at) <= Date.now() ? 'expired' : row.status,
      expiresAt: Number(row.expires_at),
      authenticated: row.status === 'consumed' && row.user_id === req.user?.id
    });
  });
  app.post('/api/auth/qr/:id/complete', qrLimit('complete', 20), async (req, res) => {
    const result = await db.transaction(async (c) => {
      const row = await browserTicket(req, c, true);
      if (Number(row.expires_at) <= Date.now()) fail(410, '二维码已过期，请刷新');
      if (row.status !== 'approved' || !row.user_id) fail(409, '请先在手机微信上确认登录');
      const user = await one(
        'SELECT u.id,u.nickname,u.role,p.avatar_url FROM users u LEFT JOIN wechat_profiles p ON p.user_id=u.id WHERE u.id=$1',
        [row.user_id],
        c
      );
      if (!user || user.role !== 'participant') fail(400, '登录身份无效');
      const login = await createSession(user, c);
      await c.query("UPDATE qr_logins SET status='consumed' WHERE id=$1", [row.id]);
      return { login, destination: row.destination };
    });
    // Keep the short-lived browser binding so a lost response body can be recovered.
    // Consumed tickets still cannot create a second session.
    res.json({ ok: true, ...sendSession(res, result.login), destination: result.destination });
  });
  app.post('/api/auth/qr/scan', rate('qr-scan', 2000), qrLimit('scan', 30), async (req, res) => {
    const signedIn = !!(await wechatUser(req));
    const row = await liveScan(
      text(req.body.ticket, 100),
      db,
      false,
      signedIn ? req.user.id : undefined
    );
    if (signedIn && ['pending', 'scanned'].includes(row.status)) {
      const changed = await db.query(
        "UPDATE qr_logins SET status='scanned',user_id=$1 WHERE id=$2 AND status IN ('pending','scanned') AND expires_at>$3 AND (user_id IS NULL OR user_id=$1)",
        [req.user.id, row.id, Date.now()]
      );
      if (!changed.rowCount) fail(409, '此二维码已被另一个账号扫描，请在原网页刷新');
    }
    res.json({
      displayCode: row.display_code,
      expiresAt: Number(row.expires_at),
      origin: config.origin,
      status: row.status,
      signedIn,
      user: signedIn ? publicUser(req.user) : null
    });
  });
  app.post('/api/auth/qr/decision', auth, csrf, rate('qr-decision', 30), async (req, res) => {
    if (!(await wechatUser(req))) fail(401, '请先完成微信授权');
    if (config.production && !/MicroMessenger/i.test(req.headers['user-agent'] || ''))
      fail(400, '请在手机微信中确认');
    if (!['approve', 'reject'].includes(req.body.decision)) fail(400, '操作无效');
    await db.transaction(async (c) => {
      const row = await liveScan(text(req.body.ticket, 100), c, true, req.user.id);
      if (row.user_id !== req.user.id) fail(409, '请刷新确认页，核对当前微信账号');
      const expected = req.body.decision === 'approve' ? 'approved' : 'rejected';
      if (row.status === expected || (row.status === 'consumed' && expected === 'approved')) return;
      if (!['pending', 'scanned'].includes(row.status)) fail(409, '此登录请求已确认，不能更改');
      await c.query('UPDATE qr_logins SET status=$1 WHERE id=$2', [
        req.body.decision === 'approve' ? 'approved' : 'rejected',
        row.id
      ]);
    });
    res.json({ ok: true });
  });
};
