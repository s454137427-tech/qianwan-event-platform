---
title: 阿里云 ECS 与私有 OSS 接入
updated: 2026-10-18
status: 历史方案，已由TOS替代
tags: [前湾MEGA/部署, 前湾MEGA/待发布]
---

# 阿里云 ECS 与私有 OSS 接入

> [!warning] 历史方案
> 2026-10-19用户决定采用火山服务器与TOS；当前代码不再运行ali-oss，以下保留上轮适配与采购评估追溯，不能照此配置当前生产。现行操作见 [[未来影像大赛征集站/deploy/火山TOS接入]]。

本手册对应基于 v2.2.3 的本地未提交适配，未购买资源、未上线、没有云端数据迁移。依据用户 2026-10-17 决定：全部改用阿里云，总预算上限 5000 元，计划一个月，尽量节省。旧部署包不含本次改动，不可直接使用。网页设计和业务规则保持现行行为。

## 1. 采购与配置边界

- 节省成本方案：同地域 ECS 一台、云盘、公网入口、私有标准 OSS；PostgreSQL 16 与 Redis 7 使用已有 `compose.aliyun.yaml` 同机扩展，不必另购 RDS 和云 Redis。4核8GB、60GB云盘是候选起点，须按报价和实测调整，不代表能承载1000人峰值。同机两应用实例仍有整机单点，数据库备份须离机保存。
- 托管方案可用阿里云 RDS PostgreSQL 和 Tair（Redis兼容）替代同机数据库，使用基础 `compose.yaml`，数据库连接串、认证、白名单、TLS/CA按实际资源配置；不同时启动两套数据库。两应用实例默认各12个数据库连接，托管连接额度须留出运维余量。
- OSS 默认直接提供签名播放，不需要 CDN、视频点播、转码或负载均衡产品；若以后启用 CDN，需要另做阿里云私有回源及鉴权适配。本次主动禁用原腾讯 TypeA 签名，不能把 CDN 域名填入 `OSS_PUBLIC_ORIGIN`。
- 域名与证书：网站子域名指向 ECS；另一个媒体子域名绑定 OSS。分别准备有效 HTTPS 证书。大陆备案主体、接入、子域使用权由域名负责人核对，不能只凭 DNS 推断已满足。
- 尚无订单和实时账号报价。5000元是总预算约束，不能仅把ECS价格控制在5000元。购买前把ECS/盘/快照备份、OSS存储/请求/公网播放流量和证书费用合计；OSS播放流量可能是主要变量，设置预算和账单告警、每日核对。告警和数据库逻辑上传额度都不是云账单硬封顶。
- 一个使用月不等于材料可在到期时删除；活动结束后15天的保留要求仍有效，须覆盖归档与恢复所需时间。1000份500MB原片约500GB，暂存和保护副本同时保留时约双倍，分片、历史版本及备份另计。根据实际量逐步购买容量包，避免提前买大套餐。

需要提供的非敏感值：ECS地域/规格/系统/公网IP、数据库同机或托管选择、私网主机名/端口/TLS方式、OSS桶名与地域、上传角色ARN、网站与媒体子域名、DNS和证书负责人、公众号AppID和授权能力、运营主体/咨询方式/规则与时间。密码、AccessKey Secret、微信Secret、证书私钥只在受限部署配置填写，不发到Wiki、Git或聊天。

## 2. OSS、RAM 与 STS

创建与 ECS 同地域的**私有标准存储桶**。开启阻止公共访问，不设公开读策略，不把报名材料或待审视频开放匿名读取。新桶暂不配置自动清理。上传暂存在 `private/<用户UUID>/<任务UUID>.<扩展名>`；完成后服务端验证大小、文件头及ETag，并条件复制到 `protected/`。保护副本显式设 private、正确 MIME、inline 和 private/no-store；超过1GiB使用条件分片复制。数据库仅在复制及复核成功后标记 ready。

