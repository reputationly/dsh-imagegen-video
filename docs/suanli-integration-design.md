# 「创作」：团团TV 并入蒜狸小助手 —— 设计与执行文档

本文是开发 Agent 的执行依据，也是验收方的验收依据。按「工作包（WP）」顺序执行；每个 WP 都列出要改的文件、实现要求、**自测标准**（开发方提交前必须自己跑通并在 PR 里贴结果）和**验收条件**（验收方逐条核对，编号 `AC-x.y`）。文中没写到的行为，保持现状不改。

## 0. 背景与范围

### 0.1 目标

1. 团团TV 以「创作」的名字成为蒜狸小助手的一级入口：侧栏一行「创作」，点击后在中心列打开工作台，与会话、任务同级。
2. 用户登录小助手后**无需任何配置**即可生图/生视频：模型、模式、参数全部来自 new-api 的能力清单 `GET /v1/ov/capabilities`，每次启动自动拉取。
3. 只用自家网关（`https://maas.ovaijisuan.com/v1`）和小助手的账号凭据；第三方渠道、订阅登录、独立密钥全部删除。
4. 界面上不再出现「团团TV」字标/logo、GitHub 链接、插件自更新。
5. 工作台按中心列实际宽度自适应，所有模块（生图、生视频、无限画布、画廊、模板库、电商套图、服饰穿戴、A+、海报、复刻、PPT 等）都保留并适配。
6. 模板库图片只从国内地址加载：精简后的约 600 张图托管在 `hero.ovaijisuan.com/creative-templates/`（maas-landingpage 的 EdgeOne 项目）。
7. 对小助手本体的影响限于：依赖地址、默认插件列表、桌面端写入的 profile 补丁。

### 0.2 非目标

- 不改 new-api（能力清单已满足需求；如 WP7 实测发现缺字段，另起需求，不在本文范围内实现）。
- 不改小助手的会话、模型选择器、侧栏/布局框架和槽位定义。
- 不改团团TV 的 LICENSE / NOTICE / THIRD_PARTY_NOTICES.md（Apache-2.0 要求发行包保留）。
- 不改 npm 包名 `@q253595422/dsh-imagegen-video` 和插件内部 id `imagegen`（改了会丢失用户已有设置、画廊和历史）。

### 0.3 基线

| 仓库 | 基线 | 说明 |
|---|---|---|
| `reputationly/dsh-imagegen-video` | `origin/feat/maas-adapter` @ `3391688` | 已有 h3-image / h3-v2 协议适配、槽位入口（`src/client/slot-surface.tsx`） |
| `reputationly/deepseek-harness` | `master` @ `278e8398b1` | 宿主 |
| `reputationly/new-api` | `main` @ `b1872611c` | 只读参考：`router/ov-router.go`、`controller/ov.go`、`service/ovcaps/ovcaps.go` |
| `reputationly/maas-landingpage` | `main` @ `8466390` | 模板图片托管（WP8） |

### 0.4 分支与 PR 规则

- dsh-imagegen-video：从 `feat/maas-adapter` 拉分支 `suanli/creative`，每个 WP 一个提交（提交信息中文，`feat(creative): WPn …`），P1（WP1–WP5、WP9 的插件侧）完成后开一个 PR 到 `feat/maas-adapter`；P2（WP6–WP8）第二个 PR。
- deepseek-harness：WP9 宿主侧单独一个 PR 到 `master`，遵守仓库 `AGENTS.md`、`packages/AGENTS.md` 与 `dsh-pr-description` skill；用户可见 GUI 变化按 `record-browser-gif` skill 附 GIF。
- maas-landingpage：WP8 单独一个 PR 到 `main`。
- 不推 main/master，不 force-push，不合并 PR；合并由验收方在验收通过后决定。

### 0.5 术语

| 词 | 含义 |
|---|---|
| 网关 | new-api 部署 `https://maas.ovaijisuan.com/v1` |
| 能力清单 / 目录 | `GET /v1/ov/capabilities` 的响应 |
| 账号凭据 | 小助手 Host 凭据服务里的 `AURORA_API_KEY`，登录后由账号流程写入 |
| 网关渠道 | 本文新增的、由目录生成的只读虚拟渠道，id 固定为 `suanli-gateway` |
| 聚合模型 | new-api 的多段流水线模型（如 `minimax-h3-image-enhanced`、`minimax-h3-2k`），对客户端就是一个普通模型名 |

## 1. 总体架构

```
            小助手 Host（Node）                                   Client（Web/桌面渲染进程）
┌────────────────────────────────────────────┐        ┌───────────────────────────────────┐
│ credentials 服务 ── AURORA_API_KEY         │        │ 侧栏「创作」(sidebar.panellist)      │
│        │ resolve()                          │        │ 中心列工作台 (main, key=imagegen)   │
│        ▼                                    │  HTTP  │   ├ 模型/模式/参数 ← 网关目录        │
│ imagegen Host                               │◀──────▶│   ├ 状态条（未登录/未实名/离线…）   │
│  ├ GatewayCatalog（新）: 拉取/缓存/状态      │ 同源   │   └ 各模块工作区                    │
│  ├ 网关渠道 suanli-gateway（只读，内存）     │ /imagegen/*                                  │
│  ├ engine.ts / video-engine.ts（沿用）       │        └───────────────────────────────────┘
│  └ Agent 工具 generate_image / … （沿用）    │
└──────────────┬─────────────────────────────┘
               │ Bearer <账号凭据>
               ▼
     new-api: /v1/ov/capabilities, /v1/ov/files, /v1/images/*, /v1/videos*
```

要点：

- 密钥只在 Host 进程内存里用，**不写入设置文档、不下发给 Client、不进日志和诊断**。
- 目录只由 Host 拉取；Client 通过插件已有的同源 HTTP 路由（`src/routes.ts` 挂在 `ctx.webServer` 上）读取目录快照与状态。
- 提交链路第一期沿用插件自己的 `engine.ts` / `video-engine.ts`（已按 h3 契约实现并有 `smoke-maas-*`），只把「渠道 + 密钥」来源换成网关渠道 + 账号凭据。改走宿主 `suanliMedia` 是 WP10，本期不做。

