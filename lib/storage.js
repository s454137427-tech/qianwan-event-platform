const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');

function detectMime(buffer) {
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString() === 'ftyp') return 'video/mp4';
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  return null;
}
function validateHeader(task, header) {
  const mime = detectMime(header);
  if (!mime || (task.kind === 'video' ? !mime.startsWith('video/') : !mime.startsWith('image/'))) {
    const e = new Error('文件内容与支持的格式不符，请选择MP4/WebM视频或JPG/PNG照片');
    e.status = 400;
    throw e;
  }
  return mime;
}

function uploadPolicy(bucket, objectKey) {
  if (!/^private\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(mp4|mov|webm|jpg|jpeg|png)$/.test(objectKey))
    throw new Error('临时授权只允许指定暂存文件');
  // 只保留一条 Allow。曾经额外附一条带 `x-tos-acl` 条件的 Deny 语句用于拦截公开读，
  // 但火山 STS 不识别该条件键，会让整份策略校验失败并返回 HTTP 400 Bad Request
  // （2026-10-20 线上复现：同样的角色只加这条 Deny 就 400，去掉即成功）。
  // 权限本身并不因此放宽：Allow 未授予 `tos:PutObjectAcl`，调用方无法把对象改成公开读。
  return {
    Statement: [
      {
        Effect: 'Allow',
        Action: ['tos:PutObject', 'tos:ListMultipartUploadParts', 'tos:AbortMultipartUpload'],
        Resource: [`trn:tos:::${bucket}/${objectKey}`]
      }
    ]
  };
}

