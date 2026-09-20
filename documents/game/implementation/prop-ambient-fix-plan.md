# game 实现：prop ambient cube「不生效」修复方案（I）

> 本文只给**施工步骤**，不改代码。现状、机制与全部取证数据见 [prop-ambient-lighting.md](./prop-ambient-lighting.md)（定位结论在它的 §8；本文是那份结论的施工展开）。
> - 落点工程：`test/game-core`（绝对隔离，仓库根 `src/` 零引用，见 [../../../AGENTS.md](../../../AGENTS.md) §2.1）。
> - 事实基准：2026-09-19 实测。three 版本 **0.165.0**（`test/game-core/node_modules/three/package.json:3`）；所有 `文件:行号` 锚点以该版本与当前代码为准。
> - 阶段编号 **P1/P2/P3** 对应三处断点，可**独立落地、独立回退**（P1 单独就能让 73% 的 prop 吃到光照）。
> - 一句话结论：**数据端是对的（439/439），断点全在渲染端**——①cube 挂在 Group 上取不到；②varying 写不进去；③解码量级差三个数量级。

---

## 1. 施工范围

### 1.1 三处断点与阶段对应

| 阶段 | 断点 | 命中面（surf_666） | 现象 | 修复成本 |
|---|---|---|---|---|
| **P1** | `node extras.ambientCube` 落在 GLTFLoader 包的 **Group** 上，子 Mesh 拿不到 | **366/501 = 73%** | `applyAmbientCubeIfAny` 首行 return ⇒ 纯 fullbright | 仅改 TS，不动 wasm |
| **P2** | VS 注入锚点在 `#if defined(USE_ENVMAP) \|\| defined(USE_SKINNING)` 内，被预处理剔除 | 剩余 **135/501 = 27%** | `vbspWNormal` 从未赋值 ⇒ FS 读未定义 varying | 仅改 TS |
| **P3** | cube 解码量级比 lightmap 暗约 **1360×** | 修完 P1/P2 后的**全部** prop | 应用后 prop 近黑（与 P1 出帧「近黑 11.9%」自洽） | 改 Rust + 出帧校准 |

### 1.2 不在本方案内

- 「整体太暗 / 想接运行时光源」：见 [scene-brightness-and-lights.md](./scene-brightness-and-lights.md)（当前管线全部 mesh 都是 `MeshBasicMaterial`，加灯零效果；亮度只能靠曝光旋钮）。

- `prop-ambient-lighting.md` §7 的五条（sprp `m_Lighting`、v11 `diff_modulation`、顶点级插值、VMT 材质调制、兜底策略）：属**精度提升**，与「不生效」无因果关系。
- 体积雾（三张本地图均无 `env_fog_controller`）：挂起，等需求澄清。
- world 面 lightmap 路径：已验收，不在改动面内（但 P3 的校准要以它为标尺）。

---

## 2. P1（断点 A）：把 cube 从 Group 上取下来

### 2.1 根因（三行代码串成的断层）

1. 导出端把 cube 写在 **node extras**：`test/game-core/crates/wasm-core/model_integrator/mod.rs:132-137`（`json!({"ambientCube": c})`），节点在 `:149` 入列。
2. 一个 prop 模型有 N 个材质 ⇒ `push_model`（`test/game-core/crates/wasm-core/model_integrator/mod.rs:193-212`）产出 **N 个 primitive**（`push_primitive`，同文件 `:291-361`）。
3. three 0.165 的 GLTFLoader：`meshes.length === 1` 才返回 Mesh，**否则 `new Group()` 包住全部 primitive**（`node_modules/three/examples/jsm/loaders/GLTFLoader.js:3862-3882`）；随后 `loadNode` 把 **node extras 赋给那个 Group**（`GLTFLoader.js:4280`），子 Mesh 只拿到空的 `meshDef.extras`（`GLTFLoader.js:3843`）。
4. 渲染端只读 Mesh：`applyAmbientCubeIfAny` 首行 `mesh.userData.ambientCube`（`test/game-core/src/renderer/lightmap-shader.ts:517`）⇒ 恒 `undefined` ⇒ `:518` 直接 return。

### 2.2 实测（surf_666，501 个带 cube 的 prop node 所指向 mesh 的 primitive 数分布）

```
1prim:135   2prim:209   3prim:93   4prim:54   5prim:10
⇒ primitives > 1 的 node = 366（73%）→ 落成 Group；= 1 的 = 135（27%）→ 是 Mesh
```

