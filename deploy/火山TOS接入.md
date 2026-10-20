---
title: 火山服务器与私有TOS接入
updated: 2026-10-19
status: 本地适配完成，待真实资源验收
tags: [前湾MEGA/部署, 前湾MEGA/待发布]
---

# 火山服务器与私有 TOS 接入

适用主代码当前未提交工作区，基于2.2.3；不是新正式版本。来源：用户2026-10-19明确要求“火山服务器＋火山TOS”，预算总上限1500元、只使用一个月、尽量节省（用户2026-10-19后续更正，替代此前5000元）。尚未购买云资源，没有云端数据迁移，本轮未部署上线。原页面、最新主题及投稿限制、微信、审核、投票评分、后台与归档改动保留。

## 1. 开通什么

基础方案为火山ECS、云盘与公网入口、同地域TOS标准存储私有桶、IAM用户/角色与STS、两个域名的HTTPS证书。复用Docker+Nginx+两个应用实例；PostgreSQL16和Redis7可复用同机容器扩展，不必先购买托管数据库或缓存。`deploy/compose.volcengine.yaml`是从现有单机扩展接续的部署入口，数据仍在`deploy/data/`，不修改卷路径或清空旧数据。若选择托管PostgreSQL/Redis，使用基础Compose、填写实际私网连接/TLS/白名单，不同时启动同机数据库。

ECS可先核价4核8GB、60GB云盘等候选配置；这是起点，不是1000人并发保证。开放80/443，22只对运维IP放行，不开放3000、5432、6379。两应用默认各12个数据库连接，留出运维连接和内存余量。同机方案有整机单点，须安排离机备份和恢复演练。新正式数据库默认关闭报名/投票，验收后再开启。

不需要为本次基础方案购买CDN、视频点播、转码、Kubernetes或负载均衡。公网播放流量可能比主机费用更高；购买前合计主机/盘/备份、TOS存储/请求/下载流量与证书费用，按实际报价控制1500元总额，设置预算和用量告警。告警、上传容量配额和“使用一个月”都不是账单硬封顶。1000份500MB原片约500GB；暂存和保护副本同时保留时约双倍，未完成分片、版本、备份另计。保留规则仍为活动结束后15天，不擅自开启自动删除。

需要非敏感配置：ECS实际地域/规格/IP、数据库同机或托管选择、私网主机名/端口与TLS方式、TOS桶名/地域/原生Endpoint、上传角色TRN、DNS和证书负责人、公众号AppID及网页授权能力、运营资料。实际AK/SK、数据库密码、微信Secret、证书私钥只在受限部署配置保存，不发到Git、Wiki或聊天。

### 当前服务器购买建议（2026-10-19，未下单）

来源：用户要求立即自行购买服务器；以下为AI按现有部署结构给出的具体配置建议，不是已确认库存、报价或采购事实。火山ECS一台，华北2（北京）、x86计算型4vCPU/8GiB（例如ecs.c3i.xlarge），Ubuntu22.04 LTS64位公共镜像，60GiB极速型SSD系统盘，无额外数据盘；VPC/子网选择同地域现有或新建默认网络。实例包月1个月、关闭自动续费；分配公网IPv4，网络按实际流量计费、带宽峰值30Mbps。安全组80/443对外，22仅运维IP，不放行3000/5432/6379。服务器及盘预付报价控制约400元，公网IP配置费与实际流量另核；超过目标需复核，不把400元写成已取得的促销价。无需随单购买托管数据库、缓存、GPU、负载均衡或付费软件镜像。TOS后续选同地域。