async function createStorage(config) {
  const root = path.join(config.dataDir, 'private-uploads');
  const locks = new Map();
  const operations = new Map();
  function serialize(task, fn) {
    const pending = (operations.get(task.id) || Promise.resolve()).catch(() => {}).then(fn);
    operations.set(task.id, pending);
    return pending.finally(() => {
      if (operations.get(task.id) === pending) operations.delete(task.id);
    });
  }
  if (config.storage === 'local') await fs.mkdir(root, { recursive: true });
  let tos, sts;
  if (config.storage === 'tos') {
    const { TosClient } = require('@volcengine/tos-sdk');
    const { STSClient } = require('@volcengine/sts');
    tos = new TosClient({
      ...config.tos,
      secure: true,
      enableVerifySSL: true,
      requestTimeout: 30000,
      connectionTimeout: 5000,
      maxRetryCount: 2,
      enableCRC: false
    });
    sts = new STSClient({
      accessKeyId: config.tos.accessKeyId,
      secretAccessKey: config.tos.accessKeySecret,
      region: config.tos.region,
      host: 'sts.' + config.tos.region + '.volcengineapi.com',
      protocol: 'https',
      autoRetry: true,
      maxRetries: 2,
      httpOptions: { readTimeout: 15000, connectTimeout: 5000 }
    });
  }
  function location(task, part) {
    if (!/^[a-f0-9-]{36}$/.test(task.id)) throw new Error('上传任务不合法');
    return path.join(root, task.id, part === undefined ? 'file' : `${part}.part`);
  }
  return {
    driver: config.storage,
    location,
    async credentials(task) {
      const { AssumeRoleCommand } = require('@volcengine/sts');
      const result = await sts.send(
        new AssumeRoleCommand({
          RoleTrn: config.tos.roleTrn,
          Policy: JSON.stringify(uploadPolicy(config.tos.bucket, task.object_key)),
          DurationSeconds: 1800,
          RoleSessionName: 'upload-' + task.id
        })
      );
      const c = result.Result?.Credentials;
      if (
        !c?.AccessKeyId ||
        !c.SecretAccessKey ||
        !c.SessionToken ||
        !Number.isFinite(Date.parse(c.ExpiredTime))
      )
        throw new Error('临时凭据响应不完整');
      return {
        accessKeyId: c.AccessKeyId,
        accessKeySecret: c.SecretAccessKey,
        stsToken: c.SessionToken,
        expiration: c.ExpiredTime,
        bucket: config.tos.bucket,
        region: config.tos.region,
        endpoint: new URL(config.tos.publicOrigin).hostname,
        key: task.object_key
      };
    },
    async parts(task) {
      if (config.storage !== 'local') return [];
      try {
        return (await fs.readdir(path.dirname(location(task))))
          .filter((n) => /^\d+\.part$/.test(n))
          .map((n) => Number(n.split('.')[0]))
          .sort((a, b) => a - b);
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
    },
    async putPart(task, index, buffer) {
      if (config.storage !== 'local') throw new Error('云端上传请直接使用TOS');
      const total = Math.ceil(Number(task.size) / config.chunkSize);
      const expected =
        index === total - 1 ? Number(task.size) - index * config.chunkSize : config.chunkSize;
      if (!Number.isInteger(index) || index < 0 || index >= total || buffer.length !== expected) {
        const e = new Error('分片序号或大小不正确');
        e.status = 400;
        throw e;
      }
      await serialize(task, async () => {
        try {
          await fs.access(location(task));
          throw Object.assign(new Error('文件已完成，请刷新上传状态'), { status: 409 });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        const final = location(task, index);
        await fs.mkdir(path.dirname(final), { recursive: true });
        const temp = `${final}.${crypto.randomUUID()}.tmp`;
        try {
          await fs.writeFile(temp, buffer, { flag: 'wx' });
          await fs.rename(temp, final);
        } finally {
          await fs.unlink(temp).catch(() => {});
        }
      });
    },
    async complete(task) {
      if (locks.has(task.id)) return locks.get(task.id);
      const operation = serialize(task, async () => {
        if (config.storage === 'tos') {
          let head;
          try {
            head = await tos.headObject({ key: task.object_key });
          } catch (error) {
            if (error.statusCode === 404 && ['NoSuchKey', 'NotFound'].includes(error.code))
              throw Object.assign(new Error('文件尚未上传完整，请继续上传'), { status: 404 });
            throw error;
          }
          if (Number(head.data['content-length']) !== Number(task.size))
            throw Object.assign(new Error('云端文件大小不一致'), { status: 400 });
          const etag = head.data.etag;
          if (!etag) throw new Error('无法确认云端文件版本');
          const content = await tos.getObjectV2({
            key: task.object_key,
            rangeStart: 0,
            rangeEnd: 63,
            ifMatch: etag,
            dataType: 'buffer'
          });
          const mime = validateHeader(task, content.data.content);
          const objectKey = `protected/${task.user_id}/${task.id}${path.extname(task.filename).toLowerCase()}`;
          // TOS CopyObject supports up to 5 GiB, above this application's 2 GiB maximum.
          // Browser credentials only access the one private staging object.
          const copy = await tos.copyObject({
            key: objectKey,
            srcBucket: config.tos.bucket,
            srcKey: task.object_key,
            copySourceIfMatch: etag,
            metadataDirective: 'REPLACE',
            contentType: mime,
            contentDisposition: 'inline',
            cacheControl: 'private, no-store',
            acl: 'private',
            meta: {}
          });
          const frozen = await tos.headObject({ key: objectKey });
          if (
            Number(frozen.data['content-length']) !== Number(task.size) ||
            frozen.data['content-type'] !== mime ||
            !copy.data.ETag ||
            frozen.data.etag !== copy.data.ETag
          )
            throw new Error('文件确认未完成，请重试');
          // Staging and incomplete parts are retained; lifecycle cleanup is configured separately.
          return { mime, objectKey };
        }
        const final = location(task);
        // A crash between disk finalization and database confirmation is safe to retry.
        try {
          if ((await fs.stat(final)).size === Number(task.size)) {
            const handle = await fs.open(final, 'r');
            try {
              const b = Buffer.alloc(64);
              const result = await handle.read(b, 0, 64, 0);
              return validateHeader(task, b.subarray(0, result.bytesRead));
            } finally {
              await handle.close();
            }
          }
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        const total = Math.ceil(Number(task.size) / config.chunkSize);
        const parts = await this.parts(task);
        if (parts.length !== total) {
          const e = new Error('视频尚未上传完整，请继续上传');
          e.status = 400;
          throw e;
        }
        let size = 0;
        for (let i = 0; i < total; i++) size += (await fs.stat(location(task, i))).size;
        if (size !== Number(task.size)) {
          const e = new Error('分片大小不一致');
          e.status = 400;
          throw e;
        }
        const handle = await fs.open(location(task, 0), 'r');
        let mime;
        try {
          const b = Buffer.alloc(64);
          const read = await handle.read(b, 0, 64, 0);
          mime = validateHeader(task, b.subarray(0, read.bytesRead));
        } finally {
          await handle.close();
        }
        const temp = `${final}.merging`;
        try {
          for (let i = 0; i < total; i++)
            await pipeline(
              createReadStream(location(task, i)),
              createWriteStream(temp, { flags: i ? 'a' : 'w' })
            );
          await fs.rename(temp, final);
          for (let i = 0; i < total; i++) await fs.unlink(location(task, i));
        } catch (e) {
          await fs.unlink(temp).catch(() => {});
          throw e;
        }
        return mime;
      });
      locks.set(task.id, operation);
      try {
        return await operation;
      } finally {
        locks.delete(task.id);
      }
    },
    async signedUrl(task) {
      if (!task.object_key.startsWith('protected/')) throw new Error('文件尚未保护');
      // Sign the actual public CNAME; never rewrite the host of a regional signed URL.
      return tos.getPreSignedUrl({
        key: task.object_key,
        method: 'GET',
        expires: 600,
        alternativeEndpoint: new URL(config.tos.publicOrigin).hostname,
        isCustomDomain: true,
        query: {
          'response-content-disposition': 'inline',
          'response-cache-control': 'private, no-store'
        }
      });
    },
    async downloadUrl(task, filename, seconds) {
      if (!task.object_key.startsWith('protected/')) throw new Error('文件尚未保护');
      // Cross-origin downloads ignore the anchor's `download` attribute, so the
      // saved name has to be carried by the signed response header (RFC 5987).
      // A literal apostrophe would terminate the UTF-8'' prefix, so it is dropped.
      const clean =
        String(filename || '')
          .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
          .replace(/'/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 100) || 'work';
      return tos.getPreSignedUrl({
        key: task.object_key,
        method: 'GET',
        expires: Math.max(60, Math.min(604800, Number(seconds) || 86400)),
        alternativeEndpoint: new URL(config.tos.publicOrigin).hostname,
        isCustomDomain: true,
        query: {
          'response-content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(clean)}`
        }
      });
    },
    publishedVideoUrl() {
      // Tencent CDN signatures are deliberately unsupported. All reads use TOS V4.
      return null;
    }
  };
}
module.exports = { createStorage, detectMime, uploadPolicy };