参考 `oss-permissions.example.json`，将 `<ACCOUNT_ID>`、`<BUCKET>`、角色及RAM用户名替换后，分别创建策略，**不要把整个示例JSON当成一个RAM策略提交**：

1. 后台专用 RAM 用户：只能读取本桶的 `private/`、`protected/`，写入/设置private ACL/中止保护复制分片限 `protected/`，以及 AssumeRole 指定上传角色。后台无需删除对象或管理桶权限，不用主账号密钥。
2. 上传角色：信任该后台用户；仅允许 `private/*` 的 PutObject、ListParts、AbortMultipartUpload。后台每次再用会话策略把权限缩至**当前任务的单个对象**，有效期1800秒，不授予桶列表、GetObject、DeleteObject、PutObjectAcl或任何 `protected/` 权限，并显式拒绝带public-read/public-read-write ACL的写入。OSS的初始化、上传分片、合并由 `oss:PutObject` 权限覆盖。
3. 后台环境填写 RAM 用户的 AccessKey 与角色ARN。密钥仅留服务器受限配置，浏览器只接收当前任务的STS临时凭据，响应为 no-store。后台 RAM 用户与上传角色权限用途不同，不能把后台密钥写进网页。

文件确认接口重复请求是幂等的；PostgreSQL通过任务行锁跨实例串行确认。旧STS令牌在到期前仍可写暂存路径，但写不到受保护文件；确认完成后接口停止签发新凭据。完成响应丢失可重复确认恢复。真实资源仍须验证角色策略交集、ACL、条件复制和旧令牌攻击测试。

## 3. 自定义域名、HTTPS 与跨域

阿里云新开通OSS用户在中国大陆不能依赖默认公网Endpoint调用数据API；默认桶地址也有强制下载/预览限制。因此正式配置必须填写绑定此桶的独立HTTPS媒体域名，代码不会通过替换主机名伪造签名。

1. OSS控制台绑定媒体域名；按控制台要求添加域名所有权验证与CNAME，指向该桶要求的地址。启用该域名的HTTPS证书并安排续期。网站Nginx证书不会自动用于OSS媒体域名。媒体域名直接接OSS，不走网站Nginx或CDN。
2. `OSS_PUBLIC_ORIGIN=https://实际媒体域名`，不能带端口、路径、参数；不能是网站域名或 `*.aliyuncs.com` 默认地址。浏览器上传与私有播放都使用该CNAME，SDK设置 cname、HTTPS、authorizationV4。
3. `OSS_REGION=oss-cn-hangzhou`（按实际桶地域），**不是** `cn-hangzhou` 或腾讯地域名。`OSS_INTERNAL=true`只在同地域ECS能访问OSS内网时启用；后台读取和保护复制走内网，浏览器上传和签名链接仍走公网自定义域名。跨地域或本机调试用false。默认false便于接入；实际ECS部署建议验证内网后启用true节约传输。
4. 按示例配置桶CORS：只允许网站精确HTTPS来源；GET/HEAD/PUT/POST/DELETE；允许请求头 `*`（V4签名、临时令牌、Content-Type、Range等需要）；暴露ETag、x-oss-request-id、Content-Length、Content-Range等。OPTIONS预检由OSS处理。不要把CORS来源设为 `*`，也不要把CORS当成权限控制。多来源时按需启用 Vary: Origin。
5. 服务端 CSP 的 connect-src 只放行自身和配置的OSS媒体来源，浏览器SDK由网站本地提供，不从外部CDN加载。本地local预览不会加载OSS SDK。

## 4. 浏览器续传与播放

