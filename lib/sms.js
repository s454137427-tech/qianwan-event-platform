'use strict';
// 验证码短信适配器：阿里云 / 腾讯云 / 火山引擎 / mock（本地调试）。
// 仅使用 Node 原生 crypto 与 fetch，不引入第三方 SDK。

const crypto = require('node:crypto');

const PROVIDERS = ['mock', 'aliyun', 'tencent', 'volcengine'];
const TIMEOUT = 10000;

const hmac = (algorithm, key, data) => crypto.createHmac(algorithm, key).update(data).digest();
const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const timestamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// RFC3986 编码：阿里云的规范化查询串要求连 !'()* 一并转义。
const rfc3986 = (value) =>
  encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase()
  );

async function post(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { raw };
  }
  if (!response.ok) {
    const error = new Error(`短信服务返回 HTTP ${response.status}`);
    error.provider = body;
    throw error;
  }
  return body;
}

// 阿里云短信 SendSms（RPC 风格，HMAC-SHA1 签名）。
async function aliyunSend(cfg, { phone, code }) {
  const params = {
    AccessKeyId: cfg.accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: cfg.region || 'cn-hangzhou',
    SignName: cfg.signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    TemplateCode: cfg.templateCode,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: timestamp(),
    Version: '2017-05-25'
  };
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${rfc3986(key)}=${rfc3986(params[key])}`)
    .join('&');
  const stringToSign = `POST&${rfc3986('/')}&${rfc3986(canonical)}`;
  const signature = crypto
    .createHmac('sha1', cfg.accessKeySecret + '&')
    .update(stringToSign)
    .digest('base64');
  const body = await post('https://dysmsapi.aliyuncs.com/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, Signature: signature }).toString()
  });
  if (body.Code !== 'OK') {
    const error = new Error(body.Message || body.Code || '短信发送失败');
    error.providerCode = body.Code;
    throw error;
  }
  return { provider: 'aliyun', id: body.BizId || '' };
}

// 腾讯云短信 SendSms（TC3-HMAC-SHA256 签名）。
async function tencentSend(cfg, { phone, code }) {
  const host = 'sms.tencentcloudapi.com';
  const payload = JSON.stringify({
    PhoneNumberSet: ['+86' + phone],
    SmsSdkAppId: cfg.appId,
    SignName: cfg.signName,
    TemplateId: cfg.templateCode,
    TemplateParamSet: [code]
  });
  const timestampSeconds = Math.floor(Date.now() / 1000);
  const date = new Date(timestampSeconds * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(payload)
  ].join('\n');
  const scope = `${date}/sms/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', timestampSeconds, scope, sha256Hex(canonicalRequest)].join(
    '\n'
  );
  const secretDate = hmac('sha256', 'TC3' + cfg.accessKeySecret, date);
  const secretService = hmac('sha256', secretDate, 'sms');
  const secretSigning = hmac('sha256', secretService, 'tc3_request');
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
  const body = await post(`https://${host}/`, {
    method: 'POST',
    headers: {
      Authorization: `TC3-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'Content-Type': 'application/json; charset=utf-8',
      Host: host,
      'X-TC-Action': 'SendSms',
      'X-TC-Version': '2021-01-11',
      'X-TC-Timestamp': String(timestampSeconds),
      'X-TC-Region': cfg.region || 'ap-guangzhou'
    },
    body: payload
  });
  const result = body.Response || {};
  if (result.Error) {
    const error = new Error(result.Error.Message || '短信发送失败');
    error.providerCode = result.Error.Code;
    throw error;
  }
  const status = result.SendStatusSet?.[0];
  if (status && status.Code !== 'Ok') {
    const error = new Error(status.Message || status.Code || '短信发送失败');
    error.providerCode = status.Code;
    throw error;
  }
  return { provider: 'tencent', id: result.SerialNo || '' };
}

// 火山引擎短信 SendSms（SigV4 签名）。
async function volcengineSend(cfg, { phone, code }) {
  const host = 'open.volcengineapi.com';
  const path = '/';
  const query = 'Action=SendSms&Version=2020-01-01';
  const region = cfg.region || 'cn-north-1';
  const service = 'volcSMS';
  const payload = JSON.stringify({
    SmsAccount: cfg.appId,
    Sign: cfg.signName,
    TemplateID: cfg.templateCode,
    TemplateParam: JSON.stringify({ code }),
    PhoneNumbers: phone
  });
  const bodyHash = sha256Hex(payload);
  const xDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const shortDate = xDate.slice(0, 8);
  const signedHeaders = 'content-type;host;x-content-sha256;x-date';
  const canonicalRequest = [
    'POST',
    path,
    query,
    `content-type:application/json\nhost:${host}\nx-content-sha256:${bodyHash}\nx-date:${xDate}\n`,
    signedHeaders,
    bodyHash
  ].join('\n');
  const scope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac('sha256', cfg.accessKeySecret, shortDate);
  const kRegion = hmac('sha256', kDate, region);
  const kService = hmac('sha256', kRegion, service);
  const signingKey = hmac('sha256', kService, 'request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const body = await post(`https://${host}${path}?${query}`, {
    method: 'POST',
    headers: {
      Authorization: `HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'Content-Type': 'application/json',
      Host: host,
      'X-Content-Sha256': bodyHash,
      'X-Date': xDate
    },
    body: payload
  });
  const meta = body.ResponseMetadata?.Error;
  if (meta) {
    const error = new Error(meta.Message || '短信发送失败');
    error.providerCode = meta.Code;
    throw error;
  }
  return { provider: 'volcengine', id: body.Result?.MessageID?.[0] || '' };
}

const DRIVERS = { aliyun: aliyunSend, tencent: tencentSend, volcengine: volcengineSend };

function createSms(config) {
  const cfg = config.sms || {};
  const provider = PROVIDERS.includes(cfg.provider) ? cfg.provider : '';
  if (!provider) return null;
  const missing = () => {
    const required =
      provider === 'mock'
        ? []
        : ['accessKeyId', 'accessKeySecret', 'signName', 'templateCode'].concat(
            ['tencent', 'volcengine'].includes(provider) ? ['appId'] : []
          );
    return required.filter((key) => !String(cfg[key] || '').trim());
  };
  const absent = missing();
  return {
    provider,
    // 配置不完整时不拒绝启动，但登录入口会明确提示不可用。
    ready: absent.length === 0,
    missing: absent,
    async send(phone, code) {
      if (!this.ready) {
        const error = new Error('短信服务配置不完整');
        error.status = 503;
        error.missing = absent;
        throw error;
      }
      if (provider === 'mock') {
        console.log(JSON.stringify({ route: 'sms-mock', phone: maskPhone(phone), code }));
        return { provider: 'mock', id: 'mock' };
      }
      return DRIVERS[provider](cfg, { phone, code });
    }
  };
}

function maskPhone(phone) {
  const value = String(phone || '');
  return /^1\d{10}$/.test(value) ? value.slice(0, 3) + '****' + value.slice(7) : '***';
}

module.exports = { createSms, maskPhone, PROVIDERS };
