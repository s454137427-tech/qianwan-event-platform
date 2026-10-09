const { passwordHash } = require('./security');
const { sendCsv } = require('./csv');
const archive = require('./archive');
module.exports = function register({
  app,
  db,
  config,
  storage,
  one,
  auth,
  csrf,
  role,
  rate,
  settings,
  audit,
  lockUser,
  competition,
  applicationView,
  fail,
  text,
  uid,
  staff
}) {
  app.use('/api/admin', auth, role(...staff));
  let exporting = false;
  app.get(
    '/api/admin/export/archive',
    role('admin'),
    rate('archive-export', 5, 300),
    async (req, res) => {
      const scope = req.query.scope || 'client';
      if (!['client', 'internal'].includes(scope)) fail(400, '请选择甲方备案或内部留存');
      if (exporting) fail(409, '正在生成归档，请稍后重试');
      exporting = true;
      try {
        const data = await archive.capture(db);
        const { files, records } = archive.buildFiles(data, scope, config, req.user);
        const buffer = await archive.zip(files);
        await audit(req.user.id, 'archive.export', 'film', {
          scope,
          capturedAt: data.capturedAt,
          records
        });
        const stamp = data.capturedAt.replace(/[-:]/g, '').slice(0, 15);
        res
          .set('Cache-Control', 'private, no-store')
          .set('Content-Disposition', `attachment; filename="qianwan-film-${scope}-${stamp}.zip"`)
          .type('application/zip')
          .send(buffer);
      } finally {
        exporting = false;
      }
    }
  );
  app.get('/api/admin/overview', async (req, res) =>
    res.json({
      works: (
        await db.query(
          "SELECT competition,status,COUNT(*) AS count FROM works WHERE competition='film' GROUP BY competition,status"
        )
      ).rows,
      applications: (
        await db.query(
          "SELECT competition,status,COUNT(*) AS count FROM applications WHERE competition='film' GROUP BY competition,status"
        )
      ).rows,
      settings: await settings(),
      role: req.user.role
    })
  );
  app.get('/api/admin/applications', role('admin', 'reviewer'), async (req, res) => {
    const type = competition(req.query.competition || 'film'),
      status = text(req.query.status, 20),
      page = Math.max(1, Math.min(10000, Math.floor(Number(req.query.page) || 1)));
    const where = status ? ' AND status=$2' : '',
      args = status ? [type, status] : [type],
      i = args.length;
    const rows = (
      await db.query(
        `SELECT * FROM applications WHERE competition=$1${where} ORDER BY created_at DESC LIMIT $${i + 1} OFFSET $${i + 2}`,
        [...args, 20, (page - 1) * 20]
      )
    ).rows.map(applicationView);
    res.json({
      items: rows,
      page,
      total: Number(
        (await one(`SELECT COUNT(*) AS count FROM applications WHERE competition=$1${where}`, args))
          .count
      )
    });
  });
  app.post(
    '/api/admin/applications/:id/review',
    csrf,
    role('admin', 'reviewer'),
    async (req, res) => {
      const status = req.body.status,
        note = text(req.body.note, 500);
      if (!['approved', 'rejected'].includes(status) || (status === 'rejected' && !note))
        fail(400, '退回时请填写原因');
      const result = await db.transaction(async (c) => {
        const owner = await one('SELECT user_id FROM applications WHERE id=$1', [req.params.id], c);
        if (!owner) fail(404, '资料不存在');
        await lockUser(c, owner.user_id);
        const old = await one(
          `SELECT * FROM applications WHERE id=$1${c.dialect === 'postgres' ? ' FOR UPDATE' : ''}`,
          [req.params.id],
          c
        );
        if (!old || old.status === 'draft') fail(400, '资料未提交或不存在');
        competition(old.competition);
        if (old.status === status) return old;
        if (
          await one(
            'SELECT id FROM works WHERE user_id=$1 AND competition=$2 AND status=$3',
            [old.user_id, old.competition, 'approved'],
            c
          )
        )
          fail(400, '已有上墙作品的报名不可直接退回');
        await c.query('UPDATE applications SET status=$1,note=$2,updated_at=$3 WHERE id=$4', [
          status,
          note,
          Date.now(),
          old.id
        ]);
        await audit(req.user.id, 'application.review', old.id, { status, note }, c);
        return one('SELECT * FROM applications WHERE id=$1', [old.id], c);
      });
      res.json({ ok: true, application: applicationView(result) });
    }
  );
  app.get('/api/admin/works', role('admin', 'reviewer', 'judge'), async (req, res) => {
    const type = competition(req.query.competition || 'film'),
      status = text(req.query.status, 20),
      page = Math.max(1, Math.min(10000, Math.floor(Number(req.query.page) || 1))),
      where = status ? ' AND w.status=$2' : '',
      args = status ? [type, status] : [type],
      i = args.length;
    const rows = (
      await db.query(
        `SELECT w.*,COALESCE((SELECT AVG(score) FROM scores WHERE work_id=w.id),0) AS judge_score FROM works w WHERE competition=$1${where} ORDER BY w.created_at DESC LIMIT $${i + 1} OFFSET $${i + 2}`,
        [...args, 20, (page - 1) * 20]
      )
    ).rows;
    const scores = (
      await db.query('SELECT work_id,score FROM scores WHERE judge_id=$1', [req.user.id])
    ).rows;
    res.json({
      items: rows.map((w) => ({
        ...w,
        myScore: scores.find((s) => s.work_id === w.id)?.score ?? null,
        videoUrl: w.video_id ? `/api/media/${w.video_id}` : null
      })),
      total: Number(
        (await one(`SELECT COUNT(*) AS count FROM works w WHERE competition=$1${where}`, args))
          .count
      ),
      page
    });
  });
  app.post('/api/admin/works/:id/review', csrf, role('admin', 'reviewer'), async (req, res) => {
    const status = req.body.status,
      note = text(req.body.note, 500);
    if (!['approved', 'rejected'].includes(status) || (status === 'rejected' && !note))
      fail(400, '退回请填写原因');
    await db.transaction(async (c) => {
      const owner = await one('SELECT user_id FROM works WHERE id=$1', [req.params.id], c);
      if (!owner) fail(404, '作品不存在');
      await lockUser(c, owner.user_id);
      const work = await one(
        `SELECT * FROM works WHERE id=$1${c.dialect === 'postgres' ? ' FOR UPDATE' : ''}`,
        [req.params.id],
        c
      );
      if (!work) fail(404, '作品不存在');
      competition(work.competition);
      if (
        status === 'approved' &&
        !(await one(
          'SELECT id FROM applications WHERE user_id=$1 AND competition=$2 AND status=$3',
          [work.user_id, work.competition, 'approved'],
          c
        ))
      )
        fail(400, '请先通过该作者的报名/身份核验');
      if (work.status === 'approved' && Number(work.votes) > 0 && status === 'rejected')
        fail(400, '已有投票的作品请联系负责人处理');
      await c.query('UPDATE works SET status=$1,note=$2,updated_at=$3 WHERE id=$4', [
        status,
        note,
        Date.now(),
        work.id
      ]);
      await audit(req.user.id, 'work.review', work.id, { status, note }, c);
    });
    res.json({ ok: true });
  });
  app.post('/api/admin/works/:id/score', csrf, role('admin', 'judge'), async (req, res) => {
    const score = Number(req.body.score);
    if (
      req.body.score === '' ||
      req.body.score == null ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 100
    )
      fail(400, '评分须在0至100之间');
    await db.transaction(async (c) => {
      if (
        !(await one(
          "SELECT id FROM works WHERE id=$1 AND status=$2 AND competition='film'" +
            (c.dialect === 'postgres' ? ' FOR UPDATE' : ''),
          [req.params.id, 'approved'],
          c
        ))
      )
        fail(400, '作品尚未通过审核');
      await c.query(
        'INSERT INTO scores(work_id,judge_id,score,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(work_id,judge_id) DO UPDATE SET score=excluded.score,updated_at=excluded.updated_at',
        [req.params.id, req.user.id, score, Date.now()]
      );
      await audit(req.user.id, 'work.score', req.params.id, { score }, c);
    });
    res.json({ ok: true });
  });
  app.put('/api/admin/settings', csrf, role('admin'), async (req, res) => {
    if (typeof req.body.registrationOpen !== 'boolean' || typeof req.body.votingOpen !== 'boolean')
      fail(400, '设置不正确');
    await db.transaction(async (c) => {
      for (const [key, value] of Object.entries({
        registrationOpen: String(req.body.registrationOpen),
        votingOpen: String(req.body.votingOpen)
      }))
        await c.query('UPDATE settings SET value=$1 WHERE key=$2', [value, key]);
      await audit(req.user.id, 'settings.update', 'platform', req.body, c);
    });
    res.json({ ok: true });
  });
  app.get('/api/admin/staff', role('admin'), async (req, res) =>
    res.json(
      (
        await db.query(
          "SELECT id,nickname,role,identity_key FROM users WHERE role<>'participant' ORDER BY created_at"
        )
      ).rows.map((r) => ({
        id: r.id,
        username: r.identity_key.slice(6),
        nickname: r.nickname,
        role: r.role
      }))
    )
  );
  app.post('/api/admin/staff', csrf, role('admin'), rate('staff-create', 10), async (req, res) => {
    const name = text(req.body.username, 40),
      nickname = text(req.body.nickname, 60),
      password = req.body.password,
      r = req.body.role;
    if (
      !/^[a-zA-Z0-9_-]{3,40}$/.test(name) ||
      !nickname ||
      !staff.includes(r) ||
      typeof password !== 'string' ||
      password.length < 16 ||
      password.length > 128
    )
      fail(400, '请填写有效账号、角色及至少16位密码');
    if (await one('SELECT id FROM users WHERE identity_key=$1', [`staff:${name}`]))
      fail(400, '账号已存在');
    const id = uid();
    const encodedPassword = await passwordHash(password);
    await db.transaction(async (c) => {
      const created = await c.query(
        'INSERT INTO users(id,identity_key,nickname,role,password_hash,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(identity_key) DO NOTHING RETURNING id',
        [id, `staff:${name}`, nickname, r, encodedPassword, Date.now()]
      );
      if (!created.rowCount) fail(409, '账号已存在，请使用其他账号名称');
      await audit(req.user.id, 'staff.create', id, { role: r }, c);
    });
    res.json({ ok: true });
  });
  app.get('/api/admin/audit', role('admin'), async (req, res) =>
    res.json(
      (
        await db.query(
          'SELECT a.action,a.target_id,a.detail,a.created_at,u.nickname FROM audit a JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 100'
        )
      ).rows
    )
  );
  app.get('/api/admin/storage', role('admin'), async (req, res) => {
    const groups = (
      await db.query(
        'SELECT kind,status,COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM uploads GROUP BY kind,status'
      )
    ).rows.map((row) => ({ ...row, count: Number(row.count), bytes: Number(row.bytes) }));
    const total = groups.reduce((sum, row) => sum + row.bytes, 0),
      saved = groups
        .filter((row) => row.status === 'ready')
        .reduce((sum, row) => sum + row.bytes, 0);
    const plannedDeleteAt = config.eventEndAt
      ? new Date(Date.parse(config.eventEndAt) + config.retentionDays * 86400000).toISOString()
      : null;
    res.json({
      driver: storage.driver,
      groups,
      reservedBytes: total,
      readyBytes: saved,
      pendingBytes: total - saved,
      capacityBytes: config.uploadCapacityBytes,
      usagePercent: Math.round((total / config.uploadCapacityBytes) * 1000) / 10,
      uploadsOpen: (await settings()).uploadGate === 'open',
      userQuotaBytes: config.uploadQuotaBytes,
      userMaxFiles: config.uploadQuotaCount,
      cdnConfigured: !!config.cdn?.origin,
      retention: {
        days: config.retentionDays,
        eventEndAt: config.eventEndAt || null,
        plannedDeleteAt,
        due: !!plannedDeleteAt && Date.now() >= Date.parse(plannedDeleteAt),
        automaticDeletion: false
      }
    });
  });
  app.put('/api/admin/storage', csrf, role('admin'), async (req, res) => {
    if (typeof req.body.uploadsOpen !== 'boolean') fail(400, '请指定是否接收新文件');
    await db.transaction(async (c) => {
      await c.query('UPDATE settings SET value=$1 WHERE key=$2', [
        req.body.uploadsOpen ? 'open' : 'paused',
        'uploadGate'
      ]);
      await audit(
        req.user.id,
        'storage.uploads',
        'platform',
        { uploadsOpen: req.body.uploadsOpen },
        c
      );
    });
    res.json({ ok: true });
  });
  app.get(
    '/api/admin/export/works',
    role('admin', 'reviewer'),
    rate('export', 5, 300),
    async (req, res) => {
      const type = competition(req.query.competition || 'film');
      const rows = (
        await db.query(
          `WITH judging AS (SELECT work_id,AVG(score) AS average,COUNT(*) AS judges FROM scores GROUP BY work_id)
      SELECT w.*,COALESCE(j.average,0) AS average,COALESCE(j.judges,0) AS judges,
      (SELECT COALESCE(MAX(votes),0) FROM works WHERE competition=$1 AND status=$2) AS max_votes
      FROM works w LEFT JOIN judging j ON j.work_id=w.id WHERE w.competition=$1 ORDER BY w.created_at,w.id`,
          [type, 'approved']
        )
      ).rows;
      const capturedAt = new Date().toISOString(),
        scoreText = (number) => (Math.round(number * 10) / 10).toFixed(1);
      const csv = [
        [
          '作品编号',
          '赛事',
          '标题',
          '创作者',
          '创作说明',
          '审核状态',
          '审核备注',
          '票数',
          '已评分评委数',
          '评委均分',
          '网络分',
          '综合分（实时）',
          '视频文件编号',
          '投稿时间',
          '统计时间'
        ],
        ...rows.map((w) => {
          const approved = w.status === 'approved',
            average = Number(w.average),
            max = Number(w.max_votes),
            network = max ? (Number(w.votes) / max) * 100 : 0;
          return [
            w.id,
            type,
            w.title,
            w.author,
            w.description,
            w.status,
            w.note,
            Number(w.votes),
            Number(w.judges),
            approved ? scoreText(average) : '',
            approved ? scoreText(network) : '',
            approved ? scoreText(average * 0.6 + network * 0.4) : '',
            w.video_id,
            new Date(Number(w.created_at)).toISOString(),
            capturedAt
          ];
        })
      ];
      await audit(req.user.id, 'work.export', type, { count: rows.length, capturedAt });
      sendCsv(res, `${type}-works.csv`, csv);
    }
  );
  app.get(
    '/api/admin/export',
    role('admin', 'reviewer'),
    rate('export', 5, 300),
    async (req, res) => {
      const type = competition(req.query.competition || 'film'),
        rows = (
          await db.query('SELECT * FROM applications WHERE competition=$1 ORDER BY created_at', [
            type
          ])
        ).rows.map(applicationView);
      const csv = [
        ['报名编号', '赛事', '姓名', '手机号', '学校 / 单位', '身份证明类型', '状态', '提交时间'],
        ...rows.map((r) => [
          r.id,
          type,
          r.payload.realName,
          r.payload.phone,
          r.payload.school,
          r.payload.idType,
          r.status,
          new Date(Number(r.created_at)).toISOString()
        ])
      ];
      await audit(req.user.id, 'application.export', type);
      sendCsv(res, `${type}-applications.csv`, csv);
    }
  );
};