### 2.3 三条候选方案（含否决理由）

| 方案 | 做法 | 判定 |
|---|---|---|
| A-a **渲染端向上回溯一层**（推荐） | `mesh.userData.ambientCube ?? mesh.parent?.userData.ambientCube` | ✅ 采用。cube 是 **per-instance**，Group 就是 prop node 本身，语义天然正确；只改 TS，无需重编 wasm；对单 primitive 的 135 个也兼容（Mesh 自身即 node） |
| A-b **加载后下发** | GLTF onLoad 遍历：node 带 `ambientCube` 就写给所有后代 Mesh | ✅ 可备选（等价、更显式），但要新增一次全树遍历，且必须在 `applyLightmap` 之前 |
| A-c **改写到 primitive extras** | 导出端把 cube 写进 `json::mesh::Primitive.extras` | ❌ **否决**：`push_model` 只产出一个 mesh，**所有实例共享同一 mesh**（`mod.rs:120-124` 注释即「同一模型的多个实例共享同一 mesh」）⇒ primitive extras 是**共享**的，装不下 per-instance cube。注：world 面的 `hasLightmap` 走 primitive extras（`test/game-core/crates/wasm-core/bsp_to_gltf_core/convert.rs:1138`）成立，是因为它是**面级常量**，不是实例级 |

### 2.4 改动（只动一个文件）

`test/game-core/src/renderer/lightmap-shader.ts`，改 `applyAmbientCubeIfAny`（`:516-518`）：

```ts
function applyAmbientCubeIfAny(mesh: THREE.Mesh, mat: THREE.MeshBasicMaterial): void {
	// cube 写在 **node extras** 上（model_integrator/mod.rs:132），而 multi-primitive 的
	// prop 被 GLTFLoader 包成 Group（GLTFLoader.js:3862-3882），extras 落在 Group 而非子
	// Mesh（GLTFLoader.js:4280）⇒ 必须向上回溯。实测 surf_666 有 366/501（73%）的 prop
	// 走这条路径，不回溯就永远拿不到 cube（= 纯 fullbright）。
	const cube = resolveAmbientCube(mesh);
	if (!Array.isArray(cube) || cube.length !== 18) return;
	...
}

/** 从 Mesh 自身向上找 ambientCube（最多回溯 2 层：Mesh → prop node(Group)）。 */
function resolveAmbientCube(mesh: THREE.Mesh): unknown {
	let obj: THREE.Object3D | null = mesh;
	for (let depth = 0; depth < 2 && obj; depth++) {
		const c = (obj.userData as { ambientCube?: unknown }).ambientCube;
		if (c !== undefined) return c;
		obj = obj.parent;
	}
	return undefined;
}
```

同时加**命中计数**（验收要用，见 §2.5）：在同一函数内 `return` 前与成功分支各累加一次全局计数。

```ts
const st = ((globalThis as { __vbspAmbientStats?: { hit: number; miss: number } })
	.__vbspAmbientStats ??= { hit: 0, miss: 0 });
```
并在 `reportInjectStatsOnce`（`test/game-core/src/renderer/renderer-main.ts:905`）旁或首帧后打一条
`[ambient-cube] 命中=<hit> 未命中=<miss>`。

> 时序不变：`applyLightmap(scene, gltf)`（`test/game-core/src/renderer/renderer-main.ts:295`）仍在 `optimizeScene`（同文件 `:323`）**之前**执行；`optimizeScene` 合并时**材质实例被保留**（同文件 `:1174-1191` 按材质实例分组 ⇒ 每 prop 一个材质、各带自己的 uniform），合并后 chunk mesh 换父节点不影响已注入的 `onBeforeCompile`。

### 2.5 验收判据

| 判据 | 期望 |
|---|---|
| 命中计数 | surf_666 从 **135 → 501**（`miss` 只应剩 world 面）；surf_null 从 N → 81 |
| 控制台 | 无 `[ambient-cube] 注入未生效` 报错 |
| 出帧 | 同一位姿对比，prop 区域平均亮度**下降**（不再 fullbright）。`node scripts/lightmap-frame-capture.mjs --label p1 --map surf_666.bsp --pose spawn` |
| 回归 | `npm run typecheck`、`npm run test:lightmap-gltf`（82 断言）、`npm run test:lightmap-decode`、`npm run test:lightmap-guard`、`npm run check:api`、`npm run test:phys`（五指纹）、`npm run test:seed-smoke` 全绿 |