## 2. 契约

### 2.1 Host 配置（插件根 `imagegen` 的 Config 新增字段）

```ts
gateway: z.object({
  baseURL: z.string().default(''),          // 例 https://maas.ovaijisuan.com/v1
  credential: z.string().default(''),       // 凭据引用名，例 AURORA_API_KEY
  capabilitiesPath: z.string().default('/v1/ov/capabilities'),
  timeoutMs: z.number().default(10_000),
}).default({})
```

- 值由宿主桌面端 profile 补丁写入（WP9），插件里**不写死**网关地址和凭据名。
- `baseURL` 或 `credential` 为空 ⇒ 目录状态为 `not-configured`，工作台显示「当前版本未配置模型网关」，其余功能不受影响。
- `capabilitiesPath` 与 `baseURL` 拼接规则与宿主 `suanli-model-catalog` 一致：取 `new URL(baseURL).origin + capabilitiesPath`。

### 2.2 凭据读取

- 通过 `ctx.get('credentials')` 可选读取（不加进 `inject`，保证宿主没有凭据服务时插件照常加载），调用 `resolve(credentialRef(config.gateway.credential))`，取 `value`。引用名合法性用 `@deepseek-ai/dsh-credentials` 的 `credentialRef`；若插件不便依赖该包，用同一正则在本地校验并在代码注释里注明来源 `packages/credentials/credentials/src/index.ts`。
- 每次拉目录、每次提交任务时都重新 `resolve`（凭据服务约定使用方不跨操作缓存）。
- 取不到值 ⇒ 状态 `signed-out`。

### 2.3 能力清单（new-api 响应，只列插件用到的字段）

来源：`new-api/service/ovcaps/ovcaps.go`。

```jsonc
{
  "version": "string",                 // 目录变化时变化
  "capabilities": [{
    "id": "generate_image:minimax-h3-image-enhanced",
    "operation": "generate_image" | "generate_video" | "generate_music" | "generate_speech" | "chat",
    "model": "minimax-h3-image-enhanced",          // 提交时用的模型名
    "displayName": { "zh": "...", "en": "..." },
    "description": { "zh": "...", "en": "..." },
    "transport": { "kind": "..." },
    "taskTypes": ["t2i", "i2i"],                    // 可缺省
    "paramSchema": { "properties": { "<参数>": { "type": "string", "enum": [...] } } },
    "limits": { "maxReferenceImages": 0, "maxDurationSeconds": 0, "maxInputBytes": 0 },
    "modes": [{ "id": "...", "label": {"zh":"","en":""}, "taskType": "...",
                "taskTypeIfSingleImage": "...",
                "references": { "image": {"min":0,"max":0}, "video": {...}, "audio": {...} },
                "requiresSourceVideo": false, "note": {"zh":"","en":""} }],
    "default": true
  }]
}
```

- 目录已按令牌分组、令牌模型白名单、聚合模型白名单裁剪：**出现在目录里的就是这个账号能调的**，插件不再做额外过滤（只按 `operation` 分类）。
- 插件只使用 `operation ∈ {generate_image, generate_video}` 的条目；其他条目忽略但不报错。
- 未知字段忽略；必填字段 `id/operation/model` 缺失的条目丢弃并记一条诊断（不含密钥）。
- HTTP 状态映射：`200` 且至少一条可用 ⇒ `ready`；`200` 但可用条目为 0 ⇒ `empty`；`401` ⇒ `unauthorized`；`403` 且错误体表明需实名（new-api `KYCRequired` 中间件）⇒ `kyc-required`，其他 `403` ⇒ `unauthorized`；`429` ⇒ `rate-limited`；网络错误/超时/`5xx` ⇒ `unreachable`。开发方需读 `new-api/middleware` 里 `KYCRequired` 的实际响应体，确定判定条件并写进测试夹具。

### 2.4 GatewayCatalog 状态与缓存

```ts
type CatalogStatus = 'not-configured' | 'signed-out' | 'loading' | 'ready' | 'empty'
                   | 'unauthorized' | 'kyc-required' | 'rate-limited' | 'unreachable'

interface CatalogSnapshot {
  status: CatalogStatus
  version: string | null          // 最近一次成功目录的 version
  fetchedAt: number | null        // 最近一次成功的毫秒时间戳
  image: GatewayModel[]           // operation=generate_image
  video: GatewayModel[]           // operation=generate_video
  error?: string                  // 面向用户的中文原因，不含密钥/URL 查询串
}
```

- **刷新时机**：插件 Host `apply` 后立即一次（不阻塞 `apply` 返回）；凭据变化时（登录/退出；监听凭据服务事件，若无事件则在每次工作台打开时检查凭据是否变化）；用户在工作台点「刷新」；距上次成功超过 30 分钟且工作台被打开时。并发刷新合并为一个请求。
- **失败不清空**：任何失败都保留上一份成功目录（`image/video` 不变），只更新 `status/error`。
- **磁盘缓存**：成功目录写入插件数据目录 `gateway-catalog.json`（只含目录，不含凭据），启动时先读缓存作为初始快照（`status` 先为 `loading`），再发请求。
- **版本变化**：`version` 变化时通知 Client 刷新（沿用插件现有的 Client 轮询/事件机制，没有就由 Client 在工作台可见时每 60 秒拉一次快照）。
- **路由**：在 `src/routes.ts` 增加 `GET /imagegen/gateway/catalog`（返回 `CatalogSnapshot`）与 `POST /imagegen/gateway/refresh`（触发刷新并返回刷新后的快照），沿用现有路由的鉴权方式。

### 2.5 网关渠道

- 由快照生成一个只读渠道对象，形状与现有 `channels[]` 元素一致，供 `engine.ts` / `video-engine.ts` / Agent 工具直接复用：
  - `id: 'suanli-gateway'`，`name: '蒜狸网关'`，`apiUrl: config.gateway.baseURL`，`protocol: 'auto'`，`auth: 'api-key'`；
  - `models = image.map(m => ({ alias: m.displayName.zh || m.model, id: m.model }))`，`videoModels` 同理；
  - 密钥在发请求那一刻由 2.2 取得，**不放进渠道对象**。
