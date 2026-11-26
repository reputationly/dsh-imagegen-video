# 蒜狸小助手：Hilo 目录统一 + 对话内生成 开发文档

> 读者：开发 Agent。照本文执行，不需要再问；本文没写到的取舍，按「宁可拒绝也不悄悄降级」处理并在 PR 里写明。
> 验收方：Devin。验收按 §8 逐条复跑。
> 交互稿（给人看的版本）见 PR 描述；本文是它的可执行版本，两者冲突以本文为准。

## 0. 已确认的产品决定

| # | 决定 |
|---|---|
| D1 | 宿主只读 Hilo 目录 `GET /api/v1/models/catalog`，不再读 `/v1/ov/capabilities` 和 `/v1/models`。目录不按 key 裁剪，权限问题调用时再报，并原样展示网关原因 |
| D2 | 音乐 / 语音用目录条目的 `interfaceType` 区分：`maas-music` / `maas-speech`。new-api 不改代码，运营在 Hilo 目录里填 |
| D3 | 审核不通过只给「按审核意见重新生成」按钮，**不自动重试** |
| D4 | 必选参数缺任何一项都**一定弹问题卡**，不直接按默认生成 |
| D5 | 所有调用只用登录时的那一个网关 key（宿主 `credentials` 里的网关凭据）；任何界面不出现第二个 key 输入框 |
| D6 | 内容安全由 new-api 产物审核负责（`service/moderation/output.go`），小助手的审核只判断「是否符合用户要求」 |

## 1. 现状事实（开工前不用再查）

### 1.1 线上目录（2026-11-26 实测，匿名可读）

```
defaults: chat=deepseek-v4-1-flash  multimodal=qwen3.8-flash-fp8
text : deepseek-v4-1-flash (supportsImage)   qwen3.8-flash-fp8 (supportsImage, supportsVideo)
image: MiniMax-H3-Image → minimax-h3-image, MiniMax-H3-Image-Enhanced → minimax-h3-image-enhanced
       params: aspect_ratio {adaptive,1:1,16:9,9:16,4:3,3:4,3:2,2:3,21:9,5:4,4:5}  resolution {1K,2K}   maxRefs 4
video: MiniMax-H3-FL  → minimax-h3-2k       image_mode {first-last-frame,text-to-video,video-extension}  maxRefs 2
       MiniMax-H3-Ref → minimax-h3-ref-2k   image_mode {reference}                                        maxRefs 9
       params: duration {1..20} ratio {11 档} resolution {768P,2K} generate_audio {true,false}
audio: music-3.0 / music-3.0-enhanced / ACE-Step / ACE-Step-Enhanced
       params: is_instrumental {true,false}  lyrics (textarea, optional)
```

- 参数项形状：`{ type: 'select' | 'textarea' | …, label, default, options?, optional? }`，键是提交时的参数名。
- **所有条目当前都没有 `interfaceType`**；目录不下发 `modes`、`deliveryDurations`、`taskTypes`。
- 线上没有语音模型。

### 1.2 宿主现有代码

| 位置 | 现状 |
|---|---|
| `packages/llm/suanli-model-catalog` | `CatalogSync` 读 `/v1/models` 写 `settings.models` 并发 `llm/models-updated`；`MediaCatalogSync` 读 `/v1/ov/capabilities`，`media()` 返回 `MediaCatalogSnapshot { status, version, fetchedAt, entries: CapabilityEntry[] }`，持久化在 storageDomain `suanli_media_catalog` |
| `packages/llm/suanli-media-tasks` | `submit / status / wait / cancel / download / saveArtifact`；`MediaOperation = generate_image | generate_video | generate_music`；README 写明「还没有 Agent 工具和对话界面接它」 |
| `packages/interaction/user-questions` | `ctx.userQuestions.ask({ questions: AskUserQuestionItem[], agent, signal, wait })`；题目 `{ id, question, detail?, header?, options?: {label, description?}[], multiSelect? }`；问题卡已有 Web UI、重启不丢 |
| `packages/client/ui-primitives/src/ImageLightbox.tsx` | 现成的图片放大组件 |
| `packages/client/ui-tool` | 工具行通过 slot `tool.call.toolview` 按工具名注册自定义视图（例：`ui-deliverables` 的 `present`） |
| `apps/desktop/src/brand-gateway.ts` | 每次启动重写 `cordis.patch.yml`，只保留 `savedSelection` 的对话模型；没选过时用品牌配置的 `defaultModel` |

