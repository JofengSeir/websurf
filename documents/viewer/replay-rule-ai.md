# ⚠ 历史注记：`.js` 规则脚本通道已移除（2026-09，t4）

> **本文不再是现行规范。** viewer 的录像管线已改为 **Shavit `.replay` 二进制原生解析**（无 JSON 中转、
> 无规则脚本），`codegen.ts` / `rule-file.ts` / `default-rule.ts` / `sample.ts` 及全部相关 UI 已删除。
> 代码证据：`apps/viewer/src/replay/shavit-replay.ts`（原生解析器）、
> `apps/viewer/src/worker/main.ts:44-49`（嗅探失败即报错"JSON/规则脚本通道已移除"）、
> `apps/viewer/src/replay/types.ts:1-6`（管线头注）。
>
> **现行文档**：
> - 管线与模块全貌 → [implementation/replay-system.md](implementation/replay-system.md)
> - `.replay` 格式规格与坐标定标 → [implementation/shavit-replay-format.md](implementation/shavit-replay-format.md)
> - 使用方式 → [../../apps/viewer/README.md](../../apps/viewer/README.md)
>
> 本文余下内容仅供历史参考：原来的 `.js` 单表达式规则写法契约、提示词模板与自家标准 JSON 格式说明。
> 完整原稿（未删节）已移出版本库，可在 git 历史中追溯。
> 若未来需要接入第三方 JSON 录像，建议以 `RuleConfig v2` 的"映射切换 + 人工变换"形态扩展原生解析器，
> 而不是恢复运行期脚本编译（`new Function` 动态执行面已随本通道移除）。

---

（以下为原稿 §1-§8 的历史保留摘要——其中行号、字段表、`scriptSrc`/`framePath` 契约均对应**已删除**的
`types.ts` v1 / `codegen.ts` / `default-rule.ts`，与当前代码不符，仅作背景。）

- **当时管线**：任意 JSON → 规则脚本（`.js` 单表达式 / 规则 JSON）映射 → 标准帧 `Frame` → `Clip`（定型数组）→ 播放。
- **当时契约**：`scriptSrc` 为一等公民（单表达式，返回 `{pos, ang, vel?}`），声明式字段（posX/axisX/sign…）为辅助；
  助手集 `REPLAY_HELPERS`（get/num/wrap/pickFrameArray…）作为第三实参注入；编译前做三帧试跑校验。
- **当时自家格式**：`{ map, frames: [{ pos:[x,y,z], ang:[yaw,pitch], vel? }] }`，内置默认规则直通。
- **移除原因（t4）**：播放基准 bug 的根因之一——JSON 相对坐标迫使"起点对齐/锚定" machinery 存在；
  Shavit `.replay` 帧本身是绝对世界坐标（含定标映射后与地图 GLB 自洽），原生解析后锚定机制整体删除，
  JSON 通道随之退场（详见 replay-system.md 与 shavit-replay-format.md）。
