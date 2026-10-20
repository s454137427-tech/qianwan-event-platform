// TOS multipart protocol. Persistent checkpoints contain no credentials or file bytes.
(function (root) {
  function createTosUploader({
    api,
    loadSdk,
    storage,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  }) {
    const memory = new Map();
    const paused = () => new Error('上传已暂停，重新选择同一文件即可继续。');
    const cacheKey = (task) => `tos-upload:${task.id}`;
    function read(task) {
      try {
        return JSON.parse(storage?.getItem(cacheKey(task)) || 'null') || memory.get(cacheKey(task));
      } catch {
        return memory.get(cacheKey(task));
      }
    }
    function save(task, value) {
      memory.set(cacheKey(task), value);
      try {
        storage?.setItem(cacheKey(task), JSON.stringify(value));
      } catch {
        /* Memory fallback. */
      }
    }
    function clear(task) {
      memory.delete(cacheKey(task));
      try {
        storage?.removeItem(cacheKey(task));
      } catch {
        /* Best effort. */
      }
    }
    const expired = (error) =>
      ['ExpiredToken', 'SecurityTokenExpired', 'InvalidSecurityToken', 'InvalidToken'].includes(
        error.code
      );
    const status = (error) => error.statusCode ?? error.status;
    const transient = (error) =>
      !status(error) || status(error) < 0 || status(error) === 429 || status(error) >= 500;
    const validEtag = (value) => typeof value === 'string' && /^[a-f0-9"]+$/i.test(value);
    async function upload(task, file, { signal, progress }) {
      let rejectStop;
      const stopped = new Promise((resolve, reject) => {
        rejectStop = reject;
      });
      const cancel = () => rejectStop(paused());
      signal.addEventListener('abort', cancel);
      const check = () => {
        if (signal.aborted) throw paused();
      };
      const wait = (promise) => Promise.race([promise, stopped]);
      let info, refreshing, client, clientToken, checkpoint;
      try {
        check();
        const SDK = await wait(loadSdk());
        async function credentials(force = false) {
          check();
          if (force) info = undefined;
          if (info && Date.parse(info.expiration) - now() > 120000) return info;
          if (!refreshing)
            refreshing = wait(
              api(`/api/uploads/${task.id}/credentials`, { method: 'POST', signal })
            )
              .then((value) => {
                check();
                if (
                  !value.accessKeyId ||
                  !value.accessKeySecret ||
                  !value.stsToken ||
                  !Number.isFinite(Date.parse(value.expiration)) ||
                  Date.parse(value.expiration) - now() <= 120000
                )
                  throw Object.assign(new Error('临时凭据有效期不足，请重试'), { status: 503 });
                info = value;
                return value;
              })
              .finally(() => {
                refreshing = undefined;
              });
          return refreshing;
        }
        async function request(method, args) {
          for (let retry = 0; ; retry++) {
            check();
            const c = await credentials();
            if (clientToken !== c.stsToken) {
              client = SDK.createUploadClient(
                {
                  accessKeyId: c.accessKeyId,
                  accessKeySecret: c.accessKeySecret,
                  stsToken: c.stsToken,
                  region: c.region,
                  endpoint: c.endpoint,
                  bucket: c.bucket,
                  isCustomDomain: true,
                  secure: true,
                  enableVerifySSL: true,
                  requestTimeout: 60000,
                  maxRetryCount: 2,
                  enableCRC: false
                },
                signal
              );
              clientToken = c.stsToken;
            }
            try {
              return await wait(client[method]({ bucket: c.bucket, key: c.key, ...args }));
            } catch (error) {
              check();
              if (!expired(error) || retry >= 2) throw error;
              await credentials(true);
            }
          }
        }
        const c = await credentials();
        const saved = read(task);
        if (
          saved?.version === 1 &&
          saved.bucket === c.bucket &&
          saved.key === c.key &&
          saved.region === c.region &&
          saved.size === file.size &&
          saved.partSize === task.chunkSize &&
          typeof saved.uploadId === 'string' &&
          saved.uploadId.length > 0
        )
          checkpoint = { ...saved, parts: [] };
        const total = Math.ceil(file.size / task.chunkSize);
        const expectedSize = (number) =>
          Math.min(task.chunkSize, file.size - (number - 1) * task.chunkSize);
        function report() {
          check();
          save(task, checkpoint);
          const bytes = checkpoint.parts.reduce((sum, part) => sum + part.size, 0);
          progress(
            Math.round((bytes / file.size) * 95),
            `${file.name} · ${checkpoint.parts.length}/${total} 分片已保存`
          );
        }
        for (let attempt = 0; ; attempt++) {
          check();
          try {
            if (!checkpoint) {
              const init = await request('createMultipartUpload', {
                acl: 'private',
                contentType: file.type || 'application/octet-stream'
              });
              check();
              if (!init.data.UploadId) throw new Error('未收到分片任务编号');
              checkpoint = {
                version: 1,
                bucket: c.bucket,
                key: c.key,
                region: c.region,
                size: file.size,
                partSize: task.chunkSize,
                uploadId: init.data.UploadId,
                parts: []
              };
              report();
            } else {
              // Reconcile against TOS; a part response can be lost after bytes were saved.
              const parts = [];
              let marker = 0;
              for (;;) {
                const result = await request('listParts', {
                  uploadId: checkpoint.uploadId,
                  partNumberMarker: marker,
                  maxParts: 1000
                });
                for (const part of result.data.Parts || []) {
                  if (
                    !Number.isInteger(part.PartNumber) ||
                    part.PartNumber < 1 ||
                    part.PartNumber > total ||
                    Number(part.Size) !== expectedSize(part.PartNumber) ||
                    !validEtag(part.ETag)
                  )
                    throw Object.assign(new Error('云端分片信息不一致'), { status: 409 });
                  parts.push({ number: part.PartNumber, size: Number(part.Size), etag: part.ETag });
                }
                if (!result.data.IsTruncated) break;
                if (!(result.data.NextPartNumberMarker > marker))
                  throw new Error('云端分片分页无进展');
                marker = result.data.NextPartNumberMarker;
              }
              checkpoint.parts = parts;
              report();
            }
            const done = new Set(checkpoint.parts.map((part) => part.number));
            const todo = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !done.has(n));
            let cursor = 0,
              failure;
            const workers = Array.from({ length: Math.min(3, todo.length) }, async () => {
              while (!failure && cursor < todo.length) {
                const number = todo[cursor++];
                try {
                  const result = await request('uploadPart', {
                    uploadId: checkpoint.uploadId,
                    partNumber: number,
                    body: file.slice(
                      (number - 1) * task.chunkSize,
                      Math.min(number * task.chunkSize, file.size)
                    )
                  });
                  check();
                  if (!validEtag(result.data.ETag))
                    throw Object.assign(new Error('缺少分片ETag，请检查CORS'), { status: 400 });
                  checkpoint.parts.push({
                    number,
                    size: expectedSize(number),
                    etag: result.data.ETag
                  });
                  report();
                } catch (error) {
                  failure ||= error;
                }
              }
            });
            await wait(Promise.all(workers));
            check();
            if (failure) throw failure;
            await request('completeMultipartUpload', {
              uploadId: checkpoint.uploadId,
              parts: checkpoint.parts
                .slice()
                .sort((a, b) => a.number - b.number)
                .map((p) => ({ partNumber: p.number, eTag: p.etag }))
            });
            check();
            return; // Checkpoint is removed only after application confirmation.
          } catch (error) {
            check();
            if (error.code === 'NoSuchUpload') {
              try {
                await wait(api(`/api/uploads/${task.id}/complete`, { method: 'POST', signal }));
                return;
              } catch (confirmation) {
                if (![400, 404].includes(status(confirmation))) throw confirmation;
              }
              clear(task);
              checkpoint = undefined;
            } else if (!transient(error) || attempt >= 3) {
              throw new Error('云端上传中断，请重新选择同一文件继续；如持续失败请联系工作人员。');
            }
            if (attempt >= 3) throw new Error('云端上传中断，请重新选择同一文件继续。');
            progress(0, '网络波动，正在核对已保存分片并重试…');
            await wait(sleep(1000 * 2 ** attempt));
          }
        }
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    }
    return { upload, clear };
  }
  if (typeof module === 'object' && module.exports) module.exports = { createTosUploader };
  else root.createTosUploader = createTosUploader;
})(globalThis);