### 1.3 插件现有代码（`dsh-imagegen-video`）

- `src/gateway-catalog.ts` 只消费 `media()` 的 `CapabilityEntry`（按 `transport.kind` = `images` / `videos_task` 和 `operation` 分组）。
- 插件注册的对话工具：`generate_image`、`edit_image`、`generate_video`、`generate_video_from_image`、`get_/cancel_image_generation_task`、`get_/cancel_video_generation_task`、`list_media_models`，以及画布工具。
- `src/host-chat.ts` 已有「用指定模型跑一个隐藏单轮、可带图片块」的做法（`agents.create` + `followup`），审核照此实现。

## 2. 总体结构

```
Hilo 目录 ──► suanli-model-catalog（唯一目录 owner）
                 ├─ media()   → 现有 CapabilityEntry 形状（插件无感）
                 ├─ roles()   → 六类角色 + 每类候选 + 当前选择
                 └─ settings.models ← text 段（对话模型列表）
                         │
suanli-media-tools（新，宿主）── 对话工具 generate_image / generate_video / generate_music / generate_speech
   │  参数解析与校验 → userQuestions 问题卡 → suanli-media-tasks 提交/轮询/下载 → 审核
   ▼
ui-suanli-media（新，宿主 Client）── 工具卡片：缩略图/放大、播放器、进度/取消、审核徽标、操作按钮
插件「创作」── 工作台照旧；删除与宿主重名的对话生成工具；画廊收录对话产物
```

**原则**：一份目录、一个执行器。模板（插件工作台）和对话（宿主工具）最终都落到 `suanli-media-tasks`，不新增第二条调用链。

## 3. 工作包

### WP0 运营配置（new-api，不改代码）

Hilo 目录里：音频条目 `interface_type` 填 `maas-music`；语音模型上线时填 `maas-speech`。图片 / 视频可不填（走 §3.1 的缺省映射）。**验收不依赖 WP0 完成**：缺省映射保证今天的目录也能跑。

### WP1 目录切换（`packages/llm/suanli-model-catalog`）

1. Config 新增 `catalogPath`（默认 `/api/v1/models/catalog`）；删除 `capabilitiesPath`、`modelsPath` 及对应请求代码。请求**不带** Authorization（匿名接口）。
2. 映射到现有 `CapabilityEntry`，`media()` 形状不变：

| 目录段 | interfaceType | operation | transport.kind |
|---|---|---|---|
| image | 空 / `maas-image` | `generate_image` | `images` |
| video | 空 / `maas-video` | `generate_video` | `videos_task` |
| audio | 空 / `maas-music` | `generate_music` | `videos_task`（与 `transportFor('generate_music')` 一致） |
| audio | `maas-speech` | `generate_speech` | 暂不映射 transport，见 WP5 |
| 任意 | 不认识的值 | 按该段缺省 | 每个 `version` 只记一次 warn 日志 |

   - `model` = `platformModel`；`id` = `<operation>:<platformModel>`；`displayName/description` 双语字段都填目录文案。
   - `params` → `paramSchema.properties`：`select` → `{ type:'string', title:label, enum:options, default }`；`textarea` → `{ type:'string', title:label }`。不认识的 type 丢弃该参数并记日志。
   - `maxRefs` → `limits.maxReferenceImages`；`maxDurationSeconds` 取 `duration` 选项最大值，没有则 0。
   - **视频玩法 `modes`**：目录不下发，按 `image_mode` 的选项值从下表派生（表来自 new-api `docs/video-client-integration.md` §1.1，按玩法协议定义，**不按模型名**）。目录将来下发 `modes` 时优先用目录的。

| image_mode | taskType | 图 | 视频 | 音频 | 备注 |
|---|---|---|---|---|---|
| text-to-video | t2v | 0 | 0 | 0 | |
| first-last-frame | flf2v（1 张图 → i2v） | 1–2 | 0 | 0 | |
| reference | r2va | 0–9 | 0–3 | 0–3 | 至少一项；视频+音频合计 ≤3 |
| video-extension | continuation | 0 | 1 | 0 | 只 768P；`duration` 为最终总时长 |