- 所有读取 `config.channels` / `channelSecrets` / `defaultChannelId` 的代码改为只读网关渠道。现有引用位置（19 个文件）用下面命令列出，逐个改完后该命令在 `src/` 下应只剩迁移代码：
  `grep -rlE "channelSecrets|defaultChannelId|channels-form" src`
- 默认模型：用户上次选择（`defaultModel` / `defaultVideoModel`）仍在目录里则沿用；否则取目录中 `default: true` 的条目；否则取第一条。

### 2.6 协议族判定

- 现有按模型名判定协议族的逻辑（`model-catalog.ts` / `video-model-catalog.ts` / `presets.ts` 里的 h3 族）保留，作为**提交协议**的判定依据（本期网关只有 h3 族，`smoke-maas-*` 覆盖）。
- 目录里出现插件不认识的模型族时：模型照常显示，提交时按 `operation` 走网关通用端点（图像 `/images/generations`，视频 `/videos` + `metadata.image_mode = mode.taskType`），失败按 2.3 映射给出原因。

## 3. 工作包

### WP1 去品牌：字标/logo、GitHub 链接、自更新（P1）

**改动**

1. `src/client/ImageGenPanel.tsx` 头部（约 3697–3760 行）：删除 `<BrandMark />`、`css.githubLink` 链接、`updateArea` 更新按钮与弹层，标题改为 `tt('panel.title')`，文案「创作」。删除只为它们服务的状态、副作用与 CSS 类（`githubLink`、`updateArea` 等）。
2. 删除 `src/client/BrandMark.tsx` 及其引用；`assets/` 中只被它使用的团团TV 图形一并删除；`icon.png` 换成「创作」图标（与小助手侧栏图标风格一致，单色线性，用 `currentColor`）。
3. 删除 `src/updater.ts`、其路由（`src/routes.ts` 中 update 相关）、`protocol.ts` 里的 `UpdateInfo` 等只为更新服务的类型、`dsh-plugin-sync.ps1`；插件版本随小助手发布。
4. 文案（`src/client/locales.ts` 全部语言）：所有「团团TV / TuanTuan TV / 团团」改为「创作」或去掉品牌词；删除 `panel.githubTip`。设置标题 `settings.title` 改为「创作」。
5. 其他 GitHub 外链：
   - `TemplateLibrary.tsx` 详情里的「GitHub」链接 → 改为纯文本署名「来源：<作者/仓库名>」，不可点击（CC BY、handraw 要求保留署名）。
   - `OutfitReferencePicker.tsx`「查看原始来源 ↗」→ 随 WP8 服饰姿势库下线一并删除。
   - `PptSetup.tsx` 的 `PPT_SKILL_URL`、`canvas.skills.skillMissing` 中的 GitHub 地址 → 改为「请在技能库中安装 image-to-editable-ppt」，不出现网址。
   - `canvas.skills.libraryUrlPlaceholder` 是用户输入示例，保留但改为中性示例 `https://…/SKILL.md 或 zip 地址`。
6. `package.json`：`description` 改中文「蒜狸小助手的生图与生视频工作台：文生图、图生图、文生视频、首尾帧、参考生视频、无限画布、画廊与模板库。」；`homepage`、`repository`、`bugs` 字段删除或指向 `reputationly/dsh-imagegen-video`（不对用户展示）。开发方需确认小助手「插件管理」读取哪个字段作为显示名，让它显示「创作」。
7. README.md 首屏改为「创作（蒜狸小助手内置）」，去掉群二维码、赞助、上游宣传；保留上游致谢一段和 LICENSE/NOTICE 说明。

**自测标准**

- `pnpm typecheck && pnpm build` 通过。
- 新增 `scripts/verify-no-brand.mjs`（并加入 `pnpm test`）：扫描 `src/`、`lib/`、`index.js`、`locale/`、`assets/`（文本文件），以下任一出现即失败：`团团`、`TuanTuan`、`tuantuan`（大小写不敏感）、`github.com/q253595422`、`api.github.com`、`githubTip`、`BrandMark`。白名单仅限：`LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`、`CHANGELOG.md`、`docs/`、`package.json` 的 `name`。
- 在 `verify-negative.mjs` 中加 `no-brand` 用例：临时往 `src/` 写一个含「团团TV」的文件，脚本必须失败。

**验收条件**

- AC-1.1 打开工作台，头部只有「创作」标题和模块 tab，没有字标/logo、GitHub 图标、更新按钮。
- AC-1.2 全插件界面（含设置页、诊断页、模板详情、画布技能提示、空状态、错误提示）搜不到「团团」和任何可点击的 github.com 链接。
- AC-1.3 运行期间不访问 `api.github.com`（验收方用代理/抓包或 `NODE_DEBUG` 观察出站请求）。
- AC-1.4 `node scripts/verify-no-brand.mjs` 与其反向用例均按预期通过/失败。

### WP2 网关目录服务（P1）

**改动**

1. 新增 `src/gateway-catalog.ts`：实现 2.2–2.4。纯逻辑（解析、状态映射、合并、默认模型选择）与 I/O（fetch、凭据、磁盘）分开，纯逻辑可单测。
2. `src/index.ts`：Config 加 2.1 的 `gateway` 字段；`apply` 中创建 GatewayCatalog 实例，生命周期挂在插件 ctx 上（dispose 时停止定时器、取消在途请求）。
3. `src/routes.ts`：加 2.4 的两个路由。
4. Client：新增 `src/client/gateway-status.tsx`（状态条组件）和一个读取快照的 hook；工作台顶部展示状态条：
   | 状态 | 文案 | 操作 |
   |---|---|---|
   | `loading`（有缓存） | 不显示 | — |
   | `loading`（无缓存） | 正在获取可用模型… | — |
   | `signed-out` | 登录后即可使用创作功能 | 「去登录」→ 打开小助手账号登录（复用宿主现有入口；没有可调用入口则提示到「设置 → 账号」） |
   | `kyc-required` | 根据平台要求，完成实名认证后才能生成图片和视频 | 「去认证」→ 打开网关实名页（地址由开发方从 new-api 前端路由确认） |
   | `unauthorized` | 账号凭据已失效，请重新登录 | 「去登录」 |
   | `rate-limited` | 请求过于频繁，请稍后再试 | 「重试」 |
   | `unreachable` | 暂时连不上模型服务，正在使用上次的模型列表 / 暂时连不上模型服务 | 「重试」 |
   | `empty` | 当前账号暂无可用的图像/视频模型 | 「刷新」 |
   | `not-configured` | 当前版本未配置模型网关 | — |
   生成按钮在没有可用模型时禁用并显示同一原因。