官方核对：[计算型规格](https://docs.volcengine.com/docs/ecs/Computing-optimized?lang=en)、[公网IP计费](https://docs.volcengine.com/docs/ElasticIPAddress/Billingoverview-37?lang=zh)。尚未取得下单截图，备案接入及容量状态不因这份购买建议改变。

### 1500元／一个月的分配目标（非报价）

来源：用户2026-10-19后续更正预算并再次确认只用一个月；分配为AI建议，未下单。

| 项目 | 控制目标 |
| --- | --- |
| 单台ECS、云盘和网站公网费用 | 400元 |
| TOS存储和请求 | 150元 |
| TOS公网播放流量 | 700元 |
| 证书、备份及费用浮动预留 | 250元 |
| 合计 | 1500元 |

优先核4核8GB一个月优惠，超出主机目标时再评估2核4GB；均需实测，不承诺1000人并发。PostgreSQL/Redis同机，不另外购买托管产品，不因预算变化改动业务或保护机制。实际价格以控制台为准；未取得可用于本账号/地域的一月优惠报价。

播放规模依据：2026-10-19用户后续明确：播放流量按150名观看用户估算。范围为播放成本测算，报名人数、投稿量及同时在线容量目标保持现行记录；每人观看条数、视频平均大小和重播次数尚未确认。 原700元播放预留可保留为机动预算，不是必须预购的套餐。

流量示例仅用于解释费用：假设150人每人各看10条，按官方开发者文章列举的TOS公网流出刊例价0.5元/GB估算，每条100MB约150GB、75元；每条500MB约750GB、375元。观看条数和文件大小是AI测算假设，示例不含额外重播/预加载、存储与请求。此处十进制粗算，实际计费单位、重播/预加载、地域、资源包和优惠以真实账单口径核对，不视为当前合同单价。来源：[官方计费概述](https://docs.volcengine.com/docs/TorchObjectStorage/Billingoverview-2?lang=zh)、[火山开发者社区流量刊例价示例](https://developer.volcengine.com/articles/7516477483382734885)、[ECS计费与报价说明](https://docs.volcengine.com/docs/ecs/Billing-overview?lang=zh)，2026-10-19查阅。

新预算没有授权自动压缩、降低500MB上限、删除副本、缩短保留期或自动关闭服务；如实际播放预计超预算，需要另行确定流量优化或运营安排。账户预算告警不能代替硬封顶。

## 2. TOS 和临时权限

创建标准私有桶，桶ACL、对象默认ACL均设为私有，不添加匿名读或公共写策略。不要套用OSS策略或S3客户端配置。按`tos-permissions.example.json`分别创建策略；先替换`<ACCOUNT_ID>`、`<BUCKET>`、上传角色名和服务端IAM用户名，**示例整文件不是一个可整体提交的策略**。

- 后台专用IAM用户：读取本桶`private/`与`protected/`（GetObject含元数据读取）、仅写入及设置ACL于`protected/`，仅可AssumeRole指定上传角色。不给主账号密钥或管理桶/删对象权限。火山STS不允许主账号直接AssumeRole。
- 上传角色信任后台IAM用户；允许`private/*`的PutObject、ListMultipartUploadParts和AbortMultipartUpload。后台每次通过`AssumeRoleCommand`再加会话策略，缩至单个`private/<用户UUID>/<任务UUID>.<扩展名>`对象，有效1800秒。权限是角色策略与会话策略交集，不授权GetObject、列桶、删除、改ACL或`protected/`。配置角色最大会话时长至少1800秒。
- SDK初始化、上传分片和合并使用PutObject权限；列分片的策略动作是`tos:ListMultipartUploadParts`，不是沿用OSS的ListParts。会话策略与角色策略拒绝`x-tos-acl`为public-read/public-read-write/authenticated-read的写入；桶策略示例亦提供同样的拒绝。上传和保护复制均显式设置private。部署后必须实际验证策略效果，模拟测试不能证明IAM已经配置正确。
- 浏览器获取的是短期凭据，响应为no-store；凭据不写localStorage。后台先检查登录、CSRF、任务所有者及状态，ready任务停止签发新令牌。

上传暂存在`private/`。确认时核对大小，使用Range和If-Match读取文件头，再用copySourceIfMatch条件复制至服务端独占`protected/`，替换MIME/inline/no-store元数据并设置private；复制后复核大小、MIME、ETag，成功才写ready。TOS CopyObject支持小于5GiB，本项目上限2GiB，无需沿用OSS超过1GiB的分片复制分支。PostgreSQL任务行锁保持跨实例幂等确认。旧上传令牌仍可在到期前改暂存对象，但不能覆盖已提交保护副本。

## 3. SDK、续传和构建

运行依赖为官方`@volcengine/tos-sdk@2.9.1`与`@volcengine/sts@1.0.5`。已移除ali-oss和腾讯COS/STS运行依赖。不是S3兼容替换；使用TOS原生headObject、getObjectV2、copyObject、getPreSignedUrl及分片接口。

浏览器使用原生createMultipartUpload、uploadPart、listParts、completeMultipartUpload，5MiB分片、最多3并行。断点记录采用独立`tos-upload:<任务ID>`格式，只保存桶/对象/大小、uploadId、ETag与分片状态，不复用OSS断点、不保存文件字节或密钥。暂停使用AbortController中断XHR，保留分片；刷新后重选同一文件，先向TOS核对已保存分片，再补传缺失部分。禁用浏览器持久存储时仅当前页面内存可保留断点；换设备不能继承本机断点。

每次分片请求前检查凭据剩余时间，少于2分钟重新获取，刷新请求合并；服务端返回过期令牌错误时刷新并重试。网络/429/5xx有上限退避，权限错误不盲目重试。合并响应丢失遇到NoSuchUpload时，先调用后台确认已有对象；只有确认尚未形成文件才重建分片上传。确认失败保留任务供重选恢复。

`lib/browser-sdk.js`从官方ESM源码通过esbuild本地构建，云上传时加载`/vendor/tos.js`，不使用远端CDN或含旧依赖的预打包UMD。本地local预览不加载云SDK。CSP只放行网站自身和已配置媒体域名。

**依赖补丁必须随交付保留**：`pnpm-workspace.yaml`、锁文件及`patches/`共同锁定SDK兼容修正和安全依赖。官方2.9.1的预签名地域误用Endpoint、requestAdapter参数未生效，本项目补丁分别修正为实际region并使用传入适配器；Node生产和开发均使用该修正版源码构建。浏览器Axios兼容层保留SDK旧createError调用签名；Axios/protobufjs/uuid已使用审计兼容版本，不启用SDK未使用的代理中间件；CRC原生扩展和protobufjs安装脚本不运行，CRC关闭，不把文件头/ETag核验当成完整视频解码。不能删补丁或跳过冻结锁文件安装；更新SDK后应检查上游是否已修复，再调整补丁并重测。

## 4. 两个域名、证书与光影年年交接

| 用途 | 已确认域名 | 对方设置 | 我们提供的实际值 |
| --- | --- | --- | --- |
| 网站 | `mega.gynnai.com` | 主机记录mega，A记录 | 未来ECS的实际公网IPv4；目前未取得 |
| 媒体 | `media.gynnai.com` | 主机记录media，CNAME | 未来TOS绑定该自定义域名时控制台返回的实际CNAME值；目前未取得 |
| 域名归属验证 | 控制台要求的完整记录名 | 按要求TXT或CNAME | 绑定TOS时实际生成的验证值，不能自行猜测 |
| 两域名证书验证 | CA给出的完整记录名 | 按CA要求TXT或CNAME | 证书订单实际提供的验证值和TTL；证书续期时保持所需验证记录 |

不能把TOS_REGION/TOS_ENDPOINT当成媒体CNAME目标，也不能将media指向ECS。光影年年只需接收DNS/验证用的公开值，无需获得应用AK/SK、微信Secret或数据库密码。网站证书和私钥受限放在`deploy/certs/fullchain.pem`、`privkey.pem`；媒体证书覆盖media.gynnai.com，在TOS域名绑定的证书配置中关联相应证书/CertId。网站Nginx证书不会自动配置到TOS。域名绑定、DNS生效、证书与签名访问分别验证，保持HTTPS，不关闭证书校验。

实际DNS管理区域如为gynnai.com，一般主机记录写mega/media；如使用域名服务商要求的完整记录名则按实际控制台输入，避免重复后缀。同一主机名不同时保留冲突的A和CNAME。验证记录名称和值由资源创建或CA订单生成，不填写臆造的桶名/地址。

ICP备案按gynnai.com的实际主体和火山接入确认办理，不能套用gynn.xyz历史备案，也不能保证“同厂商只加解析即可”。本次沿用知识库已记录的京ICP备2026010345号-4及主体差异待确认事项；本轮未查控制台或独立重验。公众号实际验证文件放`deploy/wechat-verification/`，网页授权域名使用mega.gynnai.com，回调为`https://mega.gynnai.com/api/auth/wechat/callback`，由对应权限负责人配合。

## 5. 正式配置和CORS

复制`deploy/.env.production.example`为受限的`deploy/.env.production`，权限建议600。正式来源已按两域名填写；仍需真实资源值，空值会拒绝启动：

```dotenv
NODE_ENV=production
APP_ORIGIN=https://mega.gynnai.com
STORAGE_DRIVER=tos
TOS_ACCESS_KEY_ID=
TOS_ACCESS_KEY_SECRET=
TOS_BUCKET=
TOS_REGION=
TOS_ENDPOINT=
TOS_UPLOAD_ROLE_TRN=
TOS_PUBLIC_ORIGIN=https://media.gynnai.com
```

TOS_REGION填实际桶地域，例如cn-beijing；TOS_ENDPOINT填桶概览列出的同地域原生访问Endpoint，不带桶名或S3。服务端可在同地域ECS联通后填写控制台提供的内网Endpoint；本机测试或跨网络用公网Endpoint。浏览器始终访问media.gynnai.com，下载签名亦在该域名上生成，不对已有签名链接替换Host。配置检查验证格式和已确认域名，不连接云，也不能检验DNS/证书或权限。

按示例CORS配置精确来源`https://mega.gynnai.com`；GET/HEAD/PUT/POST/DELETE，AllowedHeaders为`*`以覆盖Authorization、x-tos-*、Range等，ExposeHeaders包含ETag、x-tos-request-id、Content-Length、Content-Range和Accept-Ranges，MaxAgeSeconds示例300。预检OPTIONS由TOS处理。CORS不是权限控制，不要开放公共读；如桶曾有默认公共策略，须单独清除并实测匿名请求拒绝。

旧OSS/COS环境变量不能替代TOS配置；旧VIDEO_CDN启用参数会拒绝启动。阿里云、腾讯云及火山CDN鉴权均未启用，不能把CDN域名填入媒体来源。当前是私有TOS直连短期签名方案。

## 6. Docker、数据库与启动（本轮未执行）

同机数据库设置POSTGRES_PASSWORD、REDIS_PASSWORD；DATABASE_URL使用postgres服务名，REDIS_URL使用redis服务名。容器环境密码为原始值，连接串中的密码需要URL编码；含`$`等字符时按Compose的env规则正确引用。同机DATABASE_SSL=false，数据库与缓存不暴露公网端口；托管服务按真实TLS证书和白名单设置，不禁用证书校验代替正确CA配置。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm deploy:prepare
pnpm deploy:check
docker compose --env-file deploy/.env.production -f deploy/compose.yaml -f deploy/compose.volcengine.yaml config --quiet
docker compose --env-file deploy/.env.production -f deploy/compose.yaml -f deploy/compose.volcengine.yaml up -d --build
docker compose --env-file deploy/.env.production -f deploy/compose.yaml -f deploy/compose.volcengine.yaml ps
```

使用托管数据库时去掉每条命令的同机扩展。部署来源必须含patches，Dockerfile在安装前复制补丁；镜像拉取、Node24、esbuild目标架构和Nginx均需在真实服务器验证。本机无Docker时不能记为容器通过。不要将展开密钥的`docker compose config`完整输出发回聊天。

`/api/health`检查数据库，`/api/ready`检查数据库和Redis，均不验证TOS或微信。PostgreSQL在线备份使用pg_dump，离机受限保存并在独立库做pg_restore演练；Redis启用AOF。冷拷贝数据目录先停止写入并干净停止数据库，不能直接复制活动数据库目录当一致备份。归档ZIP不含视频/证明原件，也不是数据库备份。不要用down -v作为升级操作。

## 7. 资源接入后必须实测

1. IAM与桶：匿名GET/HEAD拒绝身份材料、待审和保护对象；临时令牌只能写当前暂存对象及列/中止其分片，不能读对象/列桶/改公共ACL/写别人的对象或protected；旧STS覆盖暂存不影响保护副本。
2. 上传：照片、小文件、500MB真实视频；暂停、取消、刷新续传、断网/限流、1800秒凭据过期、断点丢失与合并响应丢失。分片不足或格式/大小不符不能形成ready。
3. 核验与复制：条件不匹配失败、保护副本大小/MIME/ETag复核、跨实例重复确认及故障后恢复；当前已有主题、每人2件/每主题1件等业务限制一并回归。
4. 播放：所有者、审核员、管理员、评委和访客分别验权；公开作品600秒签名可播放，篡改/过期拒绝；GET Range返回206并支持拖动。签名不固定Range，地址在有效期内可重复使用；下架阻止新地址，已签地址到期前不会立即撤销。长时间暂停后重新打开媒体接口刷新权限与地址。
5. 微信/iOS/Android真实视频编码；MP4封装和文件头不能保证可解码，无自动转码。真实微信扫码/授权/确认、人员角色、活动时刻、两实例PostgreSQL/Redis故障恢复、备份恢复、目标峰值及实际费用完成后再开放报名投票。

不自动设置生命周期；活动结束后15天的保留规则不等于上传15天后删除。临时对象、未完成分片、保护文件、版本和备份的清理范围与时间须在归档、核对恢复后确认。本地模拟通过只证明代码行为，不能记录为正式上线验收。

## 官方依据（2026-10-19查阅）

- [官方Node/Browser SDK源码](https://github.com/volcengine/ve-tos-js-sdk)、[Node初始化参数](https://docs.volcengine.com/docs/TorchObjectStorage/InitializingtheClientNodejsSDK?lang=zh)、[AssumeRole](https://docs.volcengine.com/docs/6257/86374?lang=zh)。
- [分片上传权限与限制](https://docs.volcengine.com/docs/TorchObjectStorage/MultipartUploadGoSDK?lang=en)、[ListParts](https://docs.volcengine.com/docs/TorchObjectStorage/ListParts?lang=en)、[权限与条件键](https://docs.volcengine.com/docs/TorchObjectStorage/Bucketpolicytemplatesandparameters?lang=en)、[权限配置概述](https://docs.volcengine.com/docs/TorchObjectStorage/Overview-3?lang=zh)。
- [URL签名](https://docs.volcengine.com/docs/TorchObjectStorage/URLcontainsasignature?lang=zh)、[地域与Endpoint](https://docs.volcengine.com/docs/TorchObjectStorage/Regionsandendpoints?lang=zh)、[复制与预签名FAQ](https://docs.volcengine.com/docs/TorchObjectStorage/APIs?lang=zh)、[自定义域名API](https://docs.volcengine.com/docs/TorchObjectStorage/PutBucketCustomDomain?lang=zh)、[CORS API](https://docs.volcengine.com/docs/TorchObjectStorage/PutBucketCORS?lang=zh)。
