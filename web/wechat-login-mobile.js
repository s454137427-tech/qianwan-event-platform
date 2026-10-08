'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.hash.slice(1));
  let saved = '';
  try {
    saved = sessionStorage.getItem('event-scan-ticket') || '';
  } catch {}
  const ticket = params.get('ticket') || saved;
  const error = params.get('error');
  history.replaceState(null, '', location.pathname);
  let csrf,
    expiryTimer,
    expiresAt,
    ready = false;
  const api = async (url, body) => {
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '连接失败，请稍后重试');
    return result;
  };
  function forget() {
    try {
      sessionStorage.removeItem('event-scan-ticket');
    } catch {}
  }
  function showError(value) {
    ready = false;
    clearInterval(expiryTimer);
    $('scanStatus').textContent = value;
    $('scanActions').hidden = true;
    $('scanAuthorize').hidden = true;
    $('scanRetry').hidden = !ticket || !!error;
  }
  function expiry() {
    const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    $('scanExpiry').textContent =
      '二维码剩余有效时间：' +
      Math.floor(seconds / 60) +
      ' 分 ' +
      String(seconds % 60).padStart(2, '0') +
      ' 秒';
    if (!seconds) {
      forget();
      showError('二维码已过期，请在原网页刷新后重新扫描。');
    }
  }
  async function load() {
    if (error) {
      forget();
      return showError(
        error === 'expired'
          ? '微信授权已过期，请返回原网页重新登录。'
          : '微信授权未完成，请返回原网页重试。'
      );
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket || ''))
      return showError('请使用微信扫描原网页上的登录二维码。');
    try {
      sessionStorage.setItem('event-scan-ticket', ticket);
    } catch {}
    $('scanRetry').hidden = true;
    $('scanStatus').textContent = '正在读取登录请求…';
    try {
      const config = await api('/api/config');
      if (!config.wechat) return showError('微信登录尚未接入，请等待活动公众号配置完成。');
      if (!/MicroMessenger/i.test(navigator.userAgent))
        return showError('请使用手机微信“扫一扫”打开此页面。');
      const result = await api('/api/auth/qr/scan', { ticket });
      const session = await api('/api/session');
      csrf = session.csrf;
      $('scanOrigin').textContent = result.origin;
      $('scanCode').textContent = result.displayCode;
      expiresAt = result.expiresAt;
      clearInterval(expiryTimer);
      if (expiresAt <= Date.now()) return showError('二维码已过期，请在原网页刷新后重新扫描。');
      expiry();
      expiryTimer = setInterval(expiry, 1000);
      $('scanDetails').hidden = false;
      $('scanAuthorize').hidden = result.signedIn;
      $('scanActions').hidden = !result.signedIn;
      if (result.signedIn) {
        $('scanNickname').textContent = result.user.nickname;
        if (result.user.avatar) {
          $('scanAvatar').src = result.user.avatar;
          $('scanAvatar').hidden = false;
        }
        $('scanAccount').hidden = false;
        ready = true;
        $('scanStatus').textContent =
          '请核对原网页上的六位验证码和下方网站地址。确认是你正在使用的网页后，再确认登录。';
      } else {
        ready = false;
        $('scanStatus').textContent = '先授权微信身份，再确认是否登录原网页。';
      }
    } catch (e) {
      showError(e.message);
    }
  }
  $('scanAuthorize').addEventListener('click', async () => {
    $('scanAuthorize').disabled = true;
    try {
      const result = await api('/api/auth/wechat/prepare', { ticket });
      location.assign(result.url);
    } catch (e) {
      showError(e.message);
      $('scanAuthorize').disabled = false;
    }
  });
  async function decide(decision) {
    if (!ready) return;
    $('scanApprove').disabled = true;
    $('scanReject').disabled = true;
    try {
      await api('/api/auth/qr/decision', { ticket, decision });
      forget();
      ready = false;
      clearInterval(expiryTimer);
      $('scanActions').hidden = true;
      $('scanExpiry').textContent = '';
      $('scanTitle').textContent = decision === 'approve' ? '已确认登录' : '已取消登录';
      $('scanStatus').textContent =
        decision === 'approve'
          ? '原网页将自动完成登录。你可以回到原网页继续报名或投稿。'
          : '原网页不会登录这个微信账号。';
    } catch (e) {
      showError(e.message);
    } finally {
      $('scanApprove').disabled = false;
      $('scanReject').disabled = false;
    }
  }
  $('scanApprove').addEventListener('click', () => decide('approve'));
  $('scanReject').addEventListener('click', () => decide('reject'));
  $('scanRetry').addEventListener('click', load);
  load();
})();