**自测标准**

- 新增 `scripts/smoke-gateway-catalog.mjs`（加入 `pnpm test`），起本地 HTTP 假网关，覆盖：
  1. 正常目录（含 2 个图像模型、4 个视频模型，其中 `minimax-h3-image-enhanced` 与 `minimax-h3-2k` 为 `default`）⇒ `ready`，分类、默认模型正确；
  2. 请求头带 `Authorization: Bearer <假凭据>`，且凭据不出现在快照、磁盘缓存、诊断记录里（对三者做字符串搜索）；
  3. 401 / KYC 403 / 普通 403 / 429 / 500 / 超时 / 连接拒绝 ⇒ 对应状态，且上一份成功目录保留；
  4. 200 空目录 ⇒ `empty`，保留旧目录；
  5. 缺必填字段的条目被丢弃，其余条目正常；
  6. 未配置 `baseURL` ⇒ `not-configured` 且不发请求；凭据为空 ⇒ `signed-out` 且不发请求；
  7. 两次并发刷新只发一个请求；
  8. 写入缓存后新建实例，首个快照来自缓存；
  9. dispose 后不再发请求、定时器清空（用假时钟或检查句柄）。
- `verify-negative.mjs` 加 `gateway-catalog` 用例：把状态映射里 401 改成 `ready`，smoke 必须失败。

**验收条件**

- AC-2.1 在已登录的小助手里，冷启动后不做任何操作打开「创作」，模型列表与 `curl -H "Authorization: Bearer $AURORA_API_KEY" https://maas.ovaijisuan.com/v1/ov/capabilities` 中 `generate_image` / `generate_video` 条目一一对应（名称用 `displayName.zh`）。
- AC-2.2 断网启动：有缓存时显示上次的模型并提示「暂时连不上模型服务」；恢复网络后点「重试」恢复 `ready`。
- AC-2.3 退出登录后，状态变为 `signed-out`、生成按钮禁用；重新登录后无需重启即恢复。
- AC-2.4 插件设置文档（小助手设置文件中 `imagegen` 段）和插件数据目录里搜不到账号凭据。
- AC-2.5 `smoke-gateway-catalog.mjs` 9 项全过，反向用例失败。

### WP3 删除第三方渠道与相关功能（P1）

**改动**

1. 删除渠道编辑 UI：`src/client/channels-form.ts`、`SettingsCard.tsx` 中渠道/预设/订阅/提示词增强接口/对象存储（`storage*`）段落；设置页只保留：Agent 是否可生图/生视频（`allowAgentImageGeneration` / `allowAgentVideoGeneration`）、是否向 Agent 介绍本插件（`announceToAgent`）、本地存储目录（`localStoragePath`）、画布技能（`skillsEnabled`、`allowHeavySkills`、`skillAllowlist`、`skillOutputDir`、`skillHeavyTimeoutMinutes`、`skillAgentPreset`、技能配置）。
2. 删除：`src/subscription/`（含 `vendors/`）、`src/snapgen-engine.ts`、`src/storage-sync.ts`、`src/presets.ts` 中除网关以外的全部预设（网关渠道由 WP2 生成后，`suanli-maas` 静态预设也删除）、`src/upstream-diagnosis.ts` 中针对第三方供应商的诊断、`src/settings-compat.ts` 中第三方渠道迁移逻辑。删除后清理只被它们使用的协议分支（Agnes、算力萌、Seedream、grok-imagine、nanobanana、glm-image、qwen-image/DashScope、MiniMax `image-01` 原生、Google native、qwen-draw、OpenRouter 等）及对应 smoke（`smoke-google-native`、`smoke-qwen-draw`、`smoke-magpie-discovery`、`smoke-upstream-diagnosis` 等）；`package.json` 的 `test` / `test:negative` 同步删条目。保留 h3 族与通用 OpenAI 兼容图像/视频路径。
3. 提示词增强与画布轻量技能：改为调用小助手宿主的对话能力（插件已有 `src/host-chat.ts`，以其现有实现为准）使用当前默认对话模型；删除 `promptApiUrl` / `promptApiKey` / `promptModel` 配置。若 `host-chat.ts` 不能满足，改为用网关渠道 + 账号凭据调 `/v1/chat/completions`，模型取目录中 `operation=chat` 且 `default=true` 的条目。
4. 设置迁移（一次性，幂等）：插件启动时若设置中存在 `channels`、`channelSecrets`、`apiKey`、`promptApiKey`、`storageSecretKey`，**清空所有 secret 字段**（避免明文密钥残留），其余旧字段保留不读。写一条诊断「已移除旧版第三方渠道配置」（不含任何值）。Config schema 里旧字段保留为 deprecated 以免解析失败。
5. 系统提示与工具描述中所有第三方协议说明删除（WP5 统一重写）。

**自测标准**

- `pnpm typecheck && pnpm test` 通过（删掉的 smoke 不再出现在脚本里，`verify-script-entries` 通过）。
- `grep -rniE "openrouter|x\.ai|snapgen|dashscope|bigmodel|volcengine|seedream|agnes|comemoe|closeai|token6688|antigravity|chatgpt\.com|cloudcode-pa|generativelanguage" src` 无结果（`src/templates/` 数据文件除外）。
- 新增迁移用例（可放在 `smoke-gateway-catalog.mjs` 或单独 `smoke-settings-migration.mjs`）：喂入含旧渠道与密钥的设置，断言 secret 字段被清空、再次运行无变化、诊断不含密钥值。
- `smoke-maas-families.mjs`、`smoke-maas-wire.mjs` 改为从网关渠道取模型后仍全过。