3. 对话模型：`text` 段 → `settings.models`（`id` = `platformModel`；`inputModalities` 由 `supportsImage/Video/Audio` 得出）。`version` 不变时不写 settings、不发 `llm/models-updated`（沿用现有规则）。
4. 新增 `roles(): ModelRoles`：

```ts
type ModelRole = 'chat' | 'vision' | 'image' | 'video' | 'music' | 'speech'
interface ModelRoleState {
  readonly role: ModelRole
  readonly candidates: readonly { readonly model: string; readonly label: string }[]
  readonly selected: string | null   // 用户选择；无效或未选时回落到 fallback
  readonly fallback: string | null   // chat=defaults.chat，vision=defaults.multimodal，媒体=第一条
}
```

   - `vision` 候选：`text` 段里 `supportsImage || supportsVideo` 的模型。
   - 用户选择持久化到 storageDomain（新域 `suanli_model_roles`），**不写 settings**（理由：桌面端每次启动重写 `cordis.patch.yml`，见 1.2）。`chat` 角色例外：沿用现有对话模型选择，不另存。
   - 桌面端无 `savedSelection` 时，对话模型默认取缓存目录的 `defaults.chat`（存在于列表中才用），否则仍用品牌 `defaultModel`。
5. 状态：目录匿名，`unauthorized` / `kyc-required` 不再由目录产生；保留 `loading / ready / rate-limited / unreachable / empty`，以及登录状态 `signed-out`（来自凭据，而不是目录）。插件状态条已处理这些值，不用改插件。
6. README、JSDoc、Model Experience 段同步更新；`Known Limitations` 写明「目录不按 key 裁剪」。

### WP2 对话生成工具（新包 `packages/llm/suanli-media-tools`）

函数插件，`inject = ['tools', 'suanliModels', 'suanliMediaTasks', 'userQuestions', 'agents']`。仅在 `roles()` 对应角色有候选时注册该工具；目录变化时增删（注册返回的 dispose 要生效，HMR 测试覆盖）。

**工具**（schema 固定，不随目录内容变化；描述 ≤400 字，不出现 transport / interfaceType / UI 词汇）：

| 工具 | 参数 |
|---|---|
| `generate_image` | `prompt`（必填）、`aspect_ratio?`、`resolution?`、`reference_images?`（会话里的附件或文件路径）、`count?` |
| `generate_video` | `prompt`、`aspect_ratio?`、`resolution?`、`duration_seconds?`、`with_audio?`、`first_frame?`、`last_frame?`、`reference_images?`、`source_video?` |
| `generate_music` | `prompt`（曲风描述）、`lyrics?`、`instrumental?` |
| `generate_speech` | `text`、`voice?`、`speed?`（WP5 才注册） |

参数值一律是**用户原话里的说法**，由执行器归一：`4K`、`4k`、`超清4K` → `4K`；`竖屏` → `9:16`；`横屏` → `16:9`；`方图` → `1:1`；`10秒` → `10`。归一表放在包内，只做同义词，不做降级。

**执行顺序（全部在执行器里完成，不靠提示词）**：

1. 取当前角色模型的 `CapabilityEntry`。
2. 对每个工具参数，按 §3.2 的必选表判断：`missing`（没给）/ `unsupported`（给了但不在 `enum` 内，或超出玩法限制）/ `ok`。
3. 只要有 `missing` 或 `unsupported`，调用一次 `userQuestions.ask`，**一张卡**里每个问题一题：
   - `unsupported` 题：`question` 写「当前不支持 {原话}，请选择{参数名}」，`detail` 列出支持范围（如「最高 2K」）。
   - `missing` 题：`question` 写「请选择{参数名}」。
   - `options` = 目录 `enum`，目录 `default` 那一项排第一并在 `description` 标「默认」。选项超过 12 个（时长 1–20 秒）时给 6 个常用值 + 允许自由输入，执行器校验输入。
   - 已经 `ok` 的参数**不出题**。
