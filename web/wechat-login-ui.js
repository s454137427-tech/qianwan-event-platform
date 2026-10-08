'use strict';
(() => {
  let config,
    onSuccess,
    destination = 'account',
    generation = 0,
    pollTimer,
    clockTimer,
    ticket,
    creating;
  const byId = (id) => document.getElementById(id);
  const inWechat = /MicroMessenger/i.test(navigator.userAgent);
  const api = async (url, method = 'GET', body) => {
    const response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Object.assign(new Error(data.error || '连接失败，请稍后重试'), {
        status: response.status
      });
    return data;
  };
  function stop() {
    generation++;
    clearTimeout(pollTimer);
    clearInterval(clockTimer);
    ticket = null;
  }
  function message(value) {
    byId('loginQrStatus').textContent = value;
  }
  function ended(value) {
    stop();
    message(value);
    byId('loginQrImage').hidden = true;
    byId('loginQrEmpty').hidden = false;
    byId('loginQrVerification').hidden = !config.wechat;
    byId('loginQrRefresh').hidden = !config.wechat;
    byId('loginQrCountdown').hidden = !config.wechat;
    byId('loginQrEmpty').textContent = value;
    byId('loginQrCountdown').textContent = '';
    byId('loginQrRefresh').disabled = false;
  }
  function clock(epoch) {
    if (generation !== epoch || !ticket) return;
    const seconds = Math.max(0, Math.ceil((ticket.expiresAt - Date.now()) / 1000));
    byId('loginQrCountdown').textContent =
      '剩余 ' + Math.floor(seconds / 60) + ' 分 ' + String(seconds % 60).padStart(2, '0') + ' 秒';
    if (!seconds) ended('二维码已过期，请刷新后重扫。');
  }
  async function poll(epoch) {
    if (generation !== epoch || !ticket || !byId('loginDialog').open) return;
    if (Date.now() >= ticket.expiresAt) return ended('二维码已过期，请刷新后重扫。');
    if (document.hidden) {
      pollTimer = setTimeout(() => poll(epoch), 4000);
      return;
    }
    try {
      const data = await api('/api/auth/qr/' + ticket.id);
      if (generation !== epoch) return;
      if (data.status === 'approved') {
        message('手机已确认，正在登录…');
        const result = await api('/api/auth/qr/' + ticket.id + '/complete', 'POST', {});
        if (generation !== epoch) return;
        byId('loginDialog').close();
        stop();
        await onSuccess(result);
        return;
      }
      if (['expired', 'rejected', 'cancelled', 'consumed'].includes(data.status))
        return ended(
          data.status === 'rejected'
            ? '手机已取消登录，可刷新后重试。'
            : '二维码已结束，请刷新后重扫。'
        );
      message(
        data.status === 'scanned'
          ? '已扫码，请在手机微信上核对验证码并确认登录。'
          : '等待微信扫码，扫码后请在手机上确认。'
      );
    } catch (error) {
      if (generation !== epoch) return;
      if ([404, 409, 410].includes(error.status)) return ended('登录请求已结束，请刷新二维码。');
      message('网络暂时不稳定，正在重新连接；请保留当前页面。');
    }
    if (generation === epoch) pollTimer = setTimeout(() => poll(epoch), 4000);
  }
  async function startQr() {
    stop();
    const epoch = generation;
    byId('loginQrImage').hidden = true;
    byId('loginQrEmpty').hidden = false;
    byId('loginQrVerification').hidden = !config.wechat;
    byId('loginQrRefresh').hidden = !config.wechat;
    byId('loginQrCountdown').hidden = !config.wechat;
    byId('loginQrCode').textContent = '—';
    byId('loginQrCountdown').textContent = '';
    if (!config.wechat) {
      byId('loginQrEmpty').textContent = '微信扫码登录待接入';
      message('接入活动公众号后，这里将显示可扫描的登录二维码。');
      byId('loginQrRefresh').disabled = true;
      return;
    }
    byId('loginQrEmpty').textContent = '正在生成二维码…';
    byId('loginQrRefresh').disabled = true;
    try {
      if (creating) await creating.catch(() => {});
      if (generation !== epoch) return;
      creating = api('/api/auth/qr', 'POST', { returnTo: destination });
      const data = await creating;
      if (generation !== epoch) return;
      ticket = data;
      byId('loginQrImage').src = data.qrImage;
      byId('loginQrImage').hidden = false;
      byId('loginQrEmpty').hidden = true;
      byId('loginQrCode').textContent = data.displayCode;
      message('请使用手机微信扫一扫。');
      clock(epoch);
      clockTimer = setInterval(() => clock(epoch), 1000);
      pollTimer = setTimeout(() => poll(epoch), 2000);
    } catch (error) {
      if (generation === epoch) ended(error.message);
    } finally {
      if (generation === epoch && config.wechat) byId('loginQrRefresh').disabled = false;
    }
  }
  function mode(name) {
    stop();
    byId('wechatLoginTabs')
      .querySelectorAll('button')
      .forEach((b) => {
        const active = b.dataset.loginMode === name;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
    byId('loginWechatPane').hidden = name !== 'wechat';
    byId('loginQrPane').hidden = name !== 'qr';
    if (name === 'qr') startQr();
  }
  byId('wechatLoginTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-login-mode]');
    if (b) mode(b.dataset.loginMode);
  });
  byId('loginQrRefresh').addEventListener('click', startQr);
  byId('loginDialog').addEventListener('close', stop);
  window.eventWechatLogin = {
    open(options) {
      config = options.config;
      onSuccess = options.onSuccess;
      destination = options.returnTo || 'account';
      byId('devLoginSection').hidden = !config.devLogin;
      byId('wechatLoginButton').hidden = !config.wechat || !inWechat;
      byId('wechatLoginButton').href =
        '/api/auth/wechat?returnTo=' + encodeURIComponent(destination);
      byId('loginIntro').textContent = '微信内可直接授权；浏览器中可用手机微信扫码登录。';
      byId('wechatLoginDescription').textContent = inWechat
        ? config.wechat
          ? '授权后自动识别微信账号，并读取微信允许提供的信息。'
          : '微信内授权登录待接入活动公众号。'
        : '请在手机微信中打开活动链接，即可授权登录。电脑或其他浏览器请切换到“微信扫码登录”。';
      byId('loginHint').textContent = '';
      byId('loginDialog').showModal();
      mode(inWechat ? 'wechat' : 'qr');
    }
  };
})();