**验收条件**

- AC-3.1 设置页没有渠道、API 地址、API Key、订阅登录、提示词增强接口、对象存储同步等配置项。
- AC-3.2 用一份含旧渠道和明文密钥的设置启动，启动后设置文件中这些密钥为空。
- AC-3.3 文生图（`minimax-h3-image-enhanced`）、图生图、文生视频（`minimax-h3-2k`）、首尾帧（`minimax-h3-fl2va`）、参考生视频（`minimax-h3-ref-2k` / `minimax-h3-ref2va`）在真实网关各成功一次，参考素材经 `/v1/ov/files` 上传（验收方抓包确认）。
- AC-3.4 提示词增强、画布「文本润色 / 图片描述」在未配置任何独立接口的情况下可用。

### WP4 「创作」入口（P1）

**改动**

1. `src/client/slot-surface.tsx`：侧栏行与 `main` 座位的 `label` 改为 `tt('entry.creative')`（「创作」）；`order` 设为紧跟「任务」之后（开发方读宿主现有 `sidebar.panellist` 条目的 order 取值后确定，并在代码注释写明依据）；图标组件 `ImageGenPanelIcon` 换成与 WP1 同一图标，尺寸、激活态跟随宿主传入的 `size` / `active`。
2. 确认插件不再有任何 DOM 接管中心列的代码路径（`grep -rn "querySelector\|getElementById\|createPortal" src/client` 逐个确认用途；接管中心列的必须删除）。
3. 卸载/停用：插件在插件管理里停用后，侧栏行与 `main` 座位消失，不留空白；重新启用后恢复，无需重启。

**自测标准**

- `scripts/verify-ui-contracts.mjs` 增加断言：槽位注册只有 `sidebar.panellist`（id `imagegen`）与 `main`（key `imagegen`），dispose 函数调用后两者都被移除（用假的 slots 注册表记录 register/dispose）。
- 本地起小助手 Web（deepseek-harness `apps/web` 开发模式，按其 README）加载本插件，手动截图：侧栏有「创作」、点击切到工作台、点「会话」切回。

**验收条件**

- AC-4.1 侧栏有且只有一个「创作」入口，位置在「任务」之后，图标风格与相邻项一致，悬停/激活态正常。
- AC-4.2 点击「创作」后中心列显示工作台，左侧侧栏和会话列表不被遮挡或替换；切回会话后会话状态（滚动位置、输入框草稿）不丢失。
- AC-4.3 在插件管理中停用「创作」后入口立即消失，聊天、任务、宠物、IM 正常；重新启用后恢复。
- AC-4.4 插件 Host 或 Client 抛异常（验收方临时注入）时小助手仍能启动，其他功能正常。

### WP5 Agent 侧：系统提示瘦身与工具（P1）

**改动**

1. `src/index.ts` 的 `IMAGEGEN_GUIDANCE`（当前约 3,970 字）重写为 ≤ 600 字的**静态**中文说明：本机有「创作」工作台；可用 `generate_image` / `edit_image` / `generate_video` 生成；默认等待完成；图片结果在回复最前面用 Markdown 图片语法展示；视频渲染需数分钟不要轮询。**不拼接**渠道/模型表、不写协议细节、不写外部网址、不写密钥存储方式。按 `agent-experience` skill 的原则写（站在模型视角，只写任务相关概念）。
2. 模型选择改由工具参数承担：`generate_image` / `edit_image` / `generate_video` 的 `model` 参数描述改为「可选；不填使用默认模型。可用模型见 `list_media_models`」，并新增一个只读工具 `list_media_models`（返回当前目录里的图像/视频模型 `model`、`displayName.zh`、支持的模式与参数枚举）。若开发方判断新增工具不划算，可改为在工具描述的 `model` 枚举中列出——但**不得**放进系统提示。
3. 工具描述中删除第三方协议说明，长度各 ≤ 400 字。
4. `allowHeavySkills` 默认值改为 `false`；开启重任务技能前的确认框保留。
5. `/edit_image` 命令保留，使用网关默认图生图模型。

**自测标准**

- 新增 `scripts/verify-agent-surface.mjs`：断言系统提示文本 ≤ 600 字、与目录内容无关（用两份不同目录渲染，文本完全相同）、不含 `http`、`团团`、`api_key`；每个工具描述 ≤ 400 字。把最终系统提示全文写进 `docs/agent-surface.snapshot.md` 作快照，变更需同步更新。
- `smoke-maas-wire.mjs` 覆盖：Agent 调 `generate_image` 不传 `model` 时使用目录默认模型。

**验收条件**

- AC-5.1 新会话的系统提示中本插件段落 ≤ 600 字，切换账号/目录变化后该段文字不变。
- AC-5.2 在对话里说「画一只橘猫」，小助手调用 `generate_image` 并在回复开头展示图片；说「把这张图改成水彩」能调 `edit_image`；说「生成一个 5 秒的视频」能调 `generate_video` 且完成后可播放。
- AC-5.3 画布重任务技能默认关闭。

### WP6 自适应布局（P2）

先读并遵守 deepseek-harness 的 `dsh-responsive-ui` 与 `dsh-client-ui-ux` skill（`.agents/skills/` 下）。

**改动**

1. 工作台根节点设 `container-type: inline-size; container-name: creative;`，所有布局断点从视口 `@media (max-width: …)` 改为 `@container creative (…)`。涉及 `src/client/*.module.css` 与 `src/client/**/*.module.css` 中所有 `@media` 宽度查询（`@media (prefers-*)`、`(hover)`、`(pointer)` 保留）。
2. 断点（按工作台容器宽度）：
   | 容器宽度 | 布局 |
   |---|---|
   | ≥ 1280px | 左侧模块/卡片栏 + 主区（画布/结果） + 右侧对话栏，三栏；右栏可拖拽，宽度 `clamp(320px, 36%, 560px)` |
   | 900–1279px | 左栏收为图标条（48px，悬停显示名称），主区 + 右栏 |
   | 640–899px | 单主区；右侧对话栏改为可开关的覆盖抽屉；左栏图标条 |
   | < 640px | 单列；模块 tab 横向滚动；左栏与对话栏都是抽屉；参数面板改为底部弹层 |
