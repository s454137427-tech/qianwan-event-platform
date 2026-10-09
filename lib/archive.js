'use strict';
const { deflateRaw } = require('node:zlib');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { encodeCsv } = require('./csv');
const compress = promisify(deflateRaw);
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  return crc >>> 0;
});
const MAX_ROWS = 100000;
const MAX_BYTES = 64 * 1024 * 1024;
const statuses = {
  draft: '草稿',
  pending: '待审核',
  approved: '已通过',
  rejected: '退回修改',
  uploading: '上传中',
  ready: '已完成'
};
const roles = { admin: '管理员', reviewer: '审核员', judge: '评委', participant: '参与者' };
const actions = {
  'application.review': '报名核验',
  'work.review': '作品审核',
  'work.score': '评委评分',
  'settings.update': '活动设置',
  'storage.update': '上传设置',
  'staff.create': '新增工作人员',
  'application.export': '导出报名名单',
  'work.export': '导出作品成绩',
  'archive.export': '导出活动归档'
};
function parse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function beijing(value) {
  if (value === '' || value == null) return '';
  const date = new Date(typeof value === 'string' && !/^\d+$/.test(value) ? value : Number(value));
  return Number.isNaN(date.getTime())
    ? ''
    : new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
// A bounded ZIP archive of UTF-8 files; compression runs in the worker pool.
async function zip(files) {
  const parts = [],
    central = [];
  const now = new Date(Date.now() + 8 * 3600000);
  const dosDate =
    ((now.getUTCFullYear() - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate();
  const dosTime =
    (now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | (now.getUTCSeconds() >> 1);
  let offset = 0,
    bytes = 0;
  for (const file of files) {
    const name = Buffer.from(file.name),
      raw = Buffer.from(file.content);
    bytes += raw.length;
    if (bytes > MAX_BYTES)
      throw Object.assign(new Error('归档数据超过64MB，请联系负责人安排数据库备份导出'), {
        status: 413
      });
    const packed = await compress(raw),
      crc = crc32(raw),
      header = Buffer.alloc(30),
      entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(dosTime, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(header, name, packed);
    central.push(entry, name);
    offset += header.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
async function capture(db) {
  return db.transaction(async (c) => {
    if (c.dialect === 'postgres') await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const queries = {
      applications: "SELECT * FROM applications WHERE competition='film' ORDER BY created_at,id",
      works: "SELECT * FROM works WHERE competition='film' ORDER BY created_at,id",
      scores:
        "SELECT s.*,u.nickname,u.role FROM scores s JOIN works w ON w.id=s.work_id JOIN users u ON u.id=s.judge_id WHERE w.competition='film' ORDER BY s.work_id,s.judge_id",
      votes:
        "SELECT v.id,v.user_id,v.work_id,v.created_at FROM votes v JOIN works w ON w.id=v.work_id WHERE v.competition='film' AND w.competition='film' ORDER BY v.created_at,v.id",
      audit:
        "SELECT a.*,u.nickname,u.role FROM audit a JOIN users u ON u.id=a.actor_id WHERE a.target_id IN (SELECT id FROM applications WHERE competition='film') OR a.target_id IN (SELECT id FROM works WHERE competition='film') OR a.target_id IN ('film','platform') OR a.action='staff.create' ORDER BY a.created_at,a.id"
    };
    const data = { capturedAt: null },
      counts = {};
    let total = 0;
    for (const [key, sql] of Object.entries(queries)) {
      counts[key] = Number(
        (await c.query(`SELECT COUNT(*) AS count FROM (${sql}) source`)).rows[0].count
      );
      if (!data.capturedAt) data.capturedAt = new Date().toISOString();
      total += counts[key];
      if (total > MAX_ROWS)
        throw Object.assign(new Error('归档记录超过10万条，请联系负责人安排数据库备份导出'), {
          status: 413
        });
    }
    const estimated =
      Number(
        (
          await c.query(`SELECT
      COALESCE((SELECT SUM(LENGTH(payload)+LENGTH(note)+300) FROM applications WHERE competition='film'),0)
      + COALESCE((SELECT SUM(LENGTH(title)+LENGTH(author)+LENGTH(description)+LENGTH(note)+500) FROM works WHERE competition='film'),0)
      + COALESCE((SELECT SUM(LENGTH(detail)+500) FROM (${queries.audit}) archive_audit),0) AS bytes`)
        ).rows[0].bytes
      ) *
        4 +
      total * 256;
    if (estimated > MAX_BYTES)
      throw Object.assign(new Error('归档数据过大，请联系负责人安排数据库备份导出'), {
        status: 413
      });
    for (const [key, sql] of Object.entries(queries)) data[key] = (await c.query(sql)).rows;
    // Include only files linked to this event, not unrelated uploads or cancelled-event material.
    const ids = new Set(data.works.map((w) => w.video_id).filter(Boolean));
    for (const a of data.applications) {
      const id = parse(a.payload).identityId;
      if (typeof id === 'string') ids.add(id);
    }
    data.files = [];
    const wanted = [...ids];
    for (let i = 0; i < wanted.length; i += 300) {
      const batch = wanted.slice(i, i + 300);
      data.files.push(
        ...(
          await c.query(
            `SELECT id,kind,filename,mime,size,status,object_key,created_at FROM uploads WHERE id IN (${batch.map((_, n) => `$${n + 1}`).join(',')}) ORDER BY created_at,id`,
            batch
          )
        ).rows
      );
    }
    data.settings = Object.fromEntries(
      (await c.query('SELECT key,value FROM settings')).rows.map((r) => [r.key, r.value])
    );
    return data;
  });
}
function buildFiles(data, scope, config, actor) {
  const internal = scope === 'internal',
    at = beijing(data.capturedAt),
    name = 'AI 不喊 CUT · 未来影像大赛';
  const files = [],
    records = {};
  let bytes = 0;
  function table(filename, headers, rows) {
    const content = encodeCsv([headers, ...rows]);
    bytes += Buffer.byteLength(content);
    if (bytes > MAX_BYTES)
      throw Object.assign(new Error('归档数据超过64MB，请联系负责人安排数据库备份导出'), {
        status: 413
      });
    files.push({ name: filename, content });
    records[filename] = rows.length;
  }
  const approved = data.works.filter((w) => w.status === 'approved'),
    max = approved.reduce((n, w) => Math.max(n, Number(w.votes)), 0);
  const applicationsByUser = new Map(data.applications.map((a) => [a.user_id, a.id]));
  const grades = new Map();
  for (const s of data.scores) {
    const g = grades.get(s.work_id) || { sum: 0, count: 0 };
    g.sum += Number(s.score);
    g.count++;
    grades.set(s.work_id, g);
  }
  const count = (rows, status) => rows.filter((r) => r.status === status).length;
  const summary = [
    ['网站名称', '前湾印象城MEGA'],
    ['活动名称', name],
    ['导出用途', internal ? '内部留存（含个人信息）' : '甲方备案（脱敏）'],
    ['统计时间（北京时间）', at],
    ['导出版本', require('../package.json').version],
    ['导出人员', internal ? actor.nickname : actor.id],
    ['报名记录总数（含草稿）', data.applications.length],
    ['已提交报名数（不含草稿）', data.applications.filter((a) => a.status !== 'draft').length],
    ...['draft', 'pending', 'approved', 'rejected'].map((s) => [
      `报名：${statuses[s]}`,
      count(data.applications, s)
    ]),
    ['作品总数', data.works.length],
    ...['pending', 'approved', 'rejected'].map((s) => [
      `作品：${statuses[s]}`,
      count(data.works, s)
    ]),
    ['投票记录数', data.votes.length],
    ['投票参与账号数', new Set(data.votes.map((v) => v.user_id)).size],
    ['作品累计票数（计数器）', data.works.reduce((n, w) => n + Number(w.votes), 0)],
    ['评委评分记录数', data.scores.length],
    ['已评分作品数', grades.size],
    ['评分人员数', new Set(data.scores.map((s) => s.judge_id)).size],
    ['关联视频数', data.files.filter((f) => f.kind === 'video').length],
    ['关联身份证明数', data.files.filter((f) => f.kind === 'identity').length],
    ['报名与投稿开关', data.settings.registrationOpen === 'true' ? '开放' : '关闭'],
    ['投票开关', data.settings.votingOpen === 'true' ? '开放' : '关闭'],
    ['报名截止（北京时间）', beijing(config.deadlines.registration)],
    ['投稿截止（北京时间）', beijing(config.deadlines.film)],
    ['投票截止（北京时间）', beijing(config.deadlines.vote)],
    ['活动结束（北京时间）', beijing(config.eventEndAt)],
    ['配置的保留天数', config.retentionDays],
    ['成绩性质', '截至统计时间的实时成绩，不代表最终获奖结果']
  ];
  table('01-活动汇总.csv', ['项目', '数值'], summary);
  table(
    '02-报名与审核.csv',
    [
      '报名编号',
      '参与账号编号',
      '姓名',
      '手机号',
      '学校或单位',
      '身份证明类型',
      ...(internal ? ['证件号码', '身份证明文件编号', '审核备注'] : []),
      '报名状态',
      '已勾选参赛同意',
      '首次建档时间（北京时间）',
      '最后更新时间（北京时间）'
    ],
    data.applications.map((a) => {
      const p = parse(a.payload),
        realName = String(p.realName || ''),
        phone = String(p.phone || '');
      return [
        a.id,
        a.user_id,
        internal ? realName : realName ? `${[...realName][0]}**` : '',
        internal
          ? phone
          : /^1\d{10}$/.test(phone)
            ? `${phone.slice(0, 3)}****${phone.slice(-4)}`
            : phone
              ? '***'
              : '',
        p.school,
        p.idType,
        ...(internal ? [p.idNumber, p.identityId, a.note] : []),
        statuses[a.status] || a.status,
        p.consent === true ? '是' : '否',
        beijing(a.created_at),
        beijing(a.updated_at)
      ];
    })
  );
  const rounded = (n) => (Math.round(n * 10) / 10).toFixed(1);
  table(
    '03-作品与成绩.csv',
    [
      '作品编号',
      '报名编号',
      '参与账号编号',
      '作品标题',
      '创作者',
      '创作说明',
      '审核状态',
      ...(internal ? ['审核备注'] : []),
      '票数',
      '已评分人数',
      '评委均分',
      '网络分',
      '综合分（实时）',
      '评分进度',
      '视频文件编号',
      '首次投稿时间（北京时间）',
      '最后更新时间（北京时间）'
    ],
    data.works.map((w) => {
      const g = grades.get(w.id) || { sum: 0, count: 0 },
        average = g.count ? g.sum / g.count : 0,
        network = max ? (Number(w.votes) / max) * 100 : 0,
        published = w.status === 'approved';
      return [
        w.id,
        applicationsByUser.get(w.user_id) || '',
        w.user_id,
        w.title,
        w.author,
        w.description,
        statuses[w.status] || w.status,
        ...(internal ? [w.note] : []),
        Number(w.votes),
        g.count,
        published ? rounded(average) : '',
        published ? rounded(network) : '',
        published ? rounded(average * 0.6 + network * 0.4) : '',
        g.count ? '已有评分' : '尚无评委评分',
        w.video_id,
        beijing(w.created_at),
        beijing(w.updated_at)
      ];
    })
  );
  table(
    '04-评委评分.csv',
    [
      '作品编号',
      '评分人员编号',
      ...(internal ? ['评分人员姓名'] : []),
      '人员角色',
      '分数',
      '评分更新时间（北京时间）'
    ],
    data.scores.map((s) => [
      s.work_id,
      s.judge_id,
      ...(internal ? [s.nickname] : []),
      roles[s.role] || s.role,
      Number(s.score),
      beijing(s.updated_at)
    ])
  );
  table(
    '05-投票记录.csv',
    ['投票编号', '作品编号', '投票账号编号', '投票时间（北京时间）'],
    data.votes.map((v) => [v.id, v.work_id, v.user_id, beijing(v.created_at)])
  );
  table(
    '06-关联文件清单.csv',
    [
      '文件编号',
      '文件类型',
      ...(internal ? ['原文件名', '存储对象路径'] : []),
      '文件格式',
      '大小（字节）',
      '上传状态',
      '创建时间（北京时间）'
    ],
    data.files
      .filter((f) => internal || f.kind === 'video')
      .map((f) => [
        f.id,
        f.kind === 'video' ? '作品视频' : '身份证明',
        ...(internal ? [f.filename, f.object_key] : []),
        f.mime,
        Number(f.size),
        statuses[f.status] || f.status,
        beijing(f.created_at)
      ])
  );
  table(
    '07-操作记录.csv',
    [
      '操作编号',
      '操作人编号',
      ...(internal ? ['操作人姓名'] : []),
      '人员角色',
      '操作类型',
      '关联编号',
      '操作说明',
      '操作时间（北京时间）'
    ],
    data.audit.map((a) => {
      const detail = parse(a.detail),
        safe = Object.fromEntries(
          Object.entries(detail).filter(([key]) =>
            [
              'status',
              'score',
              'count',
              'scope',
              'capturedAt',
              'registrationOpen',
              'votingOpen',
              'uploadGate',
              'role',
              ...(internal ? ['note', 'records'] : [])
            ].includes(key)
          )
        );
      return [
        a.id,
        a.actor_id,
        ...(internal ? [a.nickname] : []),
        roles[a.role] || a.role,
        actions[a.action] || a.action,
        a.target_id,
        JSON.stringify(safe),
        beijing(a.created_at)
      ];
    })
  );
  files.push({
    name: '归档说明.txt',
    content: `前湾印象城MEGA · 活动数据归档\r\n活动：${name}\r\n用途：${internal ? '内部留存（含个人信息，请由授权负责人保管）' : '甲方备案（姓名和手机号脱敏；不含证件号码、证明文件和私有存储路径）'}\r\n统计时间：${at}（北京时间 UTC+8）\r\n来源：本平台数据库的一致性快照；包含本活动全部状态，不受后台列表筛选影响。\r\n表格为UTF-8 CSV，解压后可用Excel打开；手机号、证件号码请以“文本”列导入，避免长数字被改写。\r\n首次建档时间不是最终提交时间；评分表仅保留每位评分人员的最新分数，修改过程可查操作记录。\r\n网络分=作品票数/已通过作品最高票数×100（最高票数为0时取0）；综合分=评委均分×60%+网络分×40%，展示四舍五入至1位小数。无评委评分时均分按0计算并标注评分进度，未通过作品不显示成绩。\r\n成绩为导出时的实时记录，不是正式封榜或获奖名单；活动结束后请先关闭报名投稿和投票，并完成全部评分，再导出备案。\r\n投票记录数和作品累计票数单独保留，便于核对。账号编号用于跨表关联，不含微信身份标识。\r\n操作记录包含活动关联及全局管理记录，不仅是页面最近100条；本次导出记录在生成文件后写入，后续归档可见。\r\n文件清单仅列本活动关联文件，未关联的上传不包含。视频和证明原文件不在此包内，请另行备份数据库与私有存储。\r\n甲方版保留作品内容，分享前请人工核对创作者自行填写的文本。内部版含审核备注、证件号码和存储路径，但没有密码、登录令牌或云密钥。\r\n校验清单.json记录各文件的SHA256值，用于后续核对文件是否变更。\r\n`
  });
  files.push({
    name: '校验清单.json',
    content: JSON.stringify(
      {
        version: 1,
        competition: 'film',
        scope,
        capturedAt: data.capturedAt,
        recordCounts: records,
        files: files.map((f) => ({
          name: f.name,
          sha256: createHash('sha256').update(f.content).digest('hex')
        }))
      },
      null,
      2
    )
  });
  return { files, records };
}
module.exports = { capture, buildFiles, zip };