- SDK锁定 `ali-oss@6.23.0`，服务端与浏览器数据请求均用V4；播放必须用 `signatureUrlV4`，旧 `signatureUrl/asyncSignatureUrl` 仍是V1，不能混用。官方浏览器发行文件从已安装依赖本地提供，锁文件和依赖均需随新部署来源保留。
- 浏览器按5MiB分片、最多3个并行上传；保存任务ID对应的uploadId和已完成分片ETag到localStorage，只保存断点，不保存凭据和文件内容。刷新或暂停后重选同一文件可恢复；浏览器禁用持久存储时仅当前页面内存保留断点，换设备不会继承断点。
- 暂停调用SDK cancel中断请求、保留分片，不是销毁任务。每5分钟按需刷新STS；已过期令牌触发重新获取临时凭据并从断点重试；网络故障有上限退避重试。NoSuchUpload/分片被清理时先向后台确认是否已合并成功，再决定重建上传，避免丢失完成响应导致无法继续。最终确认失败仍可重选文件或重复确认恢复。
- 私有材料接口保留原角色/所有者校验。访客只可取得已公开作品视频的600秒OSS签名GET链接；身份资料仅所有者、管理员和审核员可读，评委无权读取。链接是短期持有者凭证，泄露后有效期内仍可使用；下架阻止新链接，已发链接并不会即时撤销。
- 播放链接不签固定Range，便于浏览器发送多次字节范围请求。须云测GET Range返回206、Content-Range/Accept-Ranges、Content-Type、HTTPS与拖动定位；过期后重新打开 `/api/media/<id>` 会重新做权限判断并签发地址。长时间打开页面/暂停后失败时需重新打开视频，无自动转码或长播放会话保证。MP4封装不保证编码可播放，至少用H.264/AAC MP4在真实微信、iOS Safari、Android测试；MOV/WebM仍沿用接收规则，兼容性实测后由运营决定是否限制。

## 5. ECS 部署操作（本轮未执行）

保持Node.js24、pnpm11.25.0及原Nginx+两个应用实例方式。ECS使用支持Docker的Linux镜像；安全组只开放80/443与限运维IP的22，不开放3000、5432、6379。数据库和Redis不映射公网端口。

先将 `.env.production.example` 复制为 `deploy/.env.production`，仅在服务器填真实配置并限制访问。`STORAGE_DRIVER=oss`，旧COS配置不再使用；删除旧 `VIDEO_CDN_ORIGIN/VIDEO_CDN_AUTH_KEY/VIDEO_CDN_AUTH_CONFIRMED`，只要启用旧CDN配置，检查和启动都会拒绝。

同机数据库扩展的连接配置（下列是格式占位符，不可直接照填）：

```dotenv
POSTGRES_PASSWORD=<原始强密码>
REDIS_PASSWORD=<原始强密码>
DATABASE_URL=postgresql://qianwan:<URL编码后的同一数据库密码>@postgres:5432/qianwan
DATABASE_SSL=false
REDIS_URL=redis://:<URL编码后的同一Redis密码>@redis:6379
```

Compose容器环境使用原始密码；连接串密码部分需URL编码，含 `$` 的env值按Compose规则使用单引号保留字面值。不要将 `docker compose config` 的完整输出贴回聊天，其中可能展开密钥。托管数据库按实际TLS要求用 `DATABASE_SSL=true`；私有CA通过只读挂载与 `NODE_EXTRA_CA_CERTS` 配置，不能关闭证书校验代替受信证书。