3. 去掉会撑出横向滚动的固定 `min-width`（当前主布局 `minmax(320px, …)` 等）；所有网格/弹性子项 `min-width: 0`；长模型名单行省略并带 `title`。
4. 颜色、圆角、阴影、字号用宿主 `--dsw-*` 设计令牌，跟随亮/暗主题；不新增硬编码颜色（品牌色以外）。
5. 画布（`@xyflow/react`）、3D 舞台（three.js）在容器宽度变化时重新计算视口，不出现空白或错位。
6. 所有模块逐一适配：生图、生视频、无限画布、画廊、模板库、技能库、电商套图、服饰穿戴、A+、海报、复刻、PPT、短剧/分镜（以 `ModuleTabs.tsx` 中实际存在的 tab 为准，开发方在 PR 中列出全部 tab 及截图）。

**自测标准**

- 扩展 `scripts/verify-canvas-layout.mjs` / `verify-video-layout.mjs` 或新增 `scripts/verify-responsive.mjs`（Playwright，复用仓库已有浏览器测试方式）：对每个模块 tab 在容器宽度 1440 / 1280 / 1024 / 900 / 768 / 600 / 480，高度 900 / 640 下截图，并断言：`document.scrollingElement.scrollWidth <= clientWidth`（无横向滚动）；关键控件（生成按钮、模型选择、提示词输入）在视口内可见且可点击；无元素宽度为 0。
- `grep -rn "@media[^{]*width" src/client` 只剩注释说明过的例外。
- 截图集合附在 PR（每模块至少 1440 / 900 / 600 三档）。

**验收条件**

- AC-6.1 小助手窗口从最大拖到最小，所有模块无横向滚动条、无内容被裁掉、无重叠。
- AC-6.2 展开/收起小助手左侧栏时，工作台布局随可用宽度切换，而不是按窗口宽度。
- AC-6.3 亮色/暗色主题下颜色与小助手其他页面一致。
- AC-6.4 长模型名（如 `minimax-h3-ref-2k` 的中文全名）在窄宽度下单行省略，悬停可见全名。

### WP7 参数面板由目录驱动（P2）

**改动**

1. 模型选择器按「文生图 / 图生图 / 文生视频 / 首尾帧 / 参考生视频」分组：图像按 `taskTypes`（`t2i` / `i2i`），视频按 `modes[].taskType`，分类词表与宿主 `packages/llm/suanli-model-catalog/src/capabilities.ts` 一致（`t2v/t2va/auto` → 文生视频；`flf2v/fl2va/i2v/l2va/s2v` → 首尾帧；`r2va/r2v/rv2v` → 参考生视频）。一个模型属于多个组时在每组都出现。
2. 每项显示 `displayName.zh`，副文案 `description.zh`；聚合模型标签：显示规则写在一个映射表里（`-enhanced` → 「增强」，`-2k` → 「2K」），后续 new-api 若提供显式字段则改读字段。
3. 参数控件从 `paramSchema.properties` 生成：`enum` → 分段按钮/下拉；`type: number` + `minimum/maximum` → 数字输入；未知类型不渲染。时长上限取 `limits.maxDurationSeconds`；参考图数量取当前 mode 的 `references.image.min/max`，缺省时取 `limits.maxReferenceImages`。
4. 模式切换（首尾帧、参考等）只显示目录中该模型声明的 `modes`，`label.zh` 作为名称，`note.zh` 作为提示。
5. 目录里没有的参数不提交；目录声明了而用户未改的参数用 schema 默认值或不提交（以网关行为为准，`smoke-maas-wire` 覆盖）。
6. 原 `model-catalog.ts` / `video-model-catalog.ts` 中写死的 h3 档位保留为**目录缺字段时的兜底**，并在代码注释写明。

**自测标准**

- `smoke-gateway-catalog.mjs` 增加：同一模型改变 `paramSchema.enum` 后，渲染出的选项随之改变（纯函数测试：目录 → 控件描述）。
- `smoke-maas-wire.mjs` 增加：选了目录声明的 `resolution=2K`、`duration=5`、`ratio=9:16` 后，请求体中对应字段正确；未声明的字段不出现。

**验收条件**

- AC-7.1 在 new-api 后台给测试账号关掉一个视频模型（或换一个分组少一个模型），小助手点「刷新」后该模型从选择器消失，无需重启。
- AC-7.2 每个模型的比例/尺寸/时长/参考图张数选项与目录一致；超出 `max` 的参考图无法添加并有提示。
- AC-7.3 聚合模型显示对应标签，默认选中目录中 `default: true` 的模型。

### WP8 模板库精简与国内托管（P2）

**内容范围（精简后约 600 条）**

| 来源 | 许可 | 保留规则 | 约数 |
|---|---|---|---|
| freestylefly/awesome-gpt-image-2（原 `cases.json` + `canghe-cases.json`，按 `prompt` 文本去重） | MIT | 全部 `featured: true` + 每个 `categoryZh` 取前 10 条 | 250 |
| EvoLinkAI/awesome-gpt-image-2-prompts（`evolink-cases.json`） | CC0-1.0 | 每个 `categoryZh` 取前 30 条（`对比与社区案例` 不取） | 220 |
| yang0/handraw-style（`handraw-cases.json`） | MIT + 必须署名 yang0 | 每个 `categoryZh` 取前 8 条 | 130 |

删除：`itgoyo-cases.json`、`prompt-signal-cases.json`、`songtianlun-cases.json`、`youart-cases.json`；模板库在线刷新（`templates-store.ts` 中 vibeui.top / gpt-image2.canghe.ai 的 `listUrl` 与 12 小时同步）；服饰姿势库在线来源（`outfit-reference-store.ts`，含 raw.githubusercontent.com、jsdelivr、*.pages.dev 全部镜像）及其 UI 入口。服饰穿戴模块其余功能保留，姿势参考改为只支持用户上传。