> ⚠️ P1 单独落地后，prop 观感会**先变暗甚至近黑**（P3 的量级问题）——这是**预期**，不要据此回滚 P1。判据只看「命中数 501」。

---

## 3. P2（断点 B）：把 varying 真正写进顶点着色器

### 3.1 根因

three 0.165 的 `ShaderChunk.meshbasic_vert`（`node_modules/three/build/three.module.js:14032`）：

```glsl
#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
#endif
#include <begin_vertex>
```

`applyAmbientCubeIfAny` 把 `vbspWNormal = normalize( mat3( modelMatrix ) * objectNormal );` 插在 `#include <beginnormal_vertex>` 之后（`test/game-core/src/renderer/lightmap-shader.ts:527-534`）⇒ **落在 `#if` 块内**。而 `applyFullbrightBasic`（同文件 `:489-504`）造的是无 envMap、无蒙皮的 `MeshBasicMaterial` ⇒ 两个宏都未定义 ⇒ 整块（连同 `objectNormal` 的声明）被预处理剔除 ⇒ varying 从未赋值。

FS 侧锚点 `reflectedLight.indirectDiffuse *= diffuseColor.rgb;` **确实存在**（`three.module.js:14034` 的 `fragment$a`）⇒ 字符串替换命中成功 ⇒ `vsChanged && fsChanged` 守卫（`:555-563`）**不会报错**——这是它一直静默的原因。

### 3.2 改动

`test/game-core/src/renderer/lightmap-shader.ts:531-534`，把 VS 锚点从 `#include <beginnormal_vertex>` 换成 **不在 `#if` 内的** `#include <begin_vertex>`，并直接用 `normal` 属性：

```ts
const vsB =
	vsA !== vs
		? vsA.replace(
				'#include <begin_vertex>',
				'#include <begin_vertex>\n\tvbspWNormal = normalize( mat3( modelMatrix ) * normal );',
			)
		: vsA;
```

要点：

- `attribute vec3 normal;` 由 three 的 `prefixVertex` **无条件声明**（非 RawShaderMaterial 路径），不依赖任何宏；
- prop 几何带 NORMAL 访问器（`test/game-core/crates/wasm-core/model_integrator/mod.rs:272-287`），可用；
- world 面几何**没有**法线（`bsp_to_gltf_core` 只写 POSITION/UV），但它们没有 cube ⇒ 走不到本函数（`:518` 守卫），不会被污染；
- `modelMatrix` 含旋转+缩放，prop `scale = 1`（`mod.rs` 的 Placement 语义）⇒ 不会引入非均匀缩放的法线畸变。

### 3.3 验收判据

| 判据 | 期望 |
|---|---|
| `__vbspAmbientInject.applied` | 501 个 prop 材质全部 `true`（`vsChanged && fsChanged` 都命中） |
| 控制台 | 无 `[ambient-cube] 注入未生效` |
| 出帧 | 与 P1 后同图同位姿对比：prop **不再是死黑一片**，且**随朝向有明暗变化**（法线加权生效的直接证据）。可在 spawn 位姿取 prop 特写帧，比较其朝上面 vs 朝下面的像素亮度差 |
| 回归 | 同 §2.5 回归清单 |

---

## 4. P3（断点 C）：量级校准

### 4.1 实测数据（surf_666，同一套 RGBExp32 解码：`mantissa/255 × 2^(exponent as i8)`，各抽样 4 万条）

| 数据源 | p50 | 均值 | p90 | max |
|---|---|---|---|---|
| lump56 ambient cube | 4.28e-5 | 1.34e-4 | 3.14e-4 | 1.65e-3 |
| lump8 lightmap（world 面，观感已验收） | 5.83e-2 | 1.17e-1 | 2.90e-1 | 1.87e+0 |
| **比值（lightmap / ambient）** | **1362×** | 873× | 924× | 1132× |

exponent 字节分布：ambient 集中在 **236-247**（i8 = -20..-9），lightmap 集中在 **249-255**（i8 = -7..-1）；ambient mantissa 均值 118.7、max 255。

### 4.2 两种口径

