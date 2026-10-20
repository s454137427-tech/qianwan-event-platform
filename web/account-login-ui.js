'use strict';
// 参与者登录：手机号 + 密码。注册与登录共用一套表单，通过页签切换。
(() => {
  let onSuccess,
    mode = 'login';
  const byId = (id) => document.getElementById(id);
  const api = async (url, body) => {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Object.assign(new Error(data.error || '操作失败，请稍后重试'), {
        status: response.status
      });
    return data;
  };
  function hint(value, error = false) {
    const node = byId('loginHint');
    if (!node) return;
    node.textContent = value;
    node.classList.toggle('error', error);
  }
  function setMode(next, keepHint = false) {
    mode = next;
    const registering = next === 'register';
    byId('loginTabLogin').setAttribute('aria-selected', String(!registering));
    byId('loginTabRegister').setAttribute('aria-selected', String(registering));
    byId('loginConfirmRow').hidden = !registering;
    byId('loginPassword').value = '';
    byId('loginConfirm').value = '';
    byId('loginPassword').autocomplete = registering ? 'new-password' : 'current-password';
    byId('loginPassword').placeholder = registering ? '设置6至64位密码' : '请输入密码';
    byId('loginSubmit').textContent = registering ? '注册并登录 ↗' : '登录 ↗';
    byId('loginTitle').textContent = registering ? '注册参赛账号' : '手机号登录';
    byId('loginIntro').textContent = registering
      ? '用手机号设置一个密码即可注册。手机号和密码是之后登录的唯一凭据，请记好。'
      : '输入注册时使用的手机号和密码。忘记密码请联系工作人员重置。';
    if (!keepHint) hint('');
  }
  async function submit(event) {
    event.preventDefault();
    const phone = byId('loginPhone').value.replace(/[\s-]/g, ''),
      password = byId('loginPassword').value;
    if (!/^1[3-9]\d{9}$/.test(phone)) return hint('请输入正确的11位手机号', true);
    if (password.length < 6) return hint('密码至少需要6位', true);
    if (mode === 'register' && password !== byId('loginConfirm').value)
      return hint('两次输入的密码不一致', true);
    byId('loginSubmit').disabled = true;
    hint(mode === 'register' ? '正在创建账号…' : '正在登录…');
    try {
      const data = await api('/api/auth/' + mode, { phone, password });
      byId('loginPassword').value = '';
      byId('loginConfirm').value = '';
      byId('loginDialog').close();
      await onSuccess(data);
    } catch (error) {
      // 手机号已存在时直接切到登录页签，保留已填手机号。
      if (error.status === 409) setMode('login', true);
      hint(error.message, true);
    } finally {
      byId('loginSubmit').disabled = false;
    }
  }
  byId('loginTabLogin').addEventListener('click', () => setMode('login'));
  byId('loginTabRegister').addEventListener('click', () => setMode('register'));
  byId('accountLoginForm').addEventListener('submit', submit);
  byId('loginDialog').addEventListener('close', () => {
    byId('loginPassword').value = '';
    byId('loginConfirm').value = '';
    hint('');
  });
  window.eventAccountLogin = {
    open(options) {
      if (byId('loginDialog').open) return;
      onSuccess = options.onSuccess;
      byId('loginDialog').showModal();
      setMode('login');
      setTimeout(() => byId('loginPhone').focus(), 60);
    }
  };
})();