4. 用户跳过或取消 → 工具返回「用户取消」，不提交。答案再校验一次，仍非法 → 再问一次，第二次仍非法返回错误。
5. 提交 `suanliMediaTasks.submit`；视频 / 音乐 `wait` 轮询，`signal` 取消时调用 `cancel`。
6. 产物写入当前会话工作目录下的 `generated/`（文件名 `<时间>-<短 id>.<ext>`），并登记为会话附件。
7. 图片 / 视频完成后跑审核（WP4），审核失败不影响产物返回。
8. 工具结果（模型可见）只含：状态、文件路径、实际参数、审核结论一句话。结构化元数据（taskId、url、审核详情）放结果 metadata，供卡片读取。

**3.2 必选参数表**（按目录参数键；目录里没有的键自动不问）

| 工具 | 必选 | 自动推断、不问 |
|---|---|---|
| generate_image | `aspect_ratio`、`resolution` | — |
| generate_video | `ratio`、`resolution`、`duration`、`generate_audio` | `image_mode`：有 `source_video` → video-extension；有参考图/视频（非首尾帧）→ reference；有首帧 → first-last-frame；否则 text-to-video。按玩法选能承接它的视频模型 |
| generate_music | `is_instrumental` | `lyrics`：`instrumental=false` 且没给歌词时追问「是否需要歌词」，可跳过 |

**错误分类**（结果和卡片都要区分，文案原样带网关原因）：未登录、无权使用该模型（401/403）、未实名、额度不足、参考素材超限（按玩法上限）、超时、网关拒绝、网络不通。

### WP3 结果卡片（新包 `packages/client/ui-suanli-media`）

注册 `tool.call.toolview`，key 为上面四个工具名。只读工具 call/result 事件和 result metadata，不写会话日志。

- **运行中**：媒体类型图标 + 「生成中 · 已等待 00:23」；视频 / 音乐显示进度（有 `progress` 时）和「取消」按钮。
- **图片**：缩略图网格（1 张时最大宽 360px，多张两列）；点击用 `ImageLightbox` 放大，支持缩放和左右切换。
- **视频**：内嵌 `<video controls>`，首帧作封面，可全屏。
- **音频**：内嵌 `<audio controls>`，显示时长。
- **底栏**：实际参数一行小字（模型显示名 · 比例 · 分辨率 · 时长）。
- **操作**：下载、在创作中打开（插件未启用时隐藏）、重新生成（同参数，发一条用户消息「按相同参数重新生成」并附原参数）、复制提示词。
- **审核徽标**：审核中（灰）/ 符合（绿）/ 部分符合（黄）/ 不符合（红）/ 未做内容审核（灰）。点开展开理由。黄 / 红时显示「按审核意见重新生成」按钮（发一条用户消息，带审核意见）。**不自动重试**（D3）。
- 窄宽度（<480px）下缩略图单列，按钮收成「…」菜单。所有文案进 locale（zh/en 必填）。

### WP4 审核（`suanli-media-tools` 内）

1. **元数据检查**（程序，不用模型）：读产物宽高 / 时长，和请求的比例（±2%）、分辨率档位、时长（±0.5 秒）比对。不一致记为「不符合」，理由写明实际值。
2. **内容检查**：`vision` 角色模型存在时，用隐藏单轮（照 `src/host-chat.ts` 的 `agents.create` + `followup` 做法）发送：
   - 系统提示：「判断媒体是否符合用户要求。只输出 JSON：{verdict: pass|partial|fail, reasons: string[]}」。
   - 用户块：用户原话、最终提示词、参数；图片原图（长边缩到 1536px）；视频：模型 `supportsVideo` 时传视频，否则用 ffmpeg 抽首 / 中 / 尾 + 每 5 秒一帧，最多 8 帧。
   - 超时 60 秒；输出解析失败或超时 → 徽标「审核未完成」，不影响产物。
3. 没有 `vision` 角色 → 只做第 1 步，徽标「未做内容审核」。
4. 设置项「生成后自动审核」（默认开），存 storageDomain。
5. 审核走同一个网关 key（隐藏单轮用宿主对话通道），用户无需额外配置。

### WP5 语音（目录出现 `maas-speech` 条目后再做）

- 先用真实条目确认提交路径和参数，再补 `MediaOperation = 'generate_speech'` 与 transport。
- 在那之前：`roles().speech.candidates` 为空，设置页显示「暂未开放」，`generate_speech` 不注册。