**改动（dsh-imagegen-video）**

1. 新增 `scripts/build-template-mirror.mjs`：读取现有 JSON → 按上表筛选 → 下载原图 → 用 `sharp`（devDependency）转为长边 720px、质量 80 的 WebP → 文件名 `<sha256 前 16 位>.webp` → 输出到 `out/creative-templates/<来源>/`，并生成 `out/creative-templates/manifest.json`（每条含 `id/title/prompt/category/categoryZh/styles/scenes/source/author/license/image`，`image` 为相对路径）。脚本可重复执行，结果确定（相同输入产生相同文件名）。下载失败的条目丢弃并在输出末尾列出。
2. `src/templates/` 只保留一个 `creative-templates.json`（即 manifest 的内容），插件构建时打包。
3. `templates-store.ts`：图片地址 = `TEMPLATE_IMAGE_BASE + image`，`TEMPLATE_IMAGE_BASE` 固定为 `https://hero.ovaijisuan.com/creative-templates/`；删除在线刷新与多来源 tab，模板库只显示一个「精选模板」，按 `categoryZh` 筛选；收藏功能保留（旧收藏中已不存在的 id 静默忽略）。
4. 每条模板卡片与详情显示纯文本署名「来源：作者 / 仓库名 · 许可」；在模板库底部加一行「部分模板来自开源社区，版权归原作者」。`THIRD_PARTY_NOTICES.md` 补充三个来源的许可与署名。

**改动（maas-landingpage）**

1. 把 `out/creative-templates/` 整体复制到 `public/creative-templates/`（不含 manifest 以外的 JSON），提交 PR。
2. 为 `/creative-templates/*` 配置长缓存：按 EdgeOne Makers 文档（`edgeone.json` 的 `headers` 配置）设置 `Cache-Control: public, max-age=31536000, immutable`，并加 `Access-Control-Allow-Origin: *`（以备 Client 用 fetch 读取）。开发方需先读 EdgeOne Makers 官方文档确认配置文件名与格式，在 PR 中贴文档链接。
3. 不改官网其他页面；`README.md` 增加一节说明该目录用途与更新方式。

**额度约束（EdgeOne Makers 免费版，官方「限制与配额」）**：单文件 ≤ 25 MB、单项目 ≤ 20,000 文件、站点总存储 ≤ 5 GB（含保留的历史部署）。本目录要求：文件数 ≤ 700、总体积 ≤ 60 MB、单文件 ≤ 300 KB。

**自测标准**

- `node scripts/build-template-mirror.mjs` 连续跑两次，输出目录哈希一致；输出文件数、总体积、最大单文件打印出来并满足上述约束（脚本内断言，超限即失败）。
- `grep -rnE "raw\.githubusercontent|cdn\.jsdelivr|pbs\.twimg|fxtwitter|vibeui\.top|canghe\.ai|pages\.dev|opennana|cdn\.openai" src lib` 无结果。
- 在 maas-landingpage 本地 `npm run build` 后 `dist/creative-templates/` 文件数与体积符合约束。

**验收条件**

- AC-8.1 打开模板库，图片全部从 `hero.ovaijisuan.com` 加载（验收方查看网络面板），国内网络下首屏 20 张缩略图 3 秒内显示完。
- AC-8.2 部署后 `curl -I https://hero.ovaijisuan.com/creative-templates/<任一文件>` 返回 200、`content-type: image/webp`、长缓存头。
- AC-8.3 官网首页、`/download`、`/about`、`/showcase` 功能不受影响。
- AC-8.4 署名在卡片和详情中可见。

### WP9 打包进小助手（P1，两个仓库）

参考现有宠物插件的做法（`reputationly/dsh-codex-pet`：`suanli` 源码分支 → 合入 `release` → CI 打包 tgz 提交到 `dist` 分支 → deepseek-harness 引用 raw.githubusercontent.com 上的 tgz）。

**dsh-imagegen-video**

1. `package.json` 版本改为 `1.35.0-suanli.1`（之后每次发行递增 `suanli.N`）。
2. `package.json` 的 `peerDependencies` 中 `react` / `react-dom`（如有）在 `peerDependenciesMeta` 标 `optional: true`；不使用 `github:` 依赖；`prepare` 脚本在作为依赖安装时不得触发构建（参考 dsh-codex-pet 的处理）。
3. 新增 `.github/workflows/suanli.yml`：`release` 分支 push 时 `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm pack`，把 tgz 提交到 `dist` 分支（文件名需匹配 deepseek-harness `apps/desktop/scripts` 中 tgz 文件名正则 `^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$`）。
4. 删除或停用与上游 npm 发布相关的 workflow（`release.yml`、`npm-backfill.yml`、`hol-plugin-scanner.yml`）中会向 npm / 上游发布的步骤。

**deepseek-harness**

1. `apps/cli/package.json` 增加依赖 `"@q253595422/dsh-imagegen-video": "https://raw.githubusercontent.com/reputationly/dsh-imagegen-video/<dist 提交>/<tgz 文件名>"`，更新锁文件。
2. `packages/util/official-bundles/src/bundles.ts`：`web` profile 的 `bundles` 列表加入 `'@q253595422/dsh-imagegen-video'`（注释说明：蒜狸默认启用，可在插件管理中停用），并加入同文件中官方外部插件列表（与 `@michengai/dsh-codex-pet` 同处）。
3. `apps/desktop/src/brand-gateway.ts` 的 profile 补丁增加一段：
   ```yaml
   # 创作工作台使用同一网关和账号凭据。
   - id: imagegen
     config:
       gateway:
         baseURL: <gateway.baseURL>
         credential: <gateway.apiKeyEnv>
   ```
   开发方需确认 profile 补丁对插件 `config` 是合并还是替换；若是替换，改为只设置 `gateway` 子路径的写法。同步更新 `brand-gateway` 的现有测试快照。