| 口径 | 公式 | 结果相对 lightmap | 判定 |
|---|---|---|---|
| 现状（`decode_linear`） | `m/255 × 2^exp` | **1/1362 ~ 1/873** | ❌ 应用即近黑，已与 P1 出帧「近黑 11.9%」互相印证 |
| 外部参照实现口径 | `m × 2^exp`（**不除 255**；外部参照实现 `Utils.ts:38-44` 即 `r * exponentTable[exp]`，只是它把指数偏置写成 `2^(e-128)` 是错的，应取 i8） | **1/5.3 ~ 1/3.4** | ✅ 量级合理（ambient 本就只有间接光，比含直射的 lightmap 暗几倍符合预期） |

### 4.3 推荐起点

改 `test/game-core/crates/wasm-core/vbsp/data/game.rs:391-401`，新增 ambient 专用解码（**保留** `decode_linear` 给 lightmap，两者不可混用）：

```rust
impl ColorRgbExp32 {
    /// lightmap 口径：mantissa/255 × 2^exp（保持不变）。
    pub fn decode_linear(&self) -> [f32; 3] { /* 现状实现，不动 */ }

    /// leaf ambient cube 口径：mantissa × 2^exp（**不除 255**）。
    /// 依据：同图实测 ambient 解码值比 lightmap 暗 873~1362×，除掉 255 后为 3.4~5.3×，
    /// 与「ambient 只含间接光」的物理预期一致；外部参照实现 `Utils.ts:38-44` 同为「不除 255」。
    pub fn decode_linear_ambient(&self) -> [f32; 3] {
        let scale = 2.0f32.powf(self.exponent as i8 as f32);
        [self.r as f32 * scale, self.g as f32 * scale, self.b as f32 * scale]
    }
}
```

调用点改为 `test/game-core/crates/wasm-core/vbsp/mod.rs:599`：`face.decode_linear_ambient()`。

**π 归一（必须一并对齐）**：three 的 lightmap 路径是 `lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI`（`three.module.js:14034`），而 prop 的 fullbright 路径是 `+= vec3(1.0)` 后乘 cube（无 `/π`）。按 §4.2 的推荐口径算：

```
world 面有效系数 = lightmap × 0.318
prop 有效系数    = ambient_new = lightmap / 3.42 = lightmap × 0.292
⇒ prop / world ≈ 0.92（分位区间 0.59 ~ 0.92）
```

即**不再额外乘 `1/π`** 就已经落在「prop 约比 world 暗 8%~40%」的合理区间——与 Source 里「prop 只吃 ambient，比周围墙面略平略暗」的观感一致。若出帧后仍偏亮/偏暗，用 §4.4 的单一常量微调，**不要**再动解码公式。

### 4.4 校准流程（唯一可调旋钮 = 一个常量）

1. 在 `vbsp/mod.rs` 顶部加 `const AMBIENT_SCALE: f32 = 1.0;`（默认 1.0），`decode_linear_ambient()` 结果统一乘它。
2. 出帧 A/B（**同一位姿、同一地图**，prop 特写 + 全景各一张）：
   `node scripts/lightmap-frame-capture.mjs --label amb100 --map surf_666.bsp --pose spawn`
3. 判据（按优先级）：
   - **主判据**：prop 区域平均亮度 ≈ 同帧邻近 world 面平均亮度的 **0.7 ~ 1.0 倍**（用出帧 JSON 的亮度统计 + 目视）；
   - **副判据**：prop 不再出现「近黑」团块（近黑像素占比回到与 world 面同量级）；
   - **约束**：中性灰兜底 prop（surf_666 62 个）不得比周围 world 面明显更亮。
4. 只调 `AMBIENT_SCALE`（建议步长 0.5× / 0.75× / 1.5× 三档先扫一遍），确定后把最终值写回本文与 `prop-ambient-lighting.md` §3。

**✅ 2026-09-19 校准结果（P3 落地）**：扫描实测（surf_666 spawn 位姿，ROI 量化 `prop=[448,320]-[800,384]`、world=两侧墙）：0.75→ratio 0.709、**1.0→0.713（选定，∈ [0.7, 1.0] 主判据达标）**、1.5→0.721、300→1.87（链路二分）、常数 5.0→3.04（链路二分）。曲线单调 ⇒ uniform→shader→输出链全程传导；0.75~1.5 档间读数变化小是暗部 sRGB 感知压缩 + 8bit 量化的预期。**最终 `AMBIENT_SCALE = 1.0`（`vbsp/mod.rs:18`）**。中性灰兜底已联动改为 `AMBIENT_SCALE × 0.0109`（新口径域 p50）。完整的修复落地记录见 [prop-ambient-lighting.md §9](./prop-ambient-lighting.md)。

### 4.5 兜底中性灰的连带修正（P3 收尾项）

