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

// Tencent CDN TypeA. The digest format is prescribed by the CDN protocol.
function cdnUrl(cdn, objectKey) {
  if (!/^(?:protected)\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(?:mp4|mov|webm)$/.test(objectKey))
    throw new Error('此文件不可通过视频CDN分发');
  const uri = `/${objectKey}`,
    timestamp = Math.floor(Date.now() / 1000),
    random = crypto.randomBytes(12).toString('hex');
  const signature = crypto
    .createHash('md5')
    .update(`${uri}-${timestamp}-${random}-0-${cdn.key}`)
    .digest('hex');
  return `${cdn.origin}${uri}?sign=${timestamp}-${random}-0-${signature}`;
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
  let cos;
  if (config.storage === 'cos') {
    const COS = require('cos-nodejs-sdk-v5');
    cos = new COS({
      SecretId: config.cos.SecretId,
      SecretKey: config.cos.SecretKey,
      Timeout: 30000
    });
  }
  const call = (method, options) =>
    new Promise((resolve, reject) =>
      cos[method](
        { Bucket: config.cos.Bucket, Region: config.cos.Region, ...options },
        (e, data) => (e ? reject(e) : resolve(data))
      )
    );
  function location(task, part) {
    if (!/^[a-f0-9-]{36}$/.test(task.id)) throw new Error('上传任务不合法');
    return path.join(root, task.id, part === undefined ? 'file' : `${part}.part`);
  }
  return {
    driver: config.storage,
    location,
    async credentials(task) {
      const STS = require('qcloud-cos-sts');
      const appId = config.cos.Bucket.split('-').pop();
      return new Promise((resolve, reject) =>
        STS.getCredential(
          {
            secretId: config.cos.SecretId,
            secretKey: config.cos.SecretKey,
            durationSeconds: 1800,
            policy: {
              version: '2.0',
              statement: [
                {
                  effect: 'allow',
                  action: [
                    'name/cos:PutObject',
                    'name/cos:InitiateMultipartUpload',
                    'name/cos:ListMultipartUploads',
                    'name/cos:ListParts',
                    'name/cos:UploadPart',
                    'name/cos:CompleteMultipartUpload',
                    'name/cos:AbortMultipartUpload'
                  ],
                  resource: [
                    `qcs::cos:${config.cos.Region}:uid/${appId}:${config.cos.Bucket}/${task.object_key}`
                  ]
                }
              ]
            }
          },
          (error, data) =>
            error
              ? reject(error)
              : resolve({
                  ...data,
                  startTime: Math.floor(Date.now() / 1000),
                  Bucket: config.cos.Bucket,
                  Region: config.cos.Region,
                  Key: task.object_key
                })
        )
      );
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
      if (config.storage !== 'local') throw new Error('云端上传请直接使用COS');
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
        if (config.storage === 'cos') {
          const head = await call('headObject', { Key: task.object_key });
          if (Number(head.headers['content-length']) !== Number(task.size)) {
            const e = new Error('云端文件大小不一致');
            e.status = 400;
            throw e;
          }
          const etag = head.headers.etag;
          if (!etag) throw new Error('无法确认云端文件版本');
          const content = await call('getObject', {
            Key: task.object_key,
            Range: 'bytes=0-63',
            IfMatch: etag
          });
          const mime = validateHeader(
            task,
            Buffer.isBuffer(content.Body) ? content.Body : Buffer.from(content.Body)
          );
          // Browser STS credentials can only write private/... . Freeze a server-only
          // copy before marking the task ready, so old credentials cannot replace it.
          const objectKey = `protected/${task.user_id}/${task.id}${path.extname(task.filename).toLowerCase()}`;
          const sourcePath = task.object_key.split('/').map(encodeURIComponent).join('/');
          await call('putObjectCopy', {
            Key: objectKey,
            CopySource: `${config.cos.Bucket}.cos.${config.cos.Region}.myqcloud.com/${sourcePath}`,
            CopySourceIfMatch: etag,
            MetadataDirective: 'Replaced',
            ContentType: mime,
            CacheControl: 'private, max-age=0'
          });
          const frozen = await call('headObject', { Key: objectKey });
          if (Number(frozen.headers['content-length']) !== Number(task.size))
            throw new Error('文件确认未完成，请重试');
          // Retain staging for crash recovery; an explicit COS lifecycle policy can
          // expire only private/... after at least seven days. protected/... is retained.
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
      return new Promise((resolve, reject) =>
        cos.getObjectUrl(
          {
            Bucket: config.cos.Bucket,
            Region: config.cos.Region,
            Key: task.object_key,
            Sign: true,
            Expires: 600
          },
          (e, d) => (e ? reject(e) : resolve(d.Url))
        )
      );
    },
    publishedVideoUrl(task) {
      if (!config.cdn?.origin || task.kind !== 'video' || !task.object_key.startsWith('protected/'))
        return null;
      return cdnUrl(config.cdn, task.object_key);
    }
  };
}
module.exports = { createStorage, detectMime, cdnUrl };