### WP6 设置页「模型」（宿主 Client）

六行，每行：角色名 + 下拉（候选显示名）+「默认」标记。候选为空时整行置灰并显示「暂未开放」。底部一个开关「生成后自动审核」。没有任何 key 输入框。

### WP7 插件对齐（`dsh-imagegen-video`）

1. 删除与宿主重名或重叠的对话工具：`generate_image`、`edit_image`、`generate_video`、`generate_video_from_image`、四个 `get_/cancel_*_task`、`list_media_models`。画布工具保留；画布内生成继续用插件引擎。
2. 删除后同步：系统提示、`docs/agent-surface.snapshot.md`、反向校验用例。
3. 插件在 Client 端提供服务 `suanliCreative.openImages({ prompt, model, images })`：把图片收进画廊，再切到工作台的画廊。宿主图片卡片「在创作中打开」调用它；插件未装载时卡片提示「「创作」未启用」。
4. 插件拿不到各会话的工作区，所以不自动扫描 `generated/`，也不加 `/open?path=` 路由；图片由卡片按会话权限读出后交给插件。视频和音频卡片暂无此按钮。
5. 插件 `gateway-catalog.ts` 不需要改（`media()` 形状不变）；补一条测试：喂 WP1 映射出的条目，模型列表和参数控件正确。

## 4. 分期与顺序

| 期 | 工作包 | 前置 |
|---|---|---|
| P1 | WP1 + WP6 | — |
| P2 | WP2（仅 `generate_image`）+ WP3（图片部分）+ WP7.1–7.2 | P1 |
| P3 | WP2 视频 + WP3 视频 / 音频 + `generate_music` | P2 |
| P4 | WP4 | P2 |
| P5 | WP5、WP7.3–7.4 | 目录有语音条目 |

每期一个宿主 PR（插件改动另开插件 PR，走现有自动发行）。不合并，合并由用户决定。

## 5. 不做

- 不读 `/v1/ov/capabilities`、`/v1/models`；不新增按 key 的能力探测请求。
- 不按模型名写规则（玩法表按 `image_mode` 值，归一表按用户说法）。
- 不悄悄降级任何参数；不自动重试审核不通过的结果。
- 不在 localStorage / settings 里放媒体或目录大对象。
- 不改 new-api 代码；不改宿主发版 freshness 检查。

## 6. 模型体验（README 必写）

- 新增 4 个工具，schema 固定，目录变化只增删工具、不改 schema，提示缓存只在增删时失效一次。
- 工具结果只给模型：状态、路径、实际参数、审核一句话；不含 URL、taskId、审核原始 JSON。
- 插件删掉 9 个工具后，开「创作」时的工具总数下降。

## 7. 自测要求（开发方提交前必须跑）

- 宿主：`pnpm typecheck`、`pnpm lint`、相关包 `pnpm vitest run packages/llm/suanli-model-catalog packages/llm/suanli-media-tools packages/client/ui-suanli-media`、docs 检查。
- 组合测试（AGENTS 要求的真实 Loader 组合）：test-only `cordis.yml` 启动，回环假网关提供 §1.1 那份目录和假的图片 / 视频任务接口，假 `userQuestions` 回答者；断言工具可见性、问题卡内容、提交请求体、结果文本。
- 插件：`pnpm typecheck`、`pnpm test`；工具删除涉及测试时跑 `pnpm test:negative` 相关组。
- 真实网关冒烟（验收方提供 key，开发方不保存 key）：图片一张、视频一个 5 秒 768P。

## 8. 验收条件

### P1 目录

