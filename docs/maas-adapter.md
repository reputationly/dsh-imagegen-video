# 自家 MaaS 适配层（h3-image / h3-v2）

本 fork 只做一件事：把模型调用从「公开渠道」换成自家 MaaS 网关，其余全部保持上游原样。
改动面固定为 6 个源文件 + 2 个 smoke，合并上游时只需重放这些改动。

## 两个新协议族

| 族 | 用途 | 端点 | 关键语义 |
|---|---|---|---|
| `h3-image` | 图像 | `POST /images/generations`、`/images/edits` | **只认 `size`**（`WIDTHxHEIGHT`），不认 `aspect_ratio` / `resolution` |
| `h3-v2` | 视频 | `POST /videos` → `GET /videos/{id}` | `metadata.image_mode` 区分玩法，成品在 `metadata.url` |

族的判定与上游其它族一样按模型 id 正则：

- `^minimax[-_.]?h3[-_.]?image` → `h3-image`（含聚合模型 `-enhanced`）
- `^minimax[-_.]?h3[-_.]?(fl2va|ref2va|l2va|2k|ref-2k)` → `h3-v2`
- 裸名 `minimax-h3` 仍然是上游的 Nbility 契约，不受影响

## 三条必须守住的规则

1. **聚合模型（`-enhanced`）不能发 `size`。**
   网关只在客户端没传尺寸时才用提示词增强自动定画幅并映射到 2K 画布；一旦传了
   `1024x1024` 这种低于 2K 的值，网关的尺寸策略会直接 400。
   反之裸模型必须由我们把面板比例换成 2K 档像素（`2720x1536` / `2048x2048` / …）。
   实现在 `src/engine.ts` 的 `effectiveParams`，尺寸表是 `H3_IMAGE_2K_SIZE_BY_RATIO`。

2. **参考图不能放顶层 `images`。**
   顶层 `image` / `images` 在网关里是「首帧/尾帧」；参考族的素材必须放
   `metadata.src_ref_images`，否则会被当成首帧，画面完全不同。参考图上限 9 张。

3. **分辨率只有 768P。**
   2K 是网关照聚合模型（`minimax-h3-2k` / `minimax-h3-ref-2k`）在服务端做的
   「生成 768P + RelayVSR 超分」，客户端传 2K 没有意义，传了反而会被拒。

## 参考素材上传

本地素材是 data URL，网关只接受可用 URL，所以提交前先 `POST /ov/files`（multipart，
字段名 `file`，上限 32MB）换回签名 URL。实现在 `h3v2SubmitBody` + `uploadH3Reference`。

## 触发哪些网关侧增强

选聚合模型名即触发，插件不需要自己实现任何增强：

| 用途 | 模型名 | 网关流水线 |
|---|---|---|
| 生图（自动定画幅） | `minimax-h3-image-enhanced` | qwen3.8 提示词增强 → `minimax-h3-image` |
| 视频 FL2VA | `minimax-h3-2k` | `minimax-h3-fl2va`（768P）→ 超分 2K |
| 视频 Ref2VA | `minimax-h3-ref-2k` | `minimax-h3-ref2va`（768P）→ 超分 2K |

注意：聚合模型名要在令牌白名单里，否则网关会 404（它没有渠道 ability，
展开发生在白名单校验之后）。

## 验证

```sh
pnpm typecheck
pnpm build
node scripts/smoke-maas-families.mjs   # 族判定与预设
node scripts/smoke-maas-wire.mjs       # 真正发出去的请求体（拦 fetch，不联网）
```

`smoke-maas-wire.mjs` 是这套适配层的契约测试：上游改了哪个族的 body，
它先红，比在界面上点出来得快。
