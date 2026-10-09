'use strict';
const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const labels = { draft: '草稿', pending: '待审核', approved: '已通过', rejected: '退回修改' };
const events = { film: 'AI 不喊 CUT · 未来影像大赛' };
const state = {
  config: null,
  user: null,
  csrf: null,
  me: null,
  event: 'film',
  wall: 'film',
  page: 1,
  editWork: null,
  submissionKey: null,
  busy: false,
  paused: false,
  uploadCancel: null
};
let toastTimer, saveTimer;
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 4500);
}
function hint(id, message, error = false) {
  $(id).textContent = message;
  $(id).classList.toggle('error', error);
}
async function api(url, { method = 'GET', body, signal } = {}) {
  const headers = {};
  if (state.csrf) headers['X-CSRF-Token'] = state.csrf;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const response = await fetch(url, { method, headers, body, signal });
  const data = await response.json().catch(() => ({ error: '服务响应异常，请重试' }));
  if (!response.ok) {
    const e = new Error(data.error || '操作失败');
    e.status = response.status;
    if (response.status === 401) {
      state.user = null;
      state.csrf = null;
      updateLogin();
    }
    throw e;
  }
  return data;
}
function updateLogin() {
  const button = $('loginButton');
  button.replaceChildren();
  if (state.user?.avatar) {
    const image = document.createElement('img');
    image.src = state.user.avatar;
    image.alt = '';
    image.className = 'login-avatar';
    image.addEventListener('error', () => image.remove(), { once: true });
    button.append(image);
  }
  const label = document.createElement('span');
  label.textContent = state.user ? `${state.user.nickname} · 退出` : '微信扫码登录 ↗';
  button.append(label);
  $('previewBar').hidden = !state.config?.preview;
}
function requireLogin() {
  if (state.user) return true;
  showLogin();
  return false;
}
function showLogin() {
  if (!state.config) return toast('登录入口正在加载，请稍后重试。');
  const returnTo = ['home', 'participate', 'wall', 'account'].includes(location.hash.slice(1))
    ? location.hash.slice(1)
    : 'home';
  window.eventWechatLogin.open({ config: state.config, returnTo, onSuccess: finishLogin });
}
async function finishLogin(data) {
  state.user = data.user;
  state.csrf = data.csrf;
  updateLogin();
  if ($('loginDialog').open) $('loginDialog').close();
  try {
    await refreshMe();
    populateApplication();
    if (data.destination && ['home', 'participate', 'wall', 'account'].includes(data.destination))
      location.hash = data.destination;
    await route();
    toast('已登录');
  } catch {
    toast('已登录，资料暂时加载失败，请刷新页面重试。');
  }
}
function payload() {
  const f = $('applicationForm');
  return {
    realName: f.elements.realName.value.trim(),
    phone: f.elements.phone.value.trim(),
    school: f.elements.school.value.trim(),
    idType: f.elements.idType.value,
    idNumber: f.elements.idNumber.value.trim(),
    identityId:
      state.me?.applications.find((a) => a.competition === state.event)?.payload.identityId || '',
    consent: f.elements.consent.checked
  };
}
async function refreshMe() {
  state.me = state.user ? await api('/api/me') : null;
}
function populateApplication() {
  const form = $('applicationForm'),
    row = state.me?.applications.find((a) => a.competition === state.event),
    p = row?.payload || {};
  form.reset();
  $('identityFile').value = '';
  for (const name of ['realName', 'phone', 'school', 'idType', 'idNumber'])
    form.elements[name].value = p[name] || '';
  form.elements.consent.checked = !!p.consent;
  const locked = !!row && ['pending', 'approved'].includes(row.status);
  for (const input of form.querySelectorAll('input,textarea,select')) input.disabled = locked;
  $('saveDraft').disabled = locked;
  $('submitApplication').disabled = locked;
  $('applicationState').textContent = row
    ? `${labels[row.status]} · 报名编号 ${row.id.slice(0, 8)}`
    : state.user
      ? '填写资料，随时保存草稿。'
      : '登录后可保存草稿和提交报名。';
  hint('saveHint', row?.note || '');
  hint(
    'identityHint',
    p.identityId
      ? '身份照片已保存，可在“我的参与”查看。'
      : '仅本人与有权限的审核人员可查看，提交后由工作人员核验。'
  );
  if (state.user?.role === 'participant' && !$('workForm').elements.author.value)
    $('workForm').elements.author.value = state.user.nickname;
}
function switchEvent(type) {
  if (type !== 'film') return;
  if (state.busy) {
    toast('正在保存，请完成或暂停当前上传后再切换赛事。');
    return;
  }
  clearTimeout(saveTimer);
  state.event = type;
  state.editWork = null;
  state.submissionKey = null;
  $('eventName').textContent = events[type];
  $('eventGuide').textContent =
    '先提交身份材料，再上传影像作品。资格核验与作品审核通过后，作品进入公开广场。';
  $('workIntro').textContent = '请先提交上方报名资料。作品通过审核后公开展示。';
  $('videoHint').textContent =
    `影像作品建议约 ${Math.round((state.config?.expectedVideoSeconds || 180) / 60)} 分钟，单个文件最多 ${state.config?.maxVideoMb || 500}MB。\n支持 MP4 / MOV / WebM；推荐 MP4（H.264 视频 / AAC 音频）。\n每账号累计最多 ${state.config?.uploadQuotaMb || 3072}MB、${state.config?.uploadMaxFiles || 50} 个文件。上传中断后，重新选择原文件即可继续。`;
  $('workForm').reset();
  $('uploadProgress').hidden = true;
  hint('workHint', '');
  populateApplication();
}
async function saveApplication(submit, automatic = false, captured) {
  if (!state.user) {
    if (!automatic) showLogin();
    return;
  }
  const event = captured?.event || state.event,
    p = captured?.payload || payload();
  if (submit && event === 'film' && $('identityFile').files[0])
    p.identityId = await uploadFile($('identityFile').files[0], 'identity');
  const data = await api(`/api/applications/${event}`, {
    method: 'PUT',
    body: { payload: p, submit }
  });
  await refreshMe();
  if (state.event === event) {
    $('applicationState').textContent =
      `${labels[data.application.status]} · 报名编号 ${data.application.id.slice(0, 8)}`;
    hint(
      'saveHint',
      submit
        ? '报名已收到！你可以在“我的参与”查看审核结果。'
        : `草稿已保存 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
    );
    if (submit) populateApplication();
  }
  if (submit) toast('报名提交成功');
}
async function fingerprint(file) {
  const sample = new Uint8Array(
    await new Blob([
      file.slice(0, 1048576),
      file.slice(Math.max(0, file.size - 1048576)),
      `${file.name}:${file.size}:${file.lastModified}`
    ]).arrayBuffer()
  );
  const digest = await crypto.subtle.digest('SHA-256', sample);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
function progress(percent, message) {
  $('uploadProgress').hidden = false;
  $('progress').value = percent;
  $('progressText').textContent = message;
}
async function uploadFile(file, kind) {
  const limit = kind === 'identity' ? 5 * 1024 ** 2 : state.config.maxVideoMb * 1024 ** 2;
  if (file.size > limit || file.size < 12)
    throw new Error(`文件大小不符合要求，最大 ${limit / 1024 ** 2}MB`);
  state.paused = false;
  $('pauseUpload').disabled = false;
  progress(0, `准备上传 ${file.name}…`);
  const task = await api('/api/uploads', {
    method: 'POST',
    body: {
      kind,
      filename: file.name,
      mime: file.type,
      size: file.size,
      fingerprint: await fingerprint(file)
    }
  });
  if (task.status === 'ready') {
    progress(100, '已恢复上传完成的文件');
    return task.id;
  }
  if (task.driver === 'local') {
    const uploaded = new Set(task.parts),
      total = task.totalChunks;
    for (let i = 0; i < total; i++) {
      if (state.paused) throw new Error('上传已暂停。重新提交并选择同一文件即可继续。');
      if (!uploaded.has(i)) {
        for (let retry = 0; ; retry++) {
          const controller = new AbortController();
          state.uploadCancel = () => {
            state.paused = true;
            controller.abort();
          };
          try {
            const fd = new FormData();
            fd.append(
              'chunk',
              file.slice(i * task.chunkSize, Math.min(file.size, (i + 1) * task.chunkSize))
            );
            await api(`/api/uploads/${task.id}/chunks/${i}`, {
              method: 'POST',
              body: fd,
              signal: controller.signal
            });
            break;
          } catch (e) {
            if (state.paused) throw new Error('上传已暂停，保留原文件后可继续。');
            if (retry >= 2 || (e.status && e.status < 500)) throw e;
            progress(Math.round((i / total) * 95), '网络波动，正在重试当前分片…');
            await new Promise((resolve) => setTimeout(resolve, (retry + 1) * 1000));
          }
        }
      }
      progress(Math.round(((i + 1) / total) * 95), `${file.name} · ${i + 1}/${total} 分片已保存`);
    }
  } else {
    await new Promise((resolve, reject) => {
      let taskId;
      const cos = new COS({
        getAuthorization(options, callback) {
          api(`/api/uploads/${task.id}/credentials`, { method: 'POST' })
            .then((data) =>
              callback({
                TmpSecretId: data.credentials.tmpSecretId,
                TmpSecretKey: data.credentials.tmpSecretKey,
                SecurityToken: data.credentials.sessionToken,
                StartTime: data.startTime,
                ExpiredTime: data.expiredTime
              })
            )
            .catch(reject);
        }
      });
      state.uploadCancel = () => {
        state.paused = true;
        if (taskId) cos.cancelTask(taskId);
        reject(new Error('上传已暂停，重新选择同一文件即可继续。'));
      };
      api(`/api/uploads/${task.id}/credentials`, { method: 'POST' })
        .then((info) => {
          if (state.paused) return;
          cos.uploadFile(
            {
              Bucket: info.Bucket,
              Region: info.Region,
              Key: info.Key,
              Body: file,
              SliceSize: 5 * 1024 ** 2,
              ChunkSize: 5 * 1024 ** 2,
              onTaskReady(id) {
                taskId = id;
                if (state.paused) cos.cancelTask(id);
              },
              onProgress(data) {
                if (state.paused) return;
                progress(
                  Math.round(data.percent * 95),
                  `${file.name} · 已上传 ${Math.round(data.percent * 100)}%`
                );
              }
            },
            (error) =>
              error ? reject(new Error('云端上传中断，请重新选择同一文件继续')) : resolve()
          );
        })
        .catch(reject);
    });
  }
  state.uploadCancel = null;
  $('pauseUpload').disabled = true;
  progress(97, '正在核对文件完整性…');
  await api(`/api/uploads/${task.id}/complete`, { method: 'POST' });
  progress(100, '文件已保存');
  return task.id;
}
function statusTag(s) {
  return `<span class="status ${esc(s)}">${esc(labels[s] || s)}</span>`;
}
function renderAccount() {
  if (!state.user) {
    $('accountContent').innerHTML =
      '<div class="empty"><h3>让每一份灵感都有记录。</h3><p>登录后查看报名、作品与审核进度。</p><button class="button dark" data-login>登录查看 ↗</button></div>';
    return;
  }
  const applications = state.me?.applications || [],
    works = state.me?.works || [];
  $('accountContent').innerHTML =
    `<div class="section-heading"><h2>我的报名</h2></div><div class="account-grid">${applications.length ? applications.map((a) => `<article class="panel record">${statusTag(a.status)}<h3>${esc(events[a.competition])}</h3><p>编号：${esc(a.id)}</p><p>${esc(a.payload.realName || '草稿资料')} </p>${a.note ? `<p class="hint error">修改意见：${esc(a.note)}</p>` : ''}${a.payload.identityId ? `<p><a class="inline-link" href="api/media/${a.payload.identityId}" target="_blank" rel="noopener">查看我提交的身份照片 ↗</a></p>` : ''}<div class="actions"><button class="button small outline" data-edit-application="${a.competition}">${['draft', 'rejected'].includes(a.status) ? '继续填写' : '查看报名'}</button></div></article>`).join('') : '<div class="empty"><h3>还没有报名记录</h3><a href="#participate" class="button dark">报名影像大赛 ↗</a></div>'}</div><div class="section-heading"><h2>我的作品</h2></div><div class="account-grid">${works.length ? works.map((w) => `<article class="panel record">${statusTag(w.status)}<h3>${esc(w.title)}</h3><p>${esc(events[w.competition])} · ${esc(w.author)}</p><p>作品编号：${esc(w.id)}</p>${w.note ? `<p class="hint error">修改意见：${esc(w.note)}</p>` : ''}${w.video_id ? `<p><a class="inline-link" href="api/media/${w.video_id}" target="_blank" rel="noopener">查看我的视频 ↗</a></p>` : ''}${w.status === 'rejected' ? `<button class="button small outline" data-edit-work="${w.id}">修改并重新提交</button>` : ''}</article>`).join('') : '<div class="empty"><p>作品提交后，审核进度会显示在这里。</p></div>'}</div>`;
}
async function loadWall() {
  $('wallRules').textContent = state.config.rules[state.wall];
  const data = await api(`/api/works?competition=${state.wall}&page=${state.page}`);
  const voted = new Set(state.me?.votes.map((v) => v.work_id) || []);
  $('worksGrid').innerHTML = data.items.length
    ? data.items
        .map(
          (w) =>
            `<article class="work-card"><div class="work-media">${w.videoUrl ? `<button data-play="${w.id}" aria-label="播放 ${esc(w.title)}">▶</button>` : '<span aria-hidden="true">✳</span>'}</div><div class="work-body"><h3>${esc(w.title)}</h3><p>@${esc(w.author)}</p><p>${esc(w.description)}</p>${state.wall === 'film' ? `<div class="work-scores"><span>评委 ${w.judgeScore}</span><span>网络 ${w.networkScore}</span><span>综合 ${w.finalScore}</span></div>` : ''}<div class="work-footer"><button class="button small outline" data-vote="${w.id}" ${voted.has(w.id) ? 'disabled' : ''}>${voted.has(w.id) ? '已投票 ✓' : '投一票 ↗'}</button><span>${w.votes} 票</span></div></div></article>`
        )
        .join('')
    : '<div class="empty"><h3>好作品，值得等待。</h3><p>审核通过的作品会在这里亮相。</p><a href="#participate" class="button dark">提交我的灵感 ↗</a></div>';
  $('wallPage').textContent =
    `${state.page} / ${Math.max(1, Math.ceil(data.total / 12))} · ${data.total} 件作品`;
  $('wallPrev').disabled = state.page <= 1;
  $('wallNext').disabled = state.page * 12 >= data.total;
  $('worksGrid')
    .querySelectorAll('[data-play]')
    .forEach((button) =>
      button.addEventListener('click', () => {
        const w = data.items.find((v) => v.id === button.dataset.play),
          video = document.createElement('video');
        video.controls = true;
        video.preload = 'none';
        video.playsInline = true;
        video.src = w.videoUrl;
        button.parentElement.replaceChildren(video);
        video.play().catch(() => toast('请点击视频播放；如格式不兼容，请更换设备或联系工作人员。'));
      })
    );
}
async function route() {
  const name = ['home', 'participate', 'wall', 'account'].includes(location.hash.slice(1))
    ? location.hash.slice(1)
    : 'home';
  document.querySelectorAll('[data-page]').forEach((s) => (s.hidden = s.dataset.page !== name));
  document.querySelectorAll('nav a').forEach((a) => {
    const active = a.hash === `#${name}`;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (name === 'account') {
    await refreshMe();
    renderAccount();
  }
  if (name === 'wall') {
    await refreshMe();
    await loadWall();
  }
}
function handleError(e) {
  toast(e.message);
}
document
  .querySelectorAll('[data-close]')
  .forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
$('privacyButton').addEventListener('click', () => $('privacyDialog').showModal());
$('loginButton').addEventListener('click', async () => {
  try {
    if (state.busy) return toast('请先完成或暂停当前上传。');
    if (!state.user) return showLogin();
    await api('/api/auth/logout', { method: 'POST' });
    state.user = null;
    state.csrf = null;
    state.me = null;
    updateLogin();
    switchEvent(state.event);
    await route();
  } catch (e) {
    handleError(e);
  }
});
document
  .querySelectorAll('[data-select-event]')
  .forEach((a) => a.addEventListener('click', () => switchEvent(a.dataset.selectEvent)));
$('applicationForm').addEventListener('input', () => {
  clearTimeout(saveTimer);
  if (!state.user || state.busy) return;
  const snapshot = { event: state.event, payload: payload() };
  saveTimer = setTimeout(
    () =>
      saveApplication(false, true, snapshot).catch((e) =>
        hint('saveHint', `草稿尚未保存：${e.message}`, true)
      ),
    1000
  );
});
$('saveDraft').addEventListener('click', async () => {
  if (state.busy) return;
  clearTimeout(saveTimer);
  try {
    await saveApplication(false);
  } catch (e) {
    hint('saveHint', e.message, true);
  }
});
$('applicationForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearTimeout(saveTimer);
  if (!requireLogin() || state.busy) return;
  state.busy = true;
  $('submitApplication').disabled = true;
  try {
    await saveApplication(true);
  } catch (e) {
    hint('saveHint', e.message, true);
  } finally {
    state.busy = false;
    state.uploadCancel = null;
    $('pauseUpload').disabled = true;
    $('submitApplication').disabled = ['pending', 'approved'].includes(
      state.me?.applications.find((a) => a.competition === state.event)?.status
    );
  }
});
$('pauseUpload').addEventListener('click', () => {
  state.paused = true;
  state.uploadCancel?.();
});
$('workForm').addEventListener('input', () => {
  state.submissionKey = null;
});
$('workForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!requireLogin() || state.busy) return;
  const row = state.me?.applications.find((a) => a.competition === state.event);
  if (!row || !['approved', 'pending'].includes(row.status))
    return hint('workHint', '请先提交上方报名资料。', true);
  const form = $('workForm'),
    file = $('videoFile').files[0];
  if (!file && state.event === 'film' && !state.editWork?.video_id)
    return hint('workHint', '请选择视频文件。', true);
  const editing = state.editWork;
  const body = {
    competition: state.event,
    title: form.elements.title.value,
    author: form.elements.author.value,
    description: form.elements.description.value,
    videoId: editing?.video_id || null,
    submissionKey: state.submissionKey || (state.submissionKey = crypto.randomUUID())
  };
  state.busy = true;
  $('submitWork').disabled = true;
  $('submitWork').textContent = '正在保存作品…';
  try {
    if (file) body.videoId = await uploadFile(file, 'video');
    const data = await api(editing ? `/api/works/${editing.id}` : '/api/works', {
      method: editing ? 'PUT' : 'POST',
      body
    });
    hint('workHint', `作品已收到，编号 ${data.work.id.slice(0, 8)}。审核进度见“我的参与”。`);
    toast('作品提交成功');
    form.reset();
    state.editWork = null;
    state.submissionKey = null;
    await refreshMe();
    $('uploadProgress').hidden = true;
  } catch (e) {
    hint('workHint', e.message, true);
  } finally {
    state.busy = false;
    state.uploadCancel = null;
    $('pauseUpload').disabled = true;
    $('submitWork').disabled = false;
    $('submitWork').textContent = '上传并提交作品 ↗';
  }
});
$('wallPrev').addEventListener('click', () => {
  state.page--;
  loadWall().catch(handleError);
});
$('wallNext').addEventListener('click', () => {
  state.page++;
  loadWall().catch(handleError);
});
$('worksGrid').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-vote]');
  if (!b || !requireLogin()) return;
  b.disabled = true;
  try {
    const data = await api(`/api/votes/${b.dataset.vote}`, { method: 'POST' });
    await refreshMe();
    await loadWall();
    toast(data.duplicate ? '这件作品你已经投过票了' : '已投票，谢谢你的支持');
  } catch (error) {
    b.disabled = false;
    handleError(error);
  }
});
$('accountContent').addEventListener('click', (e) => {
  if (e.target.closest('[data-login]')) return showLogin();
  const application = e.target.closest('[data-edit-application]');
  if (application) {
    switchEvent(application.dataset.editApplication);
    location.hash = 'participate';
  }
  const button = e.target.closest('[data-edit-work]');
  if (button) {
    const work = state.me.works.find((w) => w.id === button.dataset.editWork);
    switchEvent(work.competition);
    state.editWork = work;
    const form = $('workForm');
    for (const name of ['title', 'author', 'description']) form.elements[name].value = work[name];
    hint('workHint', `修改意见：${work.note}。可更换视频后重新提交。`);
    location.hash = 'participate';
  }
});
$('refreshAccount').addEventListener('click', async () => {
  try {
    await refreshMe();
    renderAccount();
    toast('进度已更新');
  } catch (e) {
    handleError(e);
  }
});
window.addEventListener('hashchange', () => route().catch(handleError));
window.addEventListener('beforeunload', (e) => {
  if (state.busy) {
    e.preventDefault();
    e.returnValue = '';
  }
});
(async () => {
  state.config = await api('/api/config');
  if (!state.config.preview) {
    $('rulesNote').textContent = `咨询：${state.config.contact}`;
    const dialog = $('privacyDialog');
    dialog.querySelectorAll('p').forEach((p) => p.remove());
    const notice = document.createElement('p');
    notice.textContent = `${state.config.organizer}。${state.config.privacyNotice} 联系：${state.config.contact}`;
    dialog.append(notice);
  } else {
    const retention = document.createElement('p');
    retention.textContent = `当前计划在活动结束后保留 ${state.config.retentionDays} 天，活动结束日期与具体清理范围待确认。预览体验请继续使用虚构资料。`;
    $('privacyDialog').append(retention);
  }
  const session = await api('/api/session');
  state.user = session.user;
  state.csrf = session.csrf;
  await refreshMe();
  updateLogin();
  switchEvent('film');
  await route();
})().catch(handleError);