| AC | 条件 | 怎么验 |
|---|---|---|
| 1.1 | 启动只请求 `/api/v1/models/catalog`，不请求 `/v1/ov/capabilities`、`/v1/models` | 组合测试记录假网关请求路径 |
| 1.2 | 目录请求不带 Authorization | 同上，断言请求头 |
| 1.3 | `media()` 映射结果符合 §3.1 表；空 `interfaceType` 的音频条目是 `generate_music`；`maas-speech` 条目是 `generate_speech`；不认识的值按段缺省并只 warn 一次 | 单测，喂 §1.1 目录 + 改造条目 |
| 1.4 | 视频条目 `modes` 按 §3.1 玩法表派生，`MiniMax-H3-Ref` 只有 reference | 单测 |
| 1.5 | `settings.models` = 目录 `text` 段；`version` 不变不写、不发事件 | 单测（计数写入 / 事件） |
| 1.6 | `roles()` 六类正确；vision 默认 `qwen3.8-flash-fp8`；speech 候选为空 | 单测 |
| 1.7 | 角色选择重启后仍在（storageDomain），桌面重写 `cordis.patch.yml` 不影响 | 组合测试重启 Loader |
| 1.8 | 断网启动用缓存目录；未登录时目录照常显示、生成时提示登录 | 组合测试 |
| 1.9 | 设置页六行，语音行「暂未开放」，无 key 输入框 | 截图 + DOM 断言 |

### P2 对话生图

| AC | 条件 | 怎么验 |
|---|---|---|
| 2.1 | 「生成一张小猫玩耍的图片」→ 一张问题卡两题（宽高比、分辨率），默认项排第一 | 组合测试断言 `ask` 入参 |
| 2.2 | 「生成一张 2K 的…」→ 只问宽高比 | 同上 |
| 2.3 | 「生成一张 4K 的…」→ 分辨率题写明不支持 4K，选项只有 1K / 2K；宽高比也问 | 同上 |
| 2.4 | 给定 `resolution:'4K'` 直接调执行器（绕过模型）也会出题，不会提交 4K 或 2K | 执行器单测 |
| 2.5 | 用户取消问题卡 → 不提交，结果为取消 | 组合测试，断言假网关无提交 |
| 2.6 | 参数都齐且合法 → 不出题直接提交，请求体 `model` 是 `platformModel`，带统一 key | 组合测试断言请求 |
| 2.7 | 结果卡缩略图点击放大；下载、重新生成、复制提示词可用；未启用插件时无「在创作中打开」 | 浏览器录屏 |
| 2.8 | 403 / 未实名 / 额度不足时卡片显示网关原因 | 假网关返回对应错误 |
| 2.9 | 插件不再提供重名工具；`agent-surface.snapshot.md` 已更新 | 插件测试 |

### P3 视频 / 音乐

| AC | 条件 | 怎么验 |
|---|---|---|
| 3.1 | 「做一个 10 秒竖屏视频」→ 只问分辨率和声音 | 组合测试 |
| 3.2 | 「30 秒」→ 时长题写明最长 20 秒 | 同上 |
| 3.3 | 附 1 张图 → first-last-frame，`taskType` = i2v；附 3 张参考图 → 选 MiniMax-H3-Ref，reference | 执行器单测 |
| 3.4 | 续写要求 2K → 写明续写只支持 768P | 执行器单测 |
| 3.5 | 视频卡可播放、可全屏；运行中可取消，取消后网关收到 cancel | 录屏 + 假网关 |
| 3.6 | 视频运行中重启宿主，任务继续取回，不重复提交 | 组合测试 |
| 3.7 | 「生成一段轻快的钢琴曲」→ 问是否纯器乐；音乐卡可播放 | 组合测试 + 录屏 |

### P4 审核

| AC | 条件 | 怎么验 |
|---|---|---|
| 4.1 | 图片完成后用 vision 角色模型审核，卡片出现徽标与理由 | 组合测试（假对话模型返回 JSON） |
| 4.2 | 比例与请求不符 → 程序判「不符合」，不调模型也能得出 | 单测 |
| 4.3 | 视频审核按 §WP4 抽帧，最多 8 帧 | 单测断言帧数 |
| 4.4 | 黄 / 红徽标只出现「按审核意见重新生成」按钮，没有任何自动重新提交 | 组合测试断言提交次数 = 1 |
| 4.5 | 审核超时或输出不可解析 → 「审核未完成」，产物仍返回 | 单测 |
| 4.6 | 关掉「生成后自动审核」后不再审核 | 组合测试 |

### 通用

| AC | 条件 |
|---|---|
| G.1 | 仓库、日志、会话日志、工具结果里不出现 key |
| G.2 | 工具 schema 在两份不同目录下完全相同（快照） |
| G.3 | 新包 README 有 Model Experience 和 Known Limitations；注册项有 HMR 销毁测试 |
| G.4 | 宿主 CI 三项通过；插件 CI 通过 |
