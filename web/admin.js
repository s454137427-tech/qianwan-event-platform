'use strict';
const $ = (id) => document.getElementById(id),
  esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
const label = { draft: '草稿', pending: '待审核', approved: '已通过', rejected: '退回修改' },
  roles = { admin: '管理员', reviewer: '审核员', judge: '评委' };
const state = {
  user: null,
  csrf: null,
  mode: 'applications',
  page: 1,
  overview: null,
  picked: new Set(),
  files: []
};
let toastTimer,
  listGeneration = 0;
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 5000);
}
async function api(url, method = 'GET', body) {
  const headers = {};
  if (state.csrf) headers['X-CSRF-Token'] = state.csrf;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('连接未完成，请刷新核对保存结果后重试');
  }
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(data.error || '操作失败');
  }
  return data;
}
function showLogin() {
  state.user = null;
  state.csrf = null;
  listGeneration++;
  $('adminApp').hidden = true;
  $('adminLogin').hidden = false;
  $('adminLogout').hidden = true;
}
async function refreshOverview() {
  state.overview = await api('/api/admin/overview');
  const o = state.overview;
  const count = (list, status) =>
    list.filter((r) => r.status === status).reduce((sum, r) => sum + Number(r.count), 0);
  $('stats').innerHTML = [
    { title: '待核验报名', value: count(o.applications, 'pending') },
    { title: '待审核作品', value: count(o.works, 'pending') },
    { title: '公开展示作品', value: count(o.works, 'approved') },
    { title: '已核验报名', value: count(o.applications, 'approved') }
  ]
    .map((v) => `<div class="stat-card"><span>${v.title}</span><strong>${v.value}</strong></div>`)
    .join('');
  const f = $('settingsForm');
  f.elements.registrationOpen.checked = o.settings.registrationOpen === 'true';
  f.elements.votingOpen.checked = o.settings.votingOpen === 'true';
}
function allowed(mode) {
  return {
    applications: ['admin', 'reviewer'],
    works: ['admin', 'reviewer', 'judge'],
    settings: ['admin'],
    storage: ['admin'],
    staff: ['admin'],
    audit: ['admin'],
    archive: ['admin']
  }[mode].includes(state.user.role);
}
async function openApp() {
  if (!state.user || !Object.values(roles).length || !roles[state.user.role]) return showLogin();
  $('adminLogin').hidden = true;
  $('adminApp').hidden = false;
  $('adminLogout').hidden = false;
  $('staffIdentity').textContent = `${state.user.nickname} · ${roles[state.user.role]}`;
  $('adminTabs')
    .querySelectorAll('[data-mode]')
    .forEach((b) => (b.hidden = !allowed(b.dataset.mode)));
  if (!allowed(state.mode)) state.mode = state.user.role === 'judge' ? 'works' : 'applications';
  await refreshOverview();
  await render();
}
async function render() {
  const mode = state.mode;
  $('adminTabs')
    .querySelectorAll('button')
    .forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('listPanel').hidden = !['applications', 'works'].includes(mode);
  for (const name of ['settings', 'storage', 'staff', 'audit', 'archive'])
    $(`${name}Panel`).hidden = name !== mode;
  if (['applications', 'works'].includes(mode)) return loadList();
  if (mode === 'staff')
    $('staffList').innerHTML = (await api('/api/admin/staff'))
      .map(
        (u) =>
          `<div class="staff-row"><b>${esc(u.nickname)}</b> · ${esc(u.username)} <span class="status">${roles[u.role]}</span></div>`
      )
      .join('');
  if (mode === 'storage') await renderStorage();
  if (mode === 'audit')
    $('auditList').innerHTML =
      (await api('/api/admin/audit'))
        .map(
          (r) =>
            `<p class="audit-row">${new Date(Number(r.created_at)).toLocaleString('zh-CN')} · ${esc(r.nickname)} · ${esc(r.action)}<br>${esc(r.target_id)} · ${esc(r.detail)}</p>`
        )
        .join('') || '<p class="hint">暂无操作记录。</p>';
}
async function loadList() {
  const mode = state.mode,
    type = $('adminCompetition').value,
    status = $('adminStatus').value,
    page = state.page,
    epoch = ++listGeneration;
  const data = await api(`/api/admin/${mode}?competition=${type}&status=${status}&page=${page}`);
  if (epoch !== listGeneration || mode !== state.mode || !state.user) return;
  $('exportButton').hidden = !['admin', 'reviewer'].includes(state.user.role);
  $('exportButton').href =
    mode === 'works'
      ? `api/admin/export/works?competition=${type}`
      : `api/admin/export?competition=${type}`;
  $('exportButton').textContent = mode === 'works' ? '导出全部作品 ↓' : '导出报名名单 ↓';
  const review = ['admin', 'reviewer'].includes(state.user.role),
    grade = ['admin', 'judge'].includes(state.user.role),
    canExport = ['admin', 'reviewer'].includes(state.user.role);
  // 勾选只对当前这一页有效，翻页 / 换赛事 / 换状态时清空，避免误导出。
  state.picked.clear();
  $('worksExportBar').hidden = mode !== 'works' || !canExport;
  if (mode === 'works' && canExport) updatePicked();
  $('adminRows').innerHTML = data.items.length
    ? data.items
        .map((r) => {
          let body;
          if (mode === 'applications') {
            const p = r.payload;
            body = `<h3>${esc(p.realName || '未命名草稿')}</h3><p>${esc(p.realName)} · ${esc(p.phone)} · ${esc(p.school)}</p><p>编号 ${esc(r.id)}</p><p>${esc(p.idType)} · ${esc(p.idNumber)}</p>${p.identityId ? `<a href="api/media/${p.identityId}" target="_blank" rel="noopener"><img class="identity-preview" src="api/media/${p.identityId}" alt="私有身份证明材料"></a>` : ''}`;
          } else
            body = `<h3>${esc(r.title)}</h3><p>@${esc(r.author)} · ${r.votes} 票 · 评委平均 ${Number(r.judge_score).toFixed(1)}</p>${r.theme ? `<p>参赛主题：${esc(r.theme)}</p>` : ''}<p>${esc(r.description)}</p>${r.ai_tools ? `<p>AI工具：${esc(r.ai_tools)}</p>` : ''}${r.creation_process ? `<p>创作流程：${esc(r.creation_process)}</p>` : ''}${r.videoUrl ? `<video controls preload="none" playsinline src="${r.videoUrl}"></video>` : '<p>文字 / 现场实物展示成果</p>'}`;
          return `<article class="admin-record" data-id="${r.id}"><span class="status ${r.status}">${label[r.status]}</span>${mode === 'works' && canExport ? `<label class="work-pick-row"><input type="checkbox" class="work-pick" value="${r.id}"><span>勾选</span></label>` : ''}${body}${r.note ? `<p class="hint error">退回意见：${esc(r.note)}</p>` : ''}${review && r.status !== 'draft' ? '<label>审核备注 / 退回原因<textarea class="review-note" rows="2" maxlength="500"></textarea></label><div class="actions"><button class="button small mint" data-review="approved">审核通过</button><button class="button small danger" data-review="rejected">退回修改</button></div>' : ''}${mode === 'applications' && state.user.role === 'admin' && r.user_id ? `<div class="actions"><button class="button small outline" data-reset-password="${r.user_id}">重置登录密码</button></div>` : ''}${mode === 'works' && grade && r.status === 'approved' ? `<div class="actions"><input class="score-box" type="number" min="0" max="100" step="0.1" aria-label="我的评分" value="${r.myScore ?? ''}"><button class="button small outline" data-score>保存我的评分</button></div>` : ''}</article>`;
        })
        .join('')
    : '<div class="empty"><h3>这里暂时没有记录。</h3><p>可以切换赛事或状态查看。</p></div>';
  $('adminPage').textContent =
    `${state.page} / ${Math.max(1, Math.ceil(data.total / 20))} · ${data.total} 条记录`;
  $('adminPrev').disabled = state.page <= 1;
  $('adminNext').disabled = state.page * 20 >= data.total;
}
function updatePicked() {
  const boxes = [...document.querySelectorAll('.work-pick')],
    all = $('pickAllWorks'),
    button = $('exportPickedWorks'),
    files = $('downloadPickedFiles');
  all.checked = boxes.length > 0 && boxes.every((box) => box.checked);
  all.indeterminate = !all.checked && state.picked.size > 0;
  $('pickCount').textContent = `已选 ${state.picked.size} 件`;
  button.disabled = state.picked.size === 0;
  button.textContent = state.picked.size
    ? `导出所选 ${state.picked.size} 件作品 ↓`
    : '导出所选作品 ↓';
  files.disabled = state.picked.size === 0;
  files.textContent = state.picked.size
    ? `下载所选原片 ${state.picked.size} 件 ↓`
    : '下载所选原片 ↓';
}
function saveName(name) {
  // Keep the download name legible on Windows/macOS without breaking the URL.
  return String(name || 'work').replace(/[\\/:*?"<>|]/g, '_');
}
async function openFilePanel(ids) {
  const panel = $('filePanel');
  state.files = [];
  $('fileList').innerHTML = '';
  $('filePanelSummary').textContent = '正在生成下载链接…';
  $('panelDownloadAll').disabled = true;
  if (!panel.open) panel.showModal();
  const query = new URLSearchParams({ competition: $('adminCompetition').value });
  if (ids && ids.length) query.set('ids', ids.join(','));
  try {
    const data = await api(`/api/admin/export/works-files?${query}`);
    state.files = data.items;
    $('filePanelSummary').textContent =
      `共 ${data.items.length} 个文件 · ${formatBytes(data.totalBytes)} · ` +
      (data.expiresIn ? '链接 24 小时有效' : '直接读取本地存储');
    $('fileList').innerHTML = data.items
      .map(
        (file) =>
          `<div class="file-row"><span title="${esc(file.name)}">${esc(saveName(file.name))}</span><small>${formatBytes(file.size)}</small><a class="button small outline" href="${esc(file.url)}" download="${esc(saveName(file.name))}" rel="noopener">下载 ↓</a></div>`
      )
      .join('');
    $('panelDownloadAll').disabled = false;
  } catch (e) {
    $('filePanelSummary').textContent = e.message;
  }
}
async function downloadEveryFile() {
  const files = state.files || [];
  if (!files.length) return;
  const button = $('panelDownloadAll');
  button.disabled = true;
  for (let i = 0; i < files.length; i++) {
    const link = document.createElement('a');
    link.href = files[i].url;
    link.download = saveName(files[i].name);
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    $('filePanelSummary').textContent = `正在提交下载 ${i + 1}/${files.length}…`;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  $('filePanelSummary').textContent = `已提交 ${files.length} 个文件，进度见浏览器下载列表。`;
  button.disabled = false;
}
function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  return bytes < 1024 ** 3
    ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
    : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
async function renderStorage() {
  const info = await api('/api/admin/storage');
  $('storageSummary').innerHTML = [
    { title: '已完成文件', value: formatBytes(info.readyBytes) },
    { title: '未完成上传预留', value: formatBytes(info.pendingBytes) },
    { title: '累计上传预留容量', value: formatBytes(info.reservedBytes) },
    { title: '规划容量上限', value: formatBytes(info.capacityBytes) }
  ]
    .map(
      (item) =>
        `<div class="stat-card"><span>${item.title}</span><strong class="storage-value">${item.value}</strong></div>`
    )
    .join('');
  $('storageMeter').value = Math.min(info.usagePercent, 100);
  $('storageStatus').textContent =
    `规划容量已预留 ${info.usagePercent}% · ${info.uploadsOpen ? '接收新文件' : '已暂停新文件'} · ${info.driver === 'tos' ? '火山TOS' : '本地预览存储'} · ${info.cdnConfigured ? '已配置视频CDN（需云端联调）' : '未启用视频CDN'}`;
  $('storageStatus').classList.toggle('error', info.usagePercent >= 80);
  $('storageQuota').textContent =
    `每账号累计上传额度 ${formatBytes(info.userQuotaBytes)}，最多 ${info.userMaxFiles} 个文件。超过规划上限时暂停创建新任务，已有任务仍可继续。`;
  $('uploadsOpen').checked = info.uploadsOpen;
  const retention = info.retention;
  $('storageRetention').textContent = retention.plannedDeleteAt
    ? `保留计划：活动结束后 ${retention.days} 天，计划清理时间 ${new Date(retention.plannedDeleteAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）。${retention.due ? '已经到期，请联系负责人安排清理。' : '届时由负责人安排清理。'} 当前未启用自动删除。`
    : `保留计划：活动结束后 ${retention.days} 天。活动结束日期待确认，尚未计算清理时间；当前未启用自动删除。`;
  $('storageGroups').innerHTML = info.groups.length
    ? `<div class="storage-table"><table><thead><tr><th>文件类型</th><th>状态</th><th>数量</th><th>预留容量</th></tr></thead><tbody>${info.groups.map((row) => `<tr><td>${row.kind === 'video' ? '视频' : '身份照片'}</td><td>${row.status === 'ready' ? '已完成' : '未完成'}</td><td>${row.count}</td><td>${formatBytes(row.bytes)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="hint">暂无上传任务。</p>';
}
const guarded = (fn) => async (e) => {
  try {
    await fn(e);
  } catch (error) {
    toast(error.message);
  }
};
$('adminLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const data = await api('/api/auth/admin', 'POST', {
      username: f.elements.username.value,
      password: f.elements.password.value
    });
    state.user = data.user;
    state.csrf = data.csrf;
    f.elements.password.value = '';
    await openApp();
  } catch (error) {
    $('adminLoginHint').textContent = error.message;
    $('adminLoginHint').classList.add('error');
  }
});
$('adminLogout').addEventListener(
  'click',
  guarded(async () => {
    await api('/api/auth/logout', 'POST');
    state.user = null;
    state.csrf = null;
    showLogin();
  })
);
$('adminTabs').addEventListener(
  'click',
  guarded(async (e) => {
    if (!e.target.dataset.mode) return;
    state.mode = e.target.dataset.mode;
    state.page = 1;
    await render();
  })
);
for (const id of ['adminCompetition', 'adminStatus'])
  $(id).addEventListener(
    'change',
    guarded(async () => {
      state.page = 1;
      await loadList();
    })
  );