`NEUTRAL = [0.2139; 18]`（`test/game-core/crates/wasm-core/vbsp/mod.rs:523`，= 外部参照实现 `0x7f` 的线性等价值）在新口径下**偏亮**：0.2139 相当于 lightmap 0.73 的水平，亮于全图 90% 的面 ⇒ 兜底 prop 会比正常 prop 更亮，观感突兀。
建议（与 `prop-ambient-lighting.md` §7 第 5 条同向）：改为**全图 ambient 中位数**（导出端一次算好、随 cube 一起下发），或退一步取 `全图 lightmap 中位 × 0.318`。本项可在量级校准通过后单独做，不阻塞 P3 主体。

---

## 5. 施工顺序与每步验收命令

| 步骤 | 动作 | 验收命令 / 判据 | 回退点 |
|---|---|---|---|
| 0 | 现状基线帧（留档对比） | `node scripts/lightmap-frame-capture.mjs --label base666 --map surf_666.bsp --pose spawn` | — |
| 1 | **P1**：`lightmap-shader.ts` 加 `resolveAmbientCube` + 命中计数 | `npm run typecheck`；命中数 **135 → 501** | 删 `resolveAmbientCube`，还原 `:517` 单行读取 |
| 2 | **P2**：VS 锚点换 `#include <begin_vertex>` | `npm run typecheck`；`__vbspAmbientInject.applied` 全 true；prop 出现朝向明暗差 | 换回 `beginnormal_vertex`（不推荐，仅应急） |
| 3 | 回归（P1+P2 后必跑） | `npm run test:lightmap-gltf`（82 断言）、`test:lightmap-decode`、`test:lightmap-guard`、`check:api`、`test:phys`（五指纹）、`test:seed-smoke` | — |
| 4 | **P3-a**：`vbsp/data/game.rs` 增 `decode_linear_ambient` + `vbsp/mod.rs:599` 改调用 + `AMBIENT_SCALE` | `npm run build:wasm`；`npm run check:api` | 改回 `decode_linear()` |
| 5 | **P3-b**：出帧 A/B 扫 `AMBIENT_SCALE`（1.0 → 0.75 / 1.5） | 主判据 prop/world 亮度比 0.7~1.0 | 调回 1.0 |
| 6 | P3-c：兜底中性灰改全图中位数（可选） | 兜底 prop 不再突兀 | 还原常量 `[0.2139; 18]` |
| 7 | 全量回归 + 两图各出一帧 | surf_666 + surf_null 各 `--pose spawn`；同 §2.5 清单全绿 | — |

> 动 Rust 后必须 `npm run build:wasm`（wasm-pack）+ `npm run build:dist`；`test:phys` 五指纹（gravity -12.50/tick、landing tick 31、jump 289.49、crouch 46.04、teleport tick 24）与 `test:lightmap-gltf` 82 断言是**回归底线**。

---

## 6. 风险与未决

1. **P3 的量级口径是推断，不是定论**：「不除 255」由「与 lightmap 差 255×、残差 3.4~5.3× 符合 ambient 物理预期 + 外部参照实现同为不除 255」两条证据支撑，但**没有引擎源码级证据**。所以 §4.4 把它做成单一可调常量、用出帧 A/B 收敛，而不是写死。若 A/B 怎么调都不对，回头复核：ambient 是否该与 lightmap 同走 `/255` 而另有一处引擎侧缩放。
2. **P2 的 NaN 史**：修好前，未定义 varying 在 SwiftShader/ANGLE 上的取值是实现相关的（可能黑、可能白）。出帧若看到「prop 黑白斑驳」，先确认 P2 已生效再判读。
3. **P1 的 per-instance 前提**：`optimizeScene` 的按材质实例分组（`test/game-core/src/renderer/renderer-main.ts:1159-1191`）是 prop 各自保留 uniform 的前提；若将来改成「同材质合并共享一个材质实例」，per-instance cube 会失效——届时须改走实例属性（`InstancedMesh` + per-instance uniform/attribute）通道。
4. **中性灰 prop**（surf_666 62 / surf_null 4）：无论量级怎么校准，它们都只是「无数据」，见 §4.5。
5. **回并 `apps/game`**：本方案的改动面全在 `test/game-core`；回并时 P1/P2 是纯 TS 可直接搬，P3 涉及 `crates/wasm-core` 的解码语义，需同步核对 `src/wasm-core`（共享层）里的同名实现是否同源。