在项目根目录准备证书和微信验证文件后：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm deploy:prepare
pnpm deploy:check
docker compose --env-file deploy/.env.production -f deploy/compose.yaml -f deploy/compose.aliyun.yaml config --quiet
docker compose --env-file deploy/.env.production -f deploy/compose.yaml -f deploy/compose.aliyun.yaml up -d --build
docker compose --env-file deploy/.env.production -f deploy/compose.yaml -f deploy/compose.aliyun.yaml ps
```

托管数据库方案去掉每条命令中的 `-f deploy/compose.aliyun.yaml`。相对卷路径均以基础Compose所在deploy目录解析。同机持久数据在 `deploy/data/`，不打进镜像/部署包，不提交Git；数据库/Redis凭据只在主机保存。首次初始化和表迁移沿用已有事务与跨实例锁。

配置检查不连接云、不验证DNS/CNAME/证书，也不证明权限或播放成功。`/api/health`只检查数据库，`/api/ready`检查数据库/Redis。服务器没有Node时可构建镜像后 `docker compose --env-file deploy/.env.production -f deploy/compose.yaml run --rm --no-deps app1 node scripts/check-deployment.js`，入口文件仍需事先生成。

同机PostgreSQL可在线用 `pg_dump -U qianwan -d qianwan -Fc` 做逻辑备份，移至受限离机位置并在独立数据库验证 `pg_restore`；Redis启用AOF。不要直接拷贝正在写入的数据库目录当成一致备份，冷拷贝应先停写并干净停止数据库。快照与数据库备份均须实测恢复。归档ZIP不是数据库/视频备份。禁止执行 `down -v` 等清空操作作为常规升级步骤。

## 6. 上线前必做实测

1. 真实桶：匿名HEAD/GET身份照片、待审视频、protected对象拒绝；浏览器令牌不能读对象/列桶/改ACL/写protected或别人的暂存路径。核对阻止公共访问与IAM策略，不能只看示例。
2. 真实上传：照片、小视频、500MB视频；中途断网、暂停/重选、刷新页面、STS过期、限流/失败重试、分片生命周期失效和完成响应丢失。核对实际流量、内存、分片和多实例确认。
3. 条件确认：上传大小不符、伪造格式、读取后改写源ETag时应拒绝；确认后持旧STS覆盖暂存文件，protected副本保持原内容。失败不产生ready记录，重复确认恢复。
4. 真实播放：已公开视频匿名可取短链；身份照片/待审视频无权访问；签名过期/篡改拒绝；Range、拖动、HTTPS、自定义域名、CORS预检、微信/iOS/Android编码兼容实测。
5. 真实ECS：Docker镜像与Nginx启动、PostgreSQL两实例并发、Redis故障恢复、安全组、备份恢复、目标峰值及费用测算；真实微信授权、运营规则/阶段时间与人员账号确认后再开放报名和投票。

本地模拟验证代码行为，不是阿里云资源权限证明或上线验收；没有真实资源就不把上面项目记为完成。活动结束后按已确认范围归档、备份、验证恢复，再设置暂存/未完成分片/保护文件的不同清理策略，不能直接对全部对象设置“上传15天后删除”。

## 官方依据（2026-10-17至18查阅）

- [STS临时授权](https://www.alibabacloud.com/help/en/oss/sts-temporary-access-authorization)、[Browser.js初始化与令牌刷新](https://www.alibabacloud.com/help/en/oss/developer-reference/initialization)、[断点续传](https://www.alibabacloud.com/help/en/oss/developer-reference/resumable-upload-9)。
- [V4预签名URL](https://www.alibabacloud.com/help/en/oss/developer-reference/add-signatures-to-urls)、[Node.js签名下载](https://www.alibabacloud.com/help/en/oss/developer-reference/download-objects-using-a-presigned-url-generated-with-oss-sdk-for-node-js)。
- [自定义域名及新用户公网限制](https://www.alibabacloud.com/help/en/oss/user-guide/access-buckets-via-custom-domain-names)、[视频播放限制](https://www.alibabacloud.com/help/en/oss/how-to-play-videos-online-in-oss)、[CORS](https://www.alibabacloud.com/help/en/oss/user-guide/configure-cross-origin-resource-sharing/)。
- [条件复制与1GB限制](https://help.aliyun.com/zh/oss/developer-reference/copyobject)、[ECS购买](https://help.aliyun.com/zh/ecs/user-guide/create-an-instance-by-using-the-wizard)、[ECS备份与恢复](https://help.aliyun.com/zh/ecs/user-guide/disaster-recovery-solutions)。