$('adminPrev').addEventListener(
  'click',
  guarded(async () => {
    state.page--;
    await loadList();
  })
);
$('adminNext').addEventListener(
  'click',
  guarded(async () => {
    state.page++;
    await loadList();
  })
);
$('adminRows').addEventListener('change', (e) => {
  const box = e.target.closest('.work-pick');
  if (!box) return;
  if (box.checked) state.picked.add(box.value);
  else state.picked.delete(box.value);
  box.closest('.admin-record')?.classList.toggle('is-picked', box.checked);
  updatePicked();
});
$('pickAllWorks').addEventListener('change', (e) => {
  const on = e.target.checked;
  document.querySelectorAll('.work-pick').forEach((box) => {
    box.checked = on;
    if (on) state.picked.add(box.value);
    else state.picked.delete(box.value);
    box.closest('.admin-record')?.classList.toggle('is-picked', on);
  });
  updatePicked();
});
$('exportPickedWorks').addEventListener('click', () => {
  if (!state.picked.size) return toast('请先勾选要导出的作品');
  const type = $('adminCompetition').value,
    ids = [...state.picked].join(',');
  window.location.href = `api/admin/export/works?competition=${type}&ids=${encodeURIComponent(ids)}`;
});
$('downloadPickedFiles').addEventListener('click', () => {
  if (!state.picked.size) return toast('请先勾选要下载的作品');
  openFilePanel([...state.picked]);
});
$('downloadAllFiles').addEventListener('click', () => openFilePanel([]));
$('panelDownloadAll').addEventListener('click', downloadEveryFile);
$('panelCopyLinks').addEventListener('click', async () => {
  const text = (state.files || []).map((file) => `${file.name}\t${file.url}`).join('\n');
  if (!text) return toast('还没有可复制的链接');
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制全部下载链接');
  } catch {
    toast('浏览器拒绝访问剪贴板，请用单个“下载”按钮');
  }
});
$('filePanelClose').addEventListener('click', () => $('filePanel').close());
$('filePanel').addEventListener('click', (e) => {
  if (e.target === $('filePanel')) $('filePanel').close();
});
$('reloadAdmin').addEventListener(
  'click',
  guarded(async () => {
    await refreshOverview();
    await render();
    toast('数据已刷新');
  })
);
$('adminRows').addEventListener(
  'click',
  guarded(async (e) => {
    const review = e.target.closest('[data-review]'),
      score = e.target.closest('[data-score]'),
      reset = e.target.closest('[data-reset-password]');
    if (!review && !score && !reset) return;
    const card = e.target.closest('[data-id]'),
      button = review || score || reset;
    button.disabled = true;
    try {
      if (reset) {
        // 参与者无法自助找回密码，只能由管理员当面确认身份后重置。
        const password = window.prompt(
          '为该参与者设置新的登录密码（6至64位），并当面或电话告知本人。'
        );
        if (password === null) return;
        await api(`/api/admin/participants/${reset.dataset.resetPassword}/password`, 'POST', {
          password
        });
        await loadList();
        toast('登录密码已重置，该账号原有登录状态已失效');
        return;
      }
      if (review)
        await api(`/api/admin/${state.mode}/${card.dataset.id}/review`, 'POST', {
          status: review.dataset.review,
          note: card.querySelector('.review-note').value
        });
      else
        await api(`/api/admin/works/${card.dataset.id}/score`, 'POST', {
          score: card.querySelector('.score-box').value
        });
      await refreshOverview();
      await loadList();
      toast(score ? '评分已保存' : '审核结果已保存');
    } finally {
      button.disabled = false;
    }
  })
);
$('settingsForm').addEventListener(
  'submit',
  guarded(async (e) => {
    e.preventDefault();
    const f = e.target;
    await api('/api/admin/settings', 'PUT', {
      registrationOpen: f.elements.registrationOpen.checked,
      votingOpen: f.elements.votingOpen.checked
    });
    await refreshOverview();
    toast('活动设置已保存');
  })
);
$('staffForm').addEventListener(
  'submit',
  guarded(async (e) => {
    e.preventDefault();
    const f = e.target;
    await api('/api/admin/staff', 'POST', Object.fromEntries(new FormData(f)));
    f.reset();
    await render();
    toast('工作人员账号已创建');
  })
);
$('storageForm').addEventListener(
  'submit',
  guarded(async (e) => {
    e.preventDefault();
    const button = e.target.querySelector('button');
    button.disabled = true;
    try {
      await api('/api/admin/storage', 'PUT', { uploadsOpen: $('uploadsOpen').checked });
      await renderStorage();
      toast('上传设置已保存');
    } finally {
      button.disabled = false;
    }
  })
);
$('archivePanel').addEventListener(
  'click',
  guarded(async (event) => {
    const button = event.target.closest('[data-archive]');
    if (!button || button.disabled) return;
    const buttons = $('archivePanel').querySelectorAll('[data-archive]');
    buttons.forEach((b) => (b.disabled = true));
    const scope = button.dataset.archive;
    $('archiveStatus').textContent = '正在生成归档，请稍候…';
    try {
      const response = await fetch(`/api/admin/export/archive?scope=${scope}`, {
        signal: AbortSignal.timeout(60000)
      });
      if (!response.ok) {
        if (response.status === 401) showLogin();
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || '归档生成失败，请稍后重试');
      }
      if (!response.headers.get('Content-Type')?.startsWith('application/zip'))
        throw new Error('归档未完成，请重新登录后重试');
      const blob = await response.blob();
      if (!blob.size) throw new Error('归档文件为空，请稍后重试');
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download =
        response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ||
        `qianwan-film-${scope}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      $('archiveStatus').textContent =
        `${scope === 'client' ? '甲方备案包' : '内部留存包'}已生成并发起下载，请在浏览器下载列表查看。`;
    } catch (error) {
      $('archiveStatus').textContent =
        error.name === 'TimeoutError'
          ? '生成等待超时，请稍后重试；较大规模数据请联系负责人安排数据库备份。'
          : error.message;
      throw new Error($('archiveStatus').textContent);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  })
);
(async () => {
  const config = await api('/api/config');
  $('previewBar').hidden = !config.preview;
  const session = await api('/api/session');
  state.user = session.user;
  state.csrf = session.csrf;
  if (config.preview)
    $('adminLoginHint').textContent =
      '本机初始账号信息保存在项目 var 文件夹的“本地后台登录.txt”中。';
  await openApp();
})().catch((error) => toast(error.message));
