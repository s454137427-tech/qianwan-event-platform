const path = require('node:path');
const multer = require('multer');
module.exports = function register(ctx) {
  const {
    app,
    db,
    config,
    storage,
    one,
    auth,
    csrf,
    rate,
    settings,
    lockUser,
    competition,
    deadline,
    applicationView,
    publicUser,
    ownUpload,
    fail,
    text,
    uid,
    staff
  } = ctx;
  app.post('/api/uploads', auth, csrf, rate('upload-create', 30), async (req, res) => {
    const kind = req.body.kind,
      filename = text(req.body.filename, 160),
      size = Number(req.body.size),
      fingerprint = text(req.body.fingerprint, 200);
    if (
      !['video', 'identity'].includes(kind) ||
      !filename ||
      !fingerprint ||
      !Number.isSafeInteger(size) ||
      size < 12 ||
      size > (kind === 'video' ? config.videoLimit : 5 * 1024 ** 2)
    )
      fail(400, '文件类型或大小不正确');
    if (
      !(kind === 'video' ? ['.mp4', '.mov', '.webm'] : ['.jpg', '.jpeg', '.png']).includes(
        path.extname(filename).toLowerCase()
      )
    )
      fail(400, '视频支持MP4/MOV/WebM，照片支持JPG/PNG');
    const task = await db.transaction(async (c) => {
      // Serialize capacity reservation across application instances. Existing tasks
      // remain resumable when new uploads are paused or the capacity has been reached.
      await c.query('UPDATE settings SET value=value WHERE key=$1', ['uploadGate']);
      await lockUser(c, req.user.id);
      const old = await one(
        'SELECT * FROM uploads WHERE user_id=$1 AND fingerprint=$2 AND kind=$3 AND size=$4 ORDER BY created_at DESC LIMIT 1',
        [req.user.id, fingerprint, kind, size],
        c
      );
      if (old) return old;
      if (
        (await one('SELECT value FROM settings WHERE key=$1', ['uploadGate'], c)).value !== 'open'
      )
        fail(503, '新文件上传暂时暂停，已开始的上传可以继续，请稍后再试');
      const total = Number(
        (await one('SELECT COALESCE(SUM(size),0) AS bytes FROM uploads', [], c)).bytes
      );
      if (total + size > config.uploadCapacityBytes)
        fail(503, '当前上传容量已达到规划额度，请联系工作人员');
      const quota = await one(
        'SELECT COALESCE(SUM(size),0) AS bytes,COUNT(*) AS count FROM uploads WHERE user_id=$1',
        [req.user.id],
        c
      );
      if (
        Number(quota.bytes) + size > config.uploadQuotaBytes ||
        Number(quota.count) >= config.uploadQuotaCount
      )
        fail(400, '上传额度已用完，请联系工作人员');
      const id = uid(),
        objectKey = `private/${req.user.id}/${id}${path.extname(filename).toLowerCase()}`;
      await c.query(
        'INSERT INTO uploads(id,user_id,kind,filename,mime,size,fingerprint,object_key,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          id,
          req.user.id,
          kind,
          filename,
          text(req.body.mime, 80),
          size,
          fingerprint,
          objectKey,
          'uploading',
          Date.now()
        ]
      );
      return one('SELECT * FROM uploads WHERE id=$1', [id], c);
    });
    res.json({
      id: task.id,
      status: task.status,
      driver: storage.driver,
      parts: await storage.parts(task),
      chunkSize: config.chunkSize,
      totalChunks: Math.ceil(size / config.chunkSize)
    });
  });
  app.get('/api/uploads/:id', auth, async (req, res) => {
    const task = await ownUpload(req.params.id, req.user.id);
    res.json({
      id: task.id,
      status: task.status,
      size: Number(task.size),
      parts: await storage.parts(task)
    });
  });
  app.post(
    '/api/uploads/:id/credentials',
    auth,
    csrf,
    rate('upload-credentials', 30),
    async (req, res) => {
      const task = await ownUpload(req.params.id, req.user.id);
      if (storage.driver !== 'cos' || task.status !== 'uploading') fail(400, '当前任务无需云上传');
      res.json(await storage.credentials(task));
    }
  );
  const chunk = multer({
    storage: multer.memoryStorage(),
    limits: { files: 1, fields: 0, fileSize: config.chunkSize }
  }).single('chunk');
  app.post(
    '/api/uploads/:id/chunks/:index',
    auth,
    csrf,
    rate('upload-chunk', 600),
    async (req, res, next) => {
      const task = await ownUpload(req.params.id, req.user.id),
        index = Number(req.params.index);
      if (
        storage.driver !== 'local' ||
        task.status !== 'uploading' ||
        !/^\d+$/.test(req.params.index) ||
        !Number.isSafeInteger(index)
      )
        fail(400, '任务或分片编号不正确');
      req.uploadTask = task;
      next();
    },
    chunk,
    async (req, res) => {
      if (!req.file) fail(400, '没有收到分片');
      await storage.putPart(req.uploadTask, Number(req.params.index), req.file.buffer);
      res.json({ ok: true });
    }
  );
  app.post(
    '/api/uploads/:id/complete',
    auth,
    csrf,
    rate('upload-complete', 30),
    async (req, res) => {
      const id = req.params.id;
      await ownUpload(id, req.user.id);
      await db.transaction(async (c) => {
        const task = await one(
          `SELECT * FROM uploads WHERE id=$1 AND user_id=$2${c.dialect === 'postgres' ? ' FOR UPDATE' : ''}`,
          [id, req.user.id],
          c
        );
        if (!task) fail(404, '上传任务不存在');
        if (task.status === 'ready') return;
        const result = await storage.complete(task),
          mime = typeof result === 'string' ? result : result.mime;
        await c.query('UPDATE uploads SET status=$1,mime=$2,object_key=$3 WHERE id=$4', [
          'ready',
          mime,
          typeof result === 'string' ? task.object_key : result.objectKey,
          task.id
        ]);
      });
      res.json({ ok: true, id });
    }
  );
  app.put(
    '/api/applications/:competition',
    auth,
    csrf,
    rate('application', 30),
    async (req, res) => {
      const type = competition(req.params.competition);
      deadline('registration');
      deadline(type);
      if ((await settings()).registrationOpen !== 'true') fail(400, '报名暂未开放');
      const p = req.body.payload || {},
        submit = req.body.submit === true;
      const payload = {
        realName: text(p.realName, 60),
        phone: text(p.phone, 30),
        school: text(p.school, 120),
        idType: text(p.idType, 20),
        idNumber: text(p.idNumber, 80),
        identityId: text(p.identityId, 40),
        consent: p.consent === true
      };
      if (submit) {
        if (!payload.realName || !/^1[3-9]\d{9}$/.test(payload.phone) || !payload.consent)
          fail(400, '请填写姓名、有效手机号并同意材料使用说明');
        if (type === 'film') {
          if (!payload.idType || !payload.idNumber || !payload.identityId)
            fail(400, '请完整填写身份材料');
          if ((await ownUpload(payload.identityId, req.user.id, true)).kind !== 'identity')
            fail(400, '身份照片不正确');
        }
      }
      const result = await db.transaction(async (c) => {
        await lockUser(c, req.user.id);
        const old = await one(
          'SELECT * FROM applications WHERE user_id=$1 AND competition=$2',
          [req.user.id, type],
          c
        );
        if (old && ['approved', 'pending'].includes(old.status))
          fail(400, '已提交资料不可直接修改，请联系工作人员');
        const id = old?.id || uid(),
          now = Date.now(),
          status = submit ? 'pending' : 'draft',
          seats = 1;
        if (old)
          await c.query(
            'UPDATE applications SET payload=$1,status=$2,note=$3,seat_count=$4,updated_at=$5 WHERE id=$6',
            [JSON.stringify(payload), status, '', seats, now, id]
          );
        else
          await c.query(
            'INSERT INTO applications(id,user_id,competition,payload,status,seat_count,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [id, req.user.id, type, JSON.stringify(payload), status, seats, now, now]
          );
        return applicationView(await one('SELECT * FROM applications WHERE id=$1', [id], c));
      });
      res.json({ ok: true, application: result });
    }
  );
  app.get('/api/me', auth, async (req, res) =>
    res.json({
      user: publicUser(req.user),
      applications: (
        await db.query(
          "SELECT * FROM applications WHERE user_id=$1 AND competition='film' ORDER BY created_at DESC",
          [req.user.id]
        )
      ).rows.map(applicationView),
      works: (
        await db.query(
          "SELECT * FROM works WHERE user_id=$1 AND competition='film' ORDER BY created_at DESC",
          [req.user.id]
        )
      ).rows,
      votes: (
        await db.query(
          "SELECT work_id,competition FROM votes WHERE user_id=$1 AND competition='film'",
          [req.user.id]
        )
      ).rows
    })
  );
  app.post('/api/works', auth, csrf, rate('work-submit', 30), async (req, res) => {
    const type = competition(req.body.competition),
      title = text(req.body.title, 100),
      author = text(req.body.author, 60),
      description = text(req.body.description, 3000),
      key = text(req.body.submissionKey, 100);
    deadline('film');
    if (!title || !author || !key) fail(400, '请填写作品标题和创作者名称');
    if ((await settings()).registrationOpen !== 'true') fail(400, '投稿暂未开放');
    const work = await db.transaction(async (c) => {
      await lockUser(c, req.user.id);
      const old = await one(
        'SELECT * FROM works WHERE user_id=$1 AND submission_key=$2',
        [req.user.id, key],
        c
      );
      if (old) {
        competition(old.competition);
        return old;
      }
      const application = await one(
        'SELECT * FROM applications WHERE user_id=$1 AND competition=$2',
        [req.user.id, type],
        c
      );
      if (!application || !['pending', 'approved'].includes(application.status))
        fail(400, '请先提交该赛事报名资料');
      if (
        Number(
          (
            await one(
              'SELECT COUNT(*) AS count FROM works WHERE user_id=$1 AND competition=$2',
              [req.user.id, type],
              c
            )
          ).count
        ) >= 10
      )
        fail(400, '已达到投稿数量上限');
      const video = req.body.videoId || null;
      if (!video) fail(400, '请先上传影像作品');
      if (video) {
        if ((await ownUpload(video, req.user.id, true, c)).kind !== 'video')
          fail(400, '视频类型不正确');
        if (await one('SELECT id FROM works WHERE video_id=$1', [video], c))
          fail(400, '此视频已提交，请勿重复投稿');
      }
      const id = uid(),
        now = Date.now();
      await c.query(
        'INSERT INTO works(id,user_id,competition,title,author,description,video_id,status,created_at,updated_at,submission_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [id, req.user.id, type, title, author, description, video, 'pending', now, now, key]
      );
      return one('SELECT * FROM works WHERE id=$1', [id], c);
    });
    res.json({ ok: true, work });
  });
  app.put('/api/works/:id', auth, csrf, rate('work-resubmit', 20), async (req, res) => {
    const work = await db.transaction(async (c) => {
      await lockUser(c, req.user.id);
      const old = await one(
        'SELECT * FROM works WHERE id=$1 AND user_id=$2',
        [req.params.id, req.user.id],
        c
      );
      if (!old || old.status !== 'rejected') fail(400, '仅退回作品可以修改');
      competition(old.competition);
      deadline('film');
      if (
        (await one('SELECT value FROM settings WHERE key=$1', ['registrationOpen'], c)).value !==
        'true'
      )
        fail(400, '投稿暂未开放');
      const title = text(req.body.title, 100),
        author = text(req.body.author, 60),
        description = text(req.body.description, 3000),
        video = req.body.videoId || old.video_id;
      if (!title || !author) fail(400, '请填写标题和创作者名称');
      if (video) {
        if ((await ownUpload(video, req.user.id, true, c)).kind !== 'video')
          fail(400, '视频类型不正确');
        if (await one('SELECT id FROM works WHERE video_id=$1 AND id<>$2', [video, old.id], c))
          fail(400, '此视频已用于其他作品');
      }
      await c.query(
        'UPDATE works SET title=$1,author=$2,description=$3,video_id=$4,status=$5,note=$6,updated_at=$7 WHERE id=$8',
        [title, author, description, video, 'pending', '', Date.now(), old.id]
      );
      return one('SELECT * FROM works WHERE id=$1', [old.id], c);
    });
    res.json({ ok: true, work });
  });
  app.get('/api/works', rate('wall', 20000), async (req, res) => {
    const type = competition(req.query.competition || 'film'),
      page = Math.max(1, Math.min(10000, Math.floor(Number(req.query.page) || 1))),
      max = Number(
        (
          await one(
            'SELECT COALESCE(MAX(votes),0) AS max FROM works WHERE competition=$1 AND status=$2',
            [type, 'approved']
          )
        ).max
      );
    const order =
      'COALESCE((SELECT AVG(score) FROM scores WHERE work_id=w.id),0)*0.6 + w.votes*1.0/$3*40';
    const rows = (
      await db.query(
        `SELECT w.id,w.title,w.author,w.description,w.video_id,w.votes,w.competition,COALESCE((SELECT AVG(score) FROM scores WHERE work_id=w.id),0) AS judge_score FROM works w WHERE competition=$1 AND status=$2 ORDER BY ${order} DESC,w.created_at ASC,w.id ASC LIMIT $4 OFFSET $5`,
        [type, 'approved', Math.max(1, max), 12, (page - 1) * 12]
      )
    ).rows;
    const total = Number(
      (
        await one('SELECT COUNT(*) AS count FROM works WHERE competition=$1 AND status=$2', [
          type,
          'approved'
        ])
      ).count
    );
    res.json({
      items: rows.map((w) => {
        const judge = Number(w.judge_score),
          net = max ? (w.votes / max) * 100 : 0;
        return {
          id: w.id,
          competition: type,
          title: w.title,
          author: w.author,
          description: w.description,
          votes: Number(w.votes),
          videoUrl: w.video_id ? `/api/media/${w.video_id}` : null,
          judgeScore: Math.round(judge * 10) / 10,
          networkScore: Math.round(net * 10) / 10,
          finalScore: Math.round((judge * 0.6 + net * 0.4) * 10) / 10
        };
      }),
      total,
      page,
      pageSize: 12
    });
  });
  app.post('/api/votes/:id', auth, csrf, rate('vote', 30), async (req, res) => {
    deadline('vote');
    const result = await db.transaction(async (c) => {
      await lockUser(c, req.user.id);
      if (
        (await one('SELECT value FROM settings WHERE key=$1', ['votingOpen'], c)).value !== 'true'
      )
        fail(400, '投票暂未开放');
      const work = await one(
        `SELECT * FROM works WHERE id=$1 AND status=$2${c.dialect === 'postgres' ? ' FOR UPDATE' : ''}`,
        [req.params.id, 'approved'],
        c
      );
      if (!work) fail(404, '作品尚未上墙');
      competition(work.competition);
      if (
        await one('SELECT id FROM votes WHERE user_id=$1 AND work_id=$2', [req.user.id, work.id], c)
      )
        return { ok: true, duplicate: true, votes: Number(work.votes) };
      await c.query(
        'INSERT INTO votes(id,user_id,work_id,competition,created_at) VALUES($1,$2,$3,$4,$5)',
        [uid(), req.user.id, work.id, work.competition, Date.now()]
      );
      await c.query('UPDATE works SET votes=votes+1 WHERE id=$1', [work.id]);
      return {
        ok: true,
        duplicate: false,
        votes: Number((await one('SELECT votes FROM works WHERE id=$1', [work.id], c)).votes)
      };
    });
    res.json(result);
  });
  app.get('/api/media/:id', async (req, res) => {
    if (!/^[a-f0-9-]{36}$/.test(req.params.id)) fail(404, '文件不存在');
    const task = await one('SELECT * FROM uploads WHERE id=$1 AND status=$2', [
      req.params.id,
      'ready'
    ]);
    if (!task) fail(404, '文件不存在');
    const permitted =
      req.user &&
      (task.user_id === req.user.id ||
        (task.kind === 'identity'
          ? ['admin', 'reviewer'].includes(req.user.role)
          : staff.includes(req.user.role)));
    const published =
      task.kind === 'video' &&
      !!(await one("SELECT id FROM works WHERE video_id=$1 AND status=$2 AND competition='film'", [
        task.id,
        'approved'
      ]));
    if (!permitted && !published) fail(403, '文件未公开或无访问权限');
    res.set('Cache-Control', 'private, no-store');
    if (storage.driver === 'cos')
      return res.redirect(
        (published && storage.publishedVideoUrl(task)) || (await storage.signedUrl(task))
      );
    res.type(task.mime).sendFile(storage.location(task));
  });
};