4. 桌面打包：按 `apps/desktop/scripts` 里处理外部 tgz 的脚本（与宠物插件同一路径）确认本插件 tgz 被正确暂存进安装包；如需白名单配置，加上。
5. 测试（`packages/AGENTS.md` 要求产品可见插件有真实组合测试）：
   - 一个组合测试：用测试专用 `cordis.yml` 经 Loader 启动 `web` profile，断言插件加载、`sidebar.panellist` 中存在 id `imagegen`、`main` 中存在 key `imagegen`；停用插件后两者消失（HMR/dispose 安全）。
   - 一个组合测试：`brand-gateway` 补丁生效后 `imagegen` 的 `config.gateway` 与网关配置一致；用 `packages/test-support/session-snapshot/src/fake-gateway.ts` 的假网关验证插件目录状态为 `ready`。
   - 按 `dsh-pre-push-checks` skill 选择并运行受影响的检查。
6. 文档：在 `docs/subsystems/suanli-gateway.zh.md`（及英文对应页）增加一段「创作工作台」说明其使用同一网关与凭据；按 `dsh-doc-writing` skill 的规则写当前契约。

**自测标准**

- dsh-imagegen-video：`pnpm pack` 产物可被 `npm install <tgz>` 安装且不触发构建；`node scripts/verify-pack.mjs` 通过。
- deepseek-harness：`pnpm install` 成功；上述两个组合测试通过；`pnpm run build`（或仓库对应的受影响构建）通过；桌面打包脚本本地 dry-run 能找到并暂存 tgz。
- 本地起 `apps/web`，登录真实账号，完成 AC-2.1、AC-3.3 的一次生图与一次生视频。

**验收条件**

- AC-9.1 全新安装的蒜狸小助手（桌面安装包或 Web 构建）开箱即有「创作」入口，登录后可直接生图/生视频。
- AC-9.2 小助手冷启动时间相对未装本插件的基线增加 ≤ 10%（验收方用同一台机器各测 3 次取中位数）；未点开「创作」时不加载画布/3D 相关前端代码（看网络面板/包加载记录）。
- AC-9.3 网关不可用（断网或指向错误地址）时小助手正常启动，聊天、任务、宠物、IM、设置全部可用，「创作」显示对应状态。
- AC-9.4 deepseek-harness PR 的 CI 全绿。

### WP10 提交统一走宿主 `suanliMedia`（P3，本期只评估）

宿主 `packages/llm/suanli-media-tasks` 已提供 `submit / status / wait / cancel / saveArtifact / download`（`MediaSubmitRequest`: `operation / model / prompt / taskType / referenceImages / params`）。P3 评估把插件的 h3 提交改为调用它，使密钥、轮询、下载只有宿主一个实现。本期交付一页评估（字段是否够用、差异点、迁移步骤），不写代码。

## 4. 全局自测（每个 PR 提交前）

dsh-imagegen-video：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test            # 包含新增 verify-no-brand / smoke-gateway-catalog / verify-agent-surface 等
pnpm test:negative   # 包含新增反向用例
node scripts/verify-pack.mjs
```

deepseek-harness：按 `dsh-pre-push-checks` skill 选择命令，至少包含受影响包的测试与新增组合测试。

PR 描述必须包含：对应 WP 编号、自测命令与结果摘要、AC 自查表（每条 AC 写「已自测 / 需验收方在真实环境验证」）、UI 截图（WP1/4/6/7/8）或 GIF。

## 5. 验收流程

1. 开发方每完成一个 PR，在 PR 中 @ 验收方并附 AC 自查表。
2. 验收方：
   - 复跑第 4 节全部命令；
   - 代码审查：密钥流向（只在 Host 内存）、dispose 清理、无 DOM 接管、无新增外部域名、改动范围不超出本文；
   - 在真实环境逐条验证 AC（使用测试账号的 `AURORA_API_KEY`），记录结果；
   - 不通过的 AC 以 PR 评论列出，开发方修复后重新提交。
3. 全部 AC 通过后，验收方给出验收结论，由用户决定合并与发版。

### 5.1 验收清单汇总

| 编号 | 内容 | 期 |
|---|---|---|
| AC-1.1–1.4 | 去品牌、去 GitHub 链接、无自更新 | P1 |
| AC-2.1–2.5 | 启动拉取目录、失败降级、登录态联动、凭据不落盘 | P1 |
| AC-3.1–3.4 | 无第三方渠道、旧密钥清除、五种生成模式真实可用、提示词增强可用 | P1 |
| AC-4.1–4.4 | 「创作」入口、切换不丢状态、停用干净、故障隔离 | P1 |
| AC-5.1–5.3 | 系统提示 ≤ 600 字且静态、对话生成可用、重任务默认关 | P1 |
| AC-9.1–9.4 | 开箱可用、启动开销、网关故障隔离、CI 全绿 | P1 |
| AC-6.1–6.4 | 自适应、主题一致、长名省略 | P2 |
| AC-7.1–7.3 | 参数随目录变化 | P2 |
| AC-8.1–8.4 | 模板图国内加载、长缓存、官网不受影响、署名 | P2 |

## 6. 风险与待确认

| 项 | 处理 |
|---|---|
| 插件按 dsh `0.1.2-alpha.2` 类型开发，宿主为 `0.2.2-rc.5` | WP4/WP9 先在宿主上实测加载；接口差异在插件侧适配，不改宿主槽位 |
| KYC 403 的识别条件 | 开发方读 new-api `KYCRequired` 中间件确定，写进测试夹具 |
| 实名认证页地址、登录入口如何从插件唤起 | 开发方在 WP2 中确认；无可调用入口时退化为文字指引 |
| profile 补丁对插件 config 的合并语义 | WP9 第 3 步确认 |
| 插件管理显示名读取哪个字段 | WP1 第 6 步确认 |
| EdgeOne 免费版存储按站点含历史部署计 | 官网部署约 270 MB/次，约可保留 18 次；运维定期在控制台删除旧部署 |
| 上游团团TV 持续更新 | 本 fork 改动集中在适配层、入口、品牌与删除项；合上游时以本文为准处理冲突 |
