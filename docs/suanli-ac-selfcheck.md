# 「创作」P1 验收自查表

对应设计文档：`dsh-imagegen-video` 的 `docs/suanli-integration-design.md`（PR #1 @ `4d8d8c5`）。
本表按 AC 编号列出**能自动验证的部分**与**必须在真实环境里验证的部分**，以及各自的证据。
复跑命令见文末。

约定：`已自测` = 本仓库/宿主仓库里的自动化检查覆盖且通过；`需真实环境` = 需要登录的小助手、
真实网关账号或桌面安装包才能验证，开发方本地无法替代。

## P1

| AC | 结果 | 证据 |
|---|---|---|
| AC-1.1 头部只有「创作」与模块 tab | 已自测 | `verify-no-brand` 通过；`smoke.mjs` D6 两种语言都有标题；视觉确认见 PR 截图 |
| AC-1.2 全界面无「团团」与可点击 github 链接 | 已自测 | `verify-no-brand`（6 个标记扫 `src/`、`locale/`、`assets/`、`lib/`、包入口）；`smoke-panel-contracts` C6 |
| AC-1.3 运行期不访问 `api.github.com` | 部分 | `verify-no-brand` 只允许服饰姿势库一处（WP8 下线后例外自动失效）；其余路径无该域名 |
| AC-1.4 品牌守卫与反向用例 | 已自测 | `verify-no-brand` clean + `verify-negative no-brand` 1/1 |
| AC-2.1 模型清单与网关目录一致 | 部分 | 宿主 `media()` 与插件投影有 24 项断言（含真实回环网关）；列表一一对应需真实账号 |
| AC-2.2 断网用缓存并给出原因 | 已自测（宿主侧） | `composition.spec.ts`：网关关掉后重启仍返回存储的目录且状态 `unreachable`；面板呈现需真实桌面 |
| AC-2.3 退出登录即 `signed-out` | 已自测（宿主侧） | `service.spec.ts`：凭据事件触发重读、无凭据时不发请求即 `signed-out`；桌面登录态需真实环境 |
| AC-2.4 设定与数据目录无账号凭据 | 已自测 | `smoke-settings-migration` 6 项（清理内容不含任何密钥值）；`smoke-gateway-catalog` 断言目录响应不含密钥；整目录递归搜索需真实机器 |
| AC-2.5 宿主 9 项 + 插件 5 项 | 已自测 | 宿主 `suanli-model-catalog` 50 项；插件 `smoke-gateway-catalog` 19 项 |
| AC-3.1 设置页无渠道/密钥/存储配置 | 已自测 | `smoke-panel-contracts` C6 + `verify-negative panel-contracts`（注入 `channelSecrets` 即红） |
| AC-3.2 旧密钥首次启动清空且幂等 | 已自测 | `smoke-settings-migration` 6 项：一次 mutate 清四类、干净时不写、二次运行不写 |
| AC-3.3 五种模式真实可生成 | 需真实环境 | 代码侧由 `smoke-maas-wire`（7 项）与 `smoke-maas-families`（12 项）钉住线级契约 |
| AC-3.4 提示词增强/画布轻技能可用 | 部分 | 已改走宿主对话模型，路由级正常；需真实会话模型 |
| AC-4.1 侧栏入口位置与样式 | 已自测 | `smoke.mjs` D3（order 20、两个座位、标签）+ `verify-ui-contracts`；视觉见截图 |
| AC-4.2 切换不丢会话状态 | 需真实环境 | 中心列归外壳所有，插件不接管；需在真实外壳里切换验证 |
| AC-4.3 停用后入口消失 | 已自测（插件侧） | `smoke.mjs` D3 断言两个 disposer 卸掉注册；插件管理页操作需真实环境 |
| AC-4.4 插件异常不影响启动 | 部分 | `apply` 内各挂载点都包了降级；无专门注入用例 |
| AC-5.1 系统提示 ≤600 字且静态 | 已自测 | `verify-agent-surface`：236 字、无地址/旧品牌/密钥、快照一致 |
| AC-5.2 对话里生图/改图/生视频 | 需真实环境 | 工具与运行时有 29 项 canvas agent + 7 项 maas wire 覆盖；真实模型需账号 |
| AC-5.3 重任务技能默认关 | 已自测 | `smoke-panel-contracts` C7（schema 默认值与 resolve 兜底两处）+ 反向用例 |
| AC-9.1 桌面开箱可用 | 阻塞 | 需宿主 WP9 打包接线（依赖 `dist` 分支的 tgz） |
| AC-9.2 启动开销 | 部分 | 插件 `apply` 不阻塞、目录读取在宿主侧异步；可断言指标需真实安装包 |
| AC-9.3 网关不可用时其余功能正常 | 已自测（宿主侧） | `composition.spec.ts` 覆盖网关不可用；桌面端待安装包 |
| AC-9.4 CI 全绿 | 部分 | 插件 `pnpm test` 与 `pnpm test:negative` 全绿；宿主侧见下 |

## 复跑命令

插件仓库：

```sh
pnpm typecheck && pnpm build
pnpm test            # 91 个脚本
pnpm test:negative   # 37 组、271 条反向用例
```

宿主仓库：

```sh
pnpm run typecheck
pnpm run lint
pnpm run test:docs
npx vitest run packages/llm/suanli-model-catalog packages/settings/settings
```

## 宿主的已知红灯（与本 PR 无关）

- `verify-cli-help`、`verify-default-product-isolation`、`verify-product-use`：需要 `@michengai/dsh-codex-pet` 的发行包清单，本机无法从 `raw.githubusercontent.com` 取得。
- `verify-persistence-changes`：7 条会话格式变更（wechat 来源、标题请求、`providerRequestId`）缺兼容性复核记录。
- `duplication`：3 处既有克隆（`ConnectionPill` 两份、`tasks.ts` 内部一处）。
