/**
 * RGBExp32 lightmap 解码着色器注入（阶段 3）。
 *
 * 移植自 `apps/debug/src/renderer/lightmap-shader.ts`（本仓库既有实现；三工程互不引用，
 * 故按架构约定移植而非跨工程 import）。上游口径 = 外部参照实现的
 * `Resources/src/Shaders/LightmappedBase.ts:39-66`，但**显示 gamma 一项不照抄**（2026-09-18
 * gamma-parity 计划 §3.1a 矫正）：
 * - 指数在 **α 通道**：`exp = alpha * 255 - 128`，`rgb_linear = rgb * 2^exp`
 * - 纹理必须 `Nearest` + `NoColorSpace`（硬件插值会先混指数再解码，得到错误结果）
 * - **手写双线性**：先对 4 个 texel 各自解码再 `mix`，不依赖 GPU 过滤
 * - **解码保持线性**（`max(decoded, 0)`，不再 `pow(1/2.2)`）：RGBExp32 的 rgb 是线性辐射度，
 *   three 的 `colorspace_fragment`（linear→sRGB）承担显示 gamma。外部参照实现的
 *   `pow(1/2.2)` 是其 **sRGB 域直出**管线里的显示变换，照抄进 three 线性管线会构成
 *   **双重 gamma**（实测暗部 texel 提亮 +40%~+230%，全亮区一致 ⇒ 「整体偏亮、暗部发灰」）。
 *   修正后最终色 = `base_linear × decoded_linear`，与外部参照实现的残差仅 sRGB 曲线差（几个百分点）。
 * - r151+ 的 lightMap 槽 UV 由 `Texture.channel` 决定（本工程用 channel=1 读 uv1）
 *
 * 与上游副本的差异（本轮新增，契约 §9.6.1 的 `extras.hasLightmap`）：
 * 图元 `extras.hasLightmap === false` 表示该图元只有中性占位 UV（无真实 luxel），
 * 此时**不施加** lightmap，避免用无意义 UV 去采图集里的别的面的数据。
 */

import * as THREE from 'three';
import type { GLTF, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';

// ---------------------------------------------------------------------------
// GLSL 着色器片段
// ---------------------------------------------------------------------------

/**
 * 解码单个 RGBExp32 样本。
 * atlas 为 RGBA8（NoColorSpace，值 [0,1] = 原始字节/255）：
 * RGB = mantissa，A = exponent 偏移（exp+128）。
 * 解码：exp = alpha * 255 - 128; rgb * pow(2, exp)，与 Source RGBExp32 一致。
 */
export const VBSP_DECOMPRESS_LIGHTMAP_SAMPLE = /* glsl */ `
vec3 vbsp_DecompressLightmapSample(vec4 texel) {
	float expV = texel.a * 255.0 - 128.0;
	return texel.rgb * pow(2.0, expV);
}
`;

/**
 * 手动双线性采样 + RGBExp32 解码。
 * atlas 用 NearestFilter 保留 raw 字节（避免硬件插值破坏指数编码），
 * 故在 shader 中手动采样 4 个最近邻，每个样本先解码再 mix。
 *
 * ## ⚠️ 显示 gamma 必须套在 **lightmap 项**上，不能套在乘积上（2026-09-20 根因修复）
 *
 * three 原生 `MeshBasicMaterial` 的算式是 `outgoing = diffuseColor.rgb × lightMapTexel.rgb`
 * （`outgoingLight = diffuseColor.rgb * (1.0 + totalEmissiveRadiance)`，lightmap 经
 * `reflectedLight.indirectDiffuse` 并入）。本工程把 `lightMapTexel.rgb` 这一项换成
 * `vbsp_ApplyLightmap(...)` 的返回值 ⇒ **本函数返回什么，就直接等于「光照项」**。
 *
 * 此前本函数返回 `pow(decoded, 1/2.2) * vbspExposure`，即 gamma 被套在
 * **albedo × lightmap 的乘积**上。后果是暗部被压死：
 *
 * | 量 | 值 |
 * |---|---|
 * | 暗部 lightmap 解码值 | ≈ 1.2e-2（实测 p50） |
 * | 正确口径 `pow(1.2e-2, 1/2.2)` | ≈ **0.136**（可见） |
 * | 错误口径 `pow(0.13 × 1.2e-2, 1/2.2)` | ≈ 0.019（≈ 正确值的 1/7） |
 *
 * 用户原话「亮度拖爆了，暗的地方就是黑的，000000 纯黑」即此——乘任何 exposure 都救不回
 * （0 乘任何数仍是 0）。**Source 的口径是 `albedo × pow(lightmap, 1/2.2)`**
 * （外部参照实现 `LightmappedBase.ts:66`：`inColor * pow(sample, 1/2.2)`），
 * 即 gamma 只作用于 lightmap 项 —— 与「PS 里把 lightmap 那层叠到材质上」同义。
 *
 * 因此本函数改为：**先对解码值做 `^(1/γ)` 提升，再返回**（调用方乘 albedo）。
 *
 * `vbspLightGamma`（默认 1.0）：作用在 lightmap项 上的 shadow-lift，兼作显示 gamma 旋钮
 * （>1 抬高暗部）。`vbspExposure`：全局倍率。两者都在 **lightmap 项**上、不碰 albedo。
 */
export const VBSP_APPLY_LIGHTMAP = /* glsl */ `
vec3 vbsp_ApplyLightmap(sampler2D atlas, vec2 uv) {
	vec2 atlasSize = vbsp_AtlasSize;
	vec2 px = uv * atlasSize - 0.5;
	vec2 ipx = floor(px);
	vec2 f = px - ipx;
	vec2 invSize = 1.0 / atlasSize;
	vec3 s00 = vbsp_DecompressLightmapSample(texture2D(atlas, (ipx + vec2(0.5, 0.5)) * invSize));
	vec3 s10 = vbsp_DecompressLightmapSample(texture2D(atlas, (ipx + vec2(1.5, 0.5)) * invSize));
	vec3 s01 = vbsp_DecompressLightmapSample(texture2D(atlas, (ipx + vec2(0.5, 1.5)) * invSize));
	vec3 s11 = vbsp_DecompressLightmapSample(texture2D(atlas, (ipx + vec2(1.5, 1.5)) * invSize));
	vec3 s0 = mix(s00, s10, f.x);
	vec3 s1 = mix(s01, s11, f.x);
	vec3 decoded = mix(s0, s1, f.y);
	// 先提升 lightmap 项（display gamma），再乘 exposure；**albedo 由调用方乘**。
	//
	// vbspLightFloor（暗部抬升下限）：把**几乎为零**的 luxel 抬到可见阈，消除「暗处纯黑、
	// 拖爆 exposure 也救不回」——下限是**加法**，而 0 乘任何数仍是 0。
	// 只影响 lightmap 值远小于 floor 的极暗区，中亮部与渐变完全不受影响（不是常数提亮）。
	vec3 lifted = max(decoded, vec3(vbspLightFloor));
	return pow(max(lifted, vec3(0.0)), vec3(1.0 / max(vbspLightGamma, 0.001))) * vbspExposure;
}
`;

/**
 * **光照项 uniform 声明的唯一事实来源**（2026-09-20 事故后立的规矩）。
 *
 * ## 为什么必须单一来源
 *
 * 三条注入路径（world lightmap / ambient cube / fullbright 兜底）都在**各自拼出来的
 * GLSL 片段**里引用同一批 `vbsp*` uniform，而声明原先散落在各路径的字符串里。
 * 只要新增一个 uniform 时漏改任一路径，那条路径的 fragment shader 就是
 * **`undeclared identifier`** —— 这不是"某个 uniform 取不到值"的软失败，而是
 * **GLSL 编译失败 ⇒ program 无效 ⇒ `drawArrays: no valid shader program in use`
 * ⇒ 该批 mesh 一个像素都不画**。几何与碰撞在 Rust 侧独立生成 ⇒ 实机表现正是
 * 用户报的「模型完全看不见、完全透明，但碰撞正常」。
 *
 * 本批实测（真实出帧 + `renderer.info.programs[].diagnostics`）：
 * `vbspLightFloor` 只加进了 world 路径的前置声明，**ambient cube 路径漏加**，于是
 * 全部带 `ambientCube` 的 prop（模型本体）与走 fullbright 的水面/远地面**整体消失**，
 * 失败 program 报 `ERROR: 0:90: 'vbspLightFloor' : undeclared identifier`。
 *
 * 回归护栏见 `scripts/lightmap-inject-guard-selftest.mjs` §10：断言「每个注入单元
 * 自己用到的 `vbsp*` 标识符，都能在同一单元里找到声明」。
 */
export const VBSP_LIGHTMAP_UNIFORM_DECLS = [
	'uniform vec2 vbsp_AtlasSize;',
	'uniform float vbspExposure;',
	'uniform float vbspLightGamma;',
	'uniform float vbspLightFloor;',
];

/** ambient cube（prop / fullbright 兜底）路径**额外**需要的 uniform：cube 数组 + 模型亮度。 */
export const VBSP_AMBIENT_UNIFORM_DECLS = [
	'uniform vec3 vbspAmbCube[6];',
	'uniform float vbspAmbientScale;',
];

/**
 * 第 1 级 prop 光照（逐顶点预烘焙）的几何属性名。
 *
 * 导出侧写在 GLB primitive 的自定义语义 `_VBSP_VLIGHT` 上（glTF 规定自定义属性须以 `_` 开头），
 * 但 **three 的 GLTFLoader 对未知属性名会转小写**
 * （`GLTFLoader.js`：`ATTRIBUTES[ name ] || name.toLowerCase()`）⇒ 运行期拿到的键是
 * `_vbsp_vlight`。这里的常量必须是**运行期**的名字，否则 `getAttribute` 恒为 null、
 * 整条第 1 级路径静默失效（本批实测踩过：日志里 `[vertex-lighting]` 一条都不打）。
 * 见 `crates/wasm-core/vhv.rs` 与 `model_integrator::push_vertices`。
 */
export const VERTEX_LIGHTING_ATTR = '_vbsp_vlight';

// MeshBasicMaterial 在 fragment shader 内联了 lightmap 采样块，替换为 vbsp_ApplyLightmap；
// 同时防御性兼容 include <lightmap_fragment> 的材质（理论上 MeshBasicMaterial 不会）。
const BASIC_INLINE_LIGHTMAP_SRC =
	'vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );\n\t\treflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;';

const BASIC_INLINE_LIGHTMAP_REPLACEMENT =
	'reflectedLight.indirectDiffuse += vbsp_ApplyLightmap(lightMap, vLightMapUv);';

const CHUNK_LIGHTMAP_INCLUDE = '#include <lightmap_fragment>';
const CHUNK_LIGHTMAP_REPLACEMENT =
	'reflectedLight.indirectDiffuse += vbsp_ApplyLightmap(lightMap, vLightMapUv);';

// ---------------------------------------------------------------------------
// 输出编码：纯 γ2.2（Source / 外部参照实现口径），替换 three 的分段 sRGB
// ---------------------------------------------------------------------------

/**
 * three 的 `colorspace_fragment` 是**分段 sRGB**（带线性 toe：`x<0.0031` 时 `12.92x`），
 * 而 Source / 外部参照实现的 LDR 口径是**纯 γ2.2**：
 * `.tmp/外部参照实现-master/.../Shaders/LightmappedBase.ts:66` 的
 * `inColor * pow(sample, 1/2.2)`，代数上等价于「用 γ2.2 编码乘积」
 * （`StudioModel.ts:96-98` 对 ambient cube 用 `linearToScreenGamma` 同源）。
 *
 * 二者**只在深暗部**分歧最大：sRGB 的线性 toe 把深暗部压低 2~3×，亮部几乎一致
 * （`scene-brightness-and-lights.md` §7.4 已量化：d=0.005 时 3.25×、d=0.878 时 1.00×）。
 * 这正是「室内（暗）死黑、露天（亮）正常」的成因 —— 室内那批贴图本身就暗
 * （实测 219 张贴图每张中位亮度 p50=75/255、p25=32/255），乘上中等 lightmap 后
 * 落进 sRGB 的线性 toe，被额外压掉约一半。
 *
 * 因此把三条受控材质路径（world lightmap / fullbright / prop ambient）的输出块
 * 整体换成纯 γ2.2 编码。**不动 `renderer.outputColorSpace`**：背景 clear color
 * 仍走 three 的 sRGB 路径，观感一致且不引入额外回归面。
 * 全部场景 mesh 都经 `applyLightmapToMeshes` 换上本文件的材质 ⇒ 覆盖面完整；
 * 诊断档（`--debug-albedo` / `noinject`）也必须同口径，否则 factor-decompose 的
 * 逐像素相除会混入输出曲线差。
 */
const COLORSPACE_CHUNK_NAME = 'colorspace_fragment';
const GAMMA22_OUTPUT =
	'gl_FragColor.rgb = pow(max(gl_FragColor.rgb, vec3(0.0)), vec3(1.0/2.2));';

/** A/B 开关（排查用）：`globalThis.__vbspOutputGamma22 === false` ⇒ 保留 three 的分段 sRGB。 */
function outputGamma22Enabled(): boolean {
	const g = globalThis as { __vbspOutputGamma22?: unknown };
	return g.__vbspOutputGamma22 !== false;
}

/**
 * 全局安装 γ2.2 输出编码：把 three 的 `colorspace_fragment` **块内容**整体换掉（幂等）。
 *
 * 为什么用**全局 ShaderChunk 覆盖**而不是逐材质 `onBeforeCompile`：
 * three 的 `Material.customProgramCacheKey()` 默认返回 `onBeforeCompile.toString()`
 * （`node_modules/three/src/materials/Material.js:107-113`）⇒ 给材质**新设**
 * `onBeforeCompile` 会新增程序缓存键 ⇒ 新增着色器程序 ⇒ 首次可见时多一次编译；
 * 而主线程 tick 的 `dt = min(帧间隔, 0.1)`（`renderer-main.ts:832`）会把这种卡顿
 * 放大成「慢动作」（传送点首次进入新区域时最明显）。覆盖 ShaderChunk 只改「块的文本」、
 * 不改任何缓存键 ⇒ **零新增程序**，且对全场材质（world lightmap / fullbright /
 * prop ambient / 诊断档）一致生效。背景是纯 Color、走 `gl.clearColor` 而非材质，不受影响。
 */
export function installGamma22Output(): void {
	if (!outputGamma22Enabled()) return;
	const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
	if (chunks[COLORSPACE_CHUNK_NAME] !== GAMMA22_OUTPUT) {
		chunks[COLORSPACE_CHUNK_NAME] = GAMMA22_OUTPUT;
	}
}

// 模块加载即安装（早于任何材质编译）
installGamma22Output();

// ---------------------------------------------------------------------------
// 自动化对照的「阶段开关」（仅出帧验证脚本使用；正常游玩不受影响）
// ---------------------------------------------------------------------------

/**
 * 出帧对照的阶段开关（由 scripts/lightmap-frame-capture.mjs 在导航前经
 * `Page.addScriptToEvaluateOnNewDocument` 注入 `window.__vbspLightmapStage`）：
 * - `auto`（默认/未设）：按本文件正常逻辑注入；
 * - `off`：**不注入** shader、也不换材质（负控：地图理应重新变黑）；
 * - `broken`：强制用旧的「拼接成一行」失配字面量去 replace（**根因负控**：证明
 *   「字面量失配 ⇒ 注入静默失效 ⇒ 画面变黑」这条因果链）；
 * - `native`：跳过自定义注入，保留 three 原生 lightmap 采样（亮度对照上界）。
 * 读取时用类型断言，缺失字段即视为 `auto`。
 */
export type LightmapStage =
	| 'auto'
	| 'off'
	| 'broken'
	| 'native'
	| 'channel0'
	| 'channel1'
	| 'noinject';

/** 全部合法 stage（读取端校验 + 统计端分类共用，避免两处清单漂移）。 */
const LIGHTMAP_STAGES: readonly LightmapStage[] = [
	'off',
	'broken',
	'native',
	'channel0',
	'channel1',
	'noinject',
];

/** 读取全局阶段开关（无 `window` 时视为 auto）。 */
export function readLightmapStage(): LightmapStage {
	const g = globalThis as { __vbspLightmapStage?: unknown };
	const v = g.__vbspLightmapStage;
	return typeof v === 'string' && (LIGHTMAP_STAGES as readonly string[]).includes(v)
		? (v as LightmapStage)
		: 'auto';
}

/** 供统计端分类复用（导出以便 renderer-main 判定 `native`/`noinject` 等跳过类语义）。 */
export function isLightmapSkipStage(stage: string): boolean {
	return stage === 'native' || stage === 'noinject';
}

/**
 * three 0.165.0 的 lightmap UV 通道**必须显式指定**。
 *
 * 依据（three 0.165.0 源码）：`WebGLPrograms.getParameters()` 里
 * `lightMapUv: getChannel( material.lightMap.channel )`，而
 * `getChannel(v) = v === 0 ? 'uv' : 'uv' + v`；
 * `Texture.channel` 的**默认值是 0** ⇒ 不显式设置时 `LIGHTMAP_UV === 'uv'`，
 * 即 **lightmap 会用漫反射 UV 采样**（错误的图集坐标）⇒ 采出来的是别处的
 * 纹素 → 表现为「黑 / 花 / 假亮」，而不是地图的真实明暗。
 *
 * GLB 契约里 lightmap 坐标写在 `TEXCOORD_1`（GLTFLoader r151+ 映射到 `uv1`），
 * 故正确取值是 `channel = 1`（⇒ `LIGHTMAP_UV === 'uv1'`）。
 * 本工程既有的「把 uv1 复制到 uv2」是 r151 **之前**的旧约定，与 `channel` 并存
 * 只会让真正的采样通道继续是 0。
 */
export const LIGHTMAP_UV_CHANNEL_CORRECT = 1;

/**
 * 解析本次运行应使用的 lightmap UV 通道。
 * `channel0` / `channel1` 两个 stage 是**负控/正控**开关（出帧对照用）：
 * - `channel0`（负控）：强制 0 = three 默认 = 用漫反射 uv 采样 ⇒ 预期画面变黑/花；
 * - `channel1`（正控）：强制 1 = 用 uv1 = lightmap 真坐标 ⇒ 预期画面出现真实明暗。
 * 其余 stage 取 `LIGHTMAP_UV_CHANNEL_CORRECT`。
 */
export function resolveLightmapUvChannel(): number {
	const stage = readLightmapStage();
	if (stage === 'channel0') return 0;
	if (stage === 'channel1') return 1;
	return LIGHTMAP_UV_CHANNEL_CORRECT;
}

/**
 * 旧的失配字面量（**故意保留**：根因证据 + `broken` 阶段负控用）。
 *
 * three 0.165.0 的 MeshBasicMaterial fragment 里那两行是**分行**的，中间夹着
 * 一个换行 + 两个制表符；此处把它拼成一行 ⇒ `String.prototype.replace` **命中 0 次**
 * ⇒ 静默失效。见 `injectLightmapShader` 里的命中数断言。
 */
const BASIC_INLINE_LIGHTMAP_SRC_LEGACY_MISMATCH =
	'vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );reflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;';

// ---------------------------------------------------------------------------
// Atlas 加载
// ---------------------------------------------------------------------------

/**
 * 从 glTF extras.lightmap.textureIndex 异步加载 lightmap atlas 纹理。
 * 约束：NoColorSpace + NearestFilter（保留 raw 字节，双线性在 shader 中做）。
 * @param parser GLTFParser（gltf.parser）。
 * @param gltf GLTF 解析结果（读取 asset/scene extras 中的 textureIndex）。
 * @returns atlas 纹理；无 lightmap extras 则返回 null。
 */
export async function loadLightmapAtlas(
	parser: GLTFParser,
	gltf: GLTF,
): Promise<THREE.Texture | null> {
	// textureIndex 可能在 asset.extras.lightmap 或 scene.userData.extras.lightmap
	const assetExtras = (gltf.asset?.extras ?? {}) as Record<string, unknown>;
	const sceneExtras = (gltf.scene?.userData?.extras ?? {}) as Record<string, unknown>;
	const assetLightmap = assetExtras.lightmap as { textureIndex?: number } | undefined;
	const sceneLightmap = sceneExtras.lightmap as { textureIndex?: number } | undefined;
	const textureIndex = assetLightmap?.textureIndex ?? sceneLightmap?.textureIndex;

	if (textureIndex === undefined || textureIndex === null || textureIndex < 0) {
		return null;
	}

	let texture: THREE.Texture;
	try {
		texture = await parser.loadTexture(textureIndex);
	} catch (err) {
		console.error('[lightmap-shader] 加载 atlas 纹理失败:', err);
		return null;
	}

	texture.name = '__vbsp_lightmap_atlas__';
	texture.colorSpace = THREE.NoColorSpace;
	texture.minFilter = THREE.NearestFilter;
	texture.magFilter = THREE.NearestFilter;
	texture.generateMipmaps = false;
	texture.needsUpdate = true;

	return texture;
}

// ── 光照模式（面板「预烘焙 / 纯纹理」）──────────────────────────────────────
/**
 * 光照模式：
 * - `baked`（预烘焙，默认）：世界面吃 lightmap atlas（VRAD 烘焙），prop 吃 `sp_<i>.vhv` 逐顶点烘焙 /
 *   leaf ambient cube。**纹理多**（atlas + 默认纹理包 + vhv 属性）⇒ 进图与首帧材质编译更吃时间。
 * - `texture`（纯纹理）：只上漫反射贴图（`MeshBasicMaterial` 原色），不加载 atlas、不吃任何烘焙光照。
 *   纹理更少、进图更快，但画面没有明暗关系（外部参照实现的 white 兜底口径）。
 *
 * 由面板切换（`renderer-main.setLightingMode` ⇒ 重新施加材质，无需重载地图）。
 */
export type LightingMode = 'baked' | 'texture';

/** 当前光照模式（模块级：`applyLightmapToMeshes` / `routeFullbright` 都读它）。 */
let lightingMode: LightingMode = 'baked';

/** 设置光照模式（切换后需重新施加材质才生效，见 `renderer-main.setLightingMode`）。 */
export function setLightingMode(mode: LightingMode): void {
	lightingMode = mode === 'texture' ? 'texture' : 'baked';
}

/** 当前光照模式。 */
export function getLightingMode(): LightingMode {
	return lightingMode;
}

/** 是否纯纹理模式（`baked` 之外的一切都按纯纹理处理）。 */
export function isTextureOnlyMode(): boolean {
	return lightingMode === 'texture';
}

// ---------------------------------------------------------------------------
// 应用 lightmap 到 mesh
// ---------------------------------------------------------------------------

/**
 * 对带 uv1/uv2 的 mesh 应用 lightmap atlas：
 * uv1 存在时复制到 uv2（lightMap slot 由 uv2 驱动），用 MeshBasicMaterial 替换原材质
 *（保留原 map/color），onBeforeCompile 注入解码 shader；无 lightmap UV 的 mesh 跳过。
 * `mesh.userData.hasLightmap === false` 的 mesh 也跳过（中性占位 UV，见文件头说明）。
 * @param scene Three.js 场景。
 * @param atlasTexture lightmap atlas 纹理（来自 loadLightmapAtlas）。
 * @returns 已应用 lightmap 的 mesh 数量。
 */
export function applyLightmapToMeshes(
	scene: THREE.Scene,
	atlasTexture: THREE.Texture | null,
): number {
	// 负控阶段 `off`：完全不施加 lightmap（不换材质、不注入）——
	// 用于出帧对照证明「黑屏确由 lightmap 缺失造成」。
	if (readLightmapStage() === 'off') {
		console.warn('[lightmap] stage=off（负控）：跳过 lightmap 施加，画面预期回到无烘焙光照状态');
		return 0;
	}
	// ⚠️ `off` **不可比**（连材质都不换 ⇒ 分块/draw 与其余帧不同）⇒ 它**不是**
	// "移除注入 ⇒ 应变暗"的正确负控；该负控由 `noinject` 承担（见下方注入处）。
	const isNoInjectStage = readLightmapStage() === 'noinject';

	// 纯纹理模式：**跳过 lightmap 分支**（atlas 为 null 也走这条），全部图元落到 fullbright 收敛点，
	// 且那里的逐顶点/ambient cube 烘焙在纯纹理模式下也被跳过 ⇒ 只剩漫反射贴图原色。
	const textureOnly = isTextureOnlyMode();

	const atlasW = (atlasTexture?.image?.width as number) || 0;
	const atlasH = (atlasTexture?.image?.height as number) || 0;
	const atlasSize = new THREE.Vector2(atlasW, atlasH);

	let applied = 0;
	// fullbright 统一路径计数：无 lightmap 图元换 Basic（贴图原色，外部参照实现 white 兜底口径）
	let fullbright = 0;

	// ── 材质去重（**性能关键**）──────────────────────────────────────────────
	// `optimizeScene` 的块内合并按**材质实例恒等**分组（renderer-main.ts:1232 的
	// `new Map<THREE.Material, …>`）⇒ 若每个 mesh 各拿一个新材质实例，合并完全失效：
	// 3.4 万 mesh 一个都并不到（draw call 估算 ~28k），而 apps/game **不换材质**
	// （其 renderer-main.ts 文件头即写明"无 lightmap"）⇒ 同材质 mesh 能并成 300~800 块
	// （draw ~1.5k）。本工程因此比 apps/game 卡。
	// 修法：把「参数完全相同」的新材质**复用同一实例**（同 map/color/transparent/opacity/
	// 诊断档位），让 optimizeScene 的按材质合并重新成立。
	//
	// 例外：带 ambient cube 的 prop —— cube 是**逐 prop 的 uniform**（`vbspAmbCube`），
	// 材质不可复用，必须逐 mesh（这类数量有限：surf_666 约 366~501 个）。
	const lightmappedCache = new Map<string, THREE.MeshBasicMaterial>();
	const fullbrightCache = new Map<string, THREE.MeshBasicMaterial>();
	/**
	 * 第 1 级（逐顶点预烘焙）材质的**共享**缓存。
	 * 属性 `_VBSP_VLIGHT` 在**几何**上（逐实例烘进顶点）⇒ 这类 mesh 可共用同一材质实例。
	 * ⚠️ 必须与 `fullbrightCache` 分开：让没有该属性的 mesh 共用它会把属性读成全 0 ⇒ 渲成黑。
	 */
	const vertexLightingCache = new Map<string, THREE.MeshBasicMaterial>();
	/** 走第 1 级（逐顶点烘焙）的 mesh 数（诊断口径）。 */
	let vertexLightingRouted = 0;
	/** 因「契约 §9.6.1：只有中性占位 UV」而改走 fullbright 的图元数（诊断口径）。 */
	let noLightmapRouted = 0;

	/**
	 * fullbright 唯一收敛点（三个入口共用：`hasLightmap===false` / 无 lightmap UV / 无 uv1&uv2）。
	 *
	 * **三级优先**（对齐 Source/外部参照实现的 prop 光照来源优先级）：
	 * 1. `extras.unlit`（VMT `UnlitGeneric` / `$selfillum`）⇒ 贴图原色，**不吃任何光照**；
	 * 2. 几何带 `_VBSP_VLIGHT`（**第 1 级**：VRAD 逐顶点预烘焙，`sp_<idx>.vhv`）
	 *    ⇒ 逐顶点光照，材质可**全场景共享**（属性在几何上，不需要逐 prop uniform）；
	 * 3. 否则回退 **第 2 级** leaf ambient cube（逐 prop uniform ⇒ 材质不可复用）；
	 *    无 cube 时走共享材质（保住 optimizeScene 的按材质合并）。
	 */
	const routeFullbright = (mesh: THREE.Mesh): void => {
		const unlit = isUnlit(mesh);
		// 纯纹理模式：**不吃任何烘焙光照**（第 1 级逐顶点、第 2 级 ambient cube 全部跳过）⇒ 只剩贴图原色。
		if (textureOnly) {
			mesh.material = acquireFullbrightMaterial(mesh);
			fullbright++;
			return;
		}
		if (!unlit && hasVertexLightingAttr(mesh) && !readVertexLightingOff()) {
			// 第 1 级：逐顶点预烘焙（属性在几何上 ⇒ 材质全场景共享）。
			// ⚠️ 必须**显式赋值**给 mesh：`acquire*` 只建/取缓存实例，不做赋值
			// （`applyFullbrightBasic` 才内部赋值）。漏赋值 ⇒ 该 mesh 仍持旧材质，
			// 随后被 `fullbrightUnlitLitMaterials` 终扫收敛成无光照的 Basic ⇒ 第 1 级静默失效。
			reconstructVertexLighting(mesh);
			mesh.material = acquireVertexLightingMaterial(mesh);
			vertexLightingRouted++;
			fullbright++;
			return;
		}
		const rawCube = unlit ? undefined : resolveAmbientCube(mesh);
		// 第 2 级：leaf ambient cube（逐 prop uniform ⇒ 材质不可复用）。量级补偿：
		// 外部参照实现的 prop 顶点色编码含一个 2×（`vVertexLighting = floor(enc) * 2/255`），
		// 本工程末端还有一次 γ2.2 编码 ⇒ 数据侧补 `2^2.2`（见 `PROP_CUBE_GAIN` 的推导）。
		const cube =
			Array.isArray(rawCube) && rawCube.length === 18
				? rawCube.map((v) => (typeof v === 'number' ? v * effectivePropCubeGain() : v))
				: rawCube;
		const usableCube = Array.isArray(cube) && cube.length === 18;
		applyAmbientCubeIfAny(
			mesh,
			usableCube ? applyFullbrightBasic(mesh) : acquireFullbrightMaterial(mesh),
		);
		fullbright++;
	};

	/** 几何是否带第 1 级逐顶点烘焙光照属性（`extras.vertexLighting=true` 的 mesh 才有）。 */
	const hasVertexLightingAttr = (mesh: THREE.Mesh): boolean => {
		const g = mesh.geometry as THREE.BufferGeometry | undefined;
		return !!g && !!g.getAttribute && !!g.getAttribute(VERTEX_LIGHTING_ATTR);
	};

	/** 已做过重建的几何（避免同一 geometry 被多次处理）。 */
	const reconstructedGeoms = new WeakSet<THREE.BufferGeometry>();
	/** 已做过方差压缩的**属性**（多 primitive 共享同一份缓冲 ⇒ 必须按属性去重）。 */
	const flattenedAttrs = new WeakSet<THREE.BufferAttribute>();
	/** 重建统计（诊断口径；模块级，供 `getVertexLightingRelaxStats()` 读出）。 */
	const relaxStats = vertexLightingRelaxStats;
	/** 每次装配重置统计（同一页面可多次加载地图）。 */
	vertexLightingRelaxStats.meshes = 0;
	vertexLightingRelaxStats.welded = 0;
	vertexLightingRelaxStats.relaxed = 0;
	vertexLightingRelaxStats.medianFixed = 0;
	vertexLightingRelaxStats.flattened = 0;
	vertexLightingRelaxStats.flattenSkipped = 0;
	vertexLightingRelaxStats.meanAbsDelta = 0;
	vertexLightingRelaxStats.maxAbsDelta = 0;
	vertexLightingRelaxStats.samples = 0;

	/**
	 * 第 1 级逐顶点光照的**几何侧重建设置**：接缝焊接 + Laplacian 松弛。
	 *
	 * 背景（实测，见 `scene-brightness-and-lights.md` §11）：`s1_ramp1b` 那种 2560×1196 的坡
	 * 只有 50~66 个三角形（最长边 p50 = **747**、max 1473 HU），烘焙值只在 238 个顶点上采样。
	 * 直接用顶点值做 Gouraud 插值 ⇒ 大三角形内部是大段线性渐变、三角形之间只有 C0 连续，
	 * 观感即"一块一块的色阶"。**烘焙数据本身是平滑的**：小三角形（≤163 HU）内 Δluma 仅 0.035。
	 *
	 * 三步（都不改 pakfile 数据，只改渲染用的几何属性；`propVertexRelax = 0` 时整体跳过）：
	 * 1. **接缝焊接**：位置相同且法线相同的顶点是同一个着色点（UV 接缝复制），
	 *    引擎按点烘焙本应给同一个值 ⇒ 取均值（实测 ramp_1 上平均只动 0.039，最大 0.24）。
	 * 2. **空间鲁棒滤波**（`propVertexRelax ≥ 1`，默认开）：与"同法线的 2 环空间邻域"的
	 *    中位数相差超过 0.10 的顶点，判为与邻域不一致并拉回中位数。实测 ramp_1：
	 *    36% 顶点被判不一致（v168=0.741 而近邻 0.124/0.205/0.165 这种），
	 *    近邻平均 |Δluma| 0.161 → 0.057（−65%），且未判不一致的顶点**一个都不动**。
	 *    观感上这正是"坡面一条条色带"的来源（用户实拍：游戏内同一坡是均匀的）。
	 * 3. **Laplacian 松弛**（`propVertexRelax ≥ 3`）：更"平"，但会整体偏离烘焙值，
	 *    属口味档（标定表见 `scene-brightness-and-lights.md` §11.3）。
	 */
	const reconstructVertexLighting = (mesh: THREE.Mesh): void => {
		const passes = Math.max(0, Math.floor(readPropVertexRelax()));
		if (passes <= 0) return;
		const g = mesh.geometry as THREE.BufferGeometry | undefined;
		if (!g || reconstructedGeoms.has(g)) return;
		const attr = g.getAttribute(VERTEX_LIGHTING_ATTR) as THREE.BufferAttribute | undefined;
		const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
		if (!attr || !pos || !attr.array) return;
		reconstructedGeoms.add(g);
		relaxStats.meshes++;
		const arr = attr.array as Float32Array;
		const n = Math.min(attr.count, pos.count);
		const before = arr.slice(0, n * 3);
		const lu = (i: number): number =>
			0.299 * arr[i * 3] + 0.587 * arr[i * 3 + 1] + 0.114 * arr[i * 3 + 2];

		// ① 接缝焊接：位置 + 法线都相同 ⇒ 同一着色点
		const nrm = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
		if (nrm) {
			const buckets = new Map<string, number[]>();
			for (let i = 0; i < n; i++) {
				const key =
					`${pos.getX(i).toFixed(2)},${pos.getY(i).toFixed(2)},${pos.getZ(i).toFixed(2)}` +
					`|${nrm.getX(i).toFixed(2)},${nrm.getY(i).toFixed(2)},${nrm.getZ(i).toFixed(2)}`;
				const b = buckets.get(key);
				if (b) b.push(i);
				else buckets.set(key, [i]);
			}
			for (const ids of buckets.values()) {
				if (ids.length < 2) continue;
				relaxStats.welded++;
				for (let c = 0; c < 3; c++) {
					let s = 0;
					for (const i of ids) s += arr[i * 3 + c];
					s /= ids.length;
					for (const i of ids) arr[i * 3 + c] = s;
				}
			}
		}

		// ② 空间鲁棒滤波：把**与空间邻域不一致**的顶点拉回邻域中位数。
		// 依据（`s1_ramp1b` 实测，数据侧）：36% 的顶点与"同法线的空间近邻"相差 >0.12
		// （极端的如 v168=0.741 而近邻 0.124/0.205/0.165），近邻平均 |Δluma| 0.161 → 0.057。
		// 观感上这正是"坡面一条条色带"的来源（用户实拍：游戏内同一坡是均匀的）。
		// 邻域用**索引图 2 环**（O(E)，不做事先的空间哈希），要求法线同向（dot > 0.9），
		// 且只有当偏差超过阈值才替换 ⇒ 真实的明暗梯度不会被抹平。
		const index = g.getIndex();
		const ring: number[][] = Array.from({ length: n }, () => []);
		const link = (a: number, b: number): void => {
			if (a === b || a < 0 || b < 0 || a >= n || b >= n) return;
			ring[a].push(b);
			ring[b].push(a);
		};
		if (index) {
			for (let t = 0; t + 2 < index.count; t += 3) {
				const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
				link(a, b); link(b, c); link(c, a);
			}
		} else {
			for (let t = 0; t + 2 < n; t += 3) {
				link(t, t + 1); link(t + 1, t + 2); link(t + 2, t);
			}
		}
		// 2 环邻域（去重）
		const twoRing: number[][] = ring.map((r) => {
			const s = new Set<number>(r);
			for (const j of r) for (const k of ring[j]) s.add(k);
			s.delete(-1);
			return [...s];
		});
		const MEDIAN_THRESHOLD = 0.1; // 亮度单位（0~2 量纲），超过才认为该顶点不可信
		const medianOf = (ids: number[], c: number): number => {
			const s: number[] = [];
			for (const j of ids) {
				if (nrm && dotNormal(i0, j) < 0.9) continue;
				s.push(arr[j * 3 + c]);
			}
			if (!s.length) return NaN;
			s.sort((x, y) => x - y);
			return s[s.length >> 1];
		};
		function dotNormal(a: number, b: number): number {
			if (!nrm) return 1;
			return nrm.getX(a) * nrm.getX(b) + nrm.getY(a) * nrm.getY(b) + nrm.getZ(a) * nrm.getZ(b);
		}
		let i0 = 0;
		let fixed = 0;
		const snapshot = arr.slice(0, n * 3);
		for (i0 = 0; i0 < n; i0++) {
			const ids = twoRing[i0];
			if (!ids.length) continue;
			const cur = 0.299 * snapshot[i0 * 3] + 0.587 * snapshot[i0 * 3 + 1] + 0.114 * snapshot[i0 * 3 + 2];
			const med = [0, 1, 2].map((c) => medianOf(ids, c));
			if (med.some((v) => Number.isNaN(v))) continue;
			const medLuma = 0.299 * med[0] + 0.587 * med[1] + 0.114 * med[2];
			if (Math.abs(cur - medLuma) <= MEDIAN_THRESHOLD) continue;
			for (let c = 0; c < 3; c++) arr[i0 * 3 + c] = med[c];
			fixed++;
		}
		relaxStats.medianFixed += fixed;

		// ③ propVertexRelax ≥ 3 时再叠加 Laplacian 松弛（更"平"，但会偏离烘焙值）
		if (passes >= 3) {			const W = 0.5;
			const next = new Float32Array(arr.length);
			for (let pass = 0; pass < passes - 2; pass++) {
				next.set(arr.subarray(0, n * 3));
				for (let i = 0; i < n; i++) {
					const nb = ring[i];
					if (!nb.length) continue;
					for (let c = 0; c < 3; c++) {
						let s = 0;
						for (const j of nb) s += arr[j * 3 + c];
						next[i * 3 + c] = (1 - W) * arr[i * 3 + c] + W * (s / nb.length);
					}
				}
				arr.set(next.subarray(0, n * 3));
				relaxStats.relaxed++;
			}
		}

		attr.needsUpdate = true;
		relaxStats.samples += n;
		for (let i = 0; i < n; i++) {
			const d = Math.abs(lu(i) - (0.299 * before[i * 3] + 0.587 * before[i * 3 + 1] + 0.114 * before[i * 3 + 2]));
			relaxStats.meanAbsDelta += d;
			if (d > relaxStats.maxAbsDelta) relaxStats.maxAbsDelta = d;
		}
		// 与原始烘焙值的平均偏移（诊断；同时是"这份重建偏离数据多少"的可核对数字）
		relaxStats.meanAbsDelta /= n;

		// ④ 向**本 prop 的面积加权均值**收敛（`propVertexFlatten`，0..1）。
		//
		// 依据（2026-09-20 与用户游戏内实拍同靶标的像素量测，见
		// `scene-brightness-and-lights.md` §11）：
		//   · 坡面**均值**已经吻合：我们 #5c493e / 亮度 77.6，游戏 #5b4e40 / 亮度 80；
		//   · 但**方差**差一个量级：我们 p10..p90 = 26..123，游戏实拍点仅 74..82（±5%）。
		//   即：逐顶点场整体"量级对、分布错" ⇒ 观感是"一块一块的色阶"。
		// 本步把场写成 `mean + (1-flatten)×(v-mean)`：均值严格不变，只有方差被压。
		// flatten=1 等价于"该 prop 均匀受光"（游戏实拍就是这个观感）。
		const flattenRaw = readPropVertexFlatten();
		const flatten = Number.isFinite(flattenRaw) ? Math.min(1, Math.max(0, flattenRaw)) : 0;
		if (flatten > 0 && !flattenedAttrs.has(attr)) {
			// ⚠️ **按 prop 自适应**（2026-09-20 修正）：全局压方差会打到 92% 的正常 prop
			// （实测：436/473 个 prop 的屏幕域改变 >20%，`kr_stairs` 甚至 171~387%）——
			// 用户口径"预烘焙出问题了"就是它。
			// 判据用**面内**亮度差（绝对值，中位数）：面内三点本该接近；
			//   · `s1_ramp1b`（条纹型，问题坡）= 0.233 ⇒ 压平
			//   · `kr_stairs`（面间差异大但面内一致，正常）= 0.023 ⇒ 不压
			//   · `s1_roof`（跨度 0.56 但面内 0.000，正常）= 0.000 ⇒ 不压
			// ⚠️ 判别必须在**原始烘焙值**上做：本函数第②步的鲁棒滤波会先把离群顶点拉回
			// 邻域中位数，若在它之后判别，条纹型 prop（正是要修的那类）会被误判为"面内一致"
			// ⇒ 实测坡面又回到 70/123（未被压平）。
			let medianTri = 0;
			if (index) {
				const triDelta: number[] = [];
				for (let t = 0; t + 2 < index.count; t += 3) {
					const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
					if (a >= n || b >= n || c >= n) continue;
					const la = 0.299 * before[a * 3] + 0.587 * before[a * 3 + 1] + 0.114 * before[a * 3 + 2];
					const lb = 0.299 * before[b * 3] + 0.587 * before[b * 3 + 1] + 0.114 * before[b * 3 + 2];
					const lc = 0.299 * before[c * 3] + 0.587 * before[c * 3 + 1] + 0.114 * before[c * 3 + 2];
					triDelta.push(Math.max(la, lb, lc) - Math.min(la, lb, lc));
				}
				if (triDelta.length) {
					triDelta.sort((x, y) => x - y);
					medianTri = triDelta[triDelta.length >> 1];
				}
			}
			if (medianTri < PROP_FLATTEN_MIN_TRI_DELTA) {
				relaxStats.flattenSkipped++; // 面内本来就一致 ⇒ 保留原样烘焙值
			} else {
				// 按**属性**去重：glTF 多 primitive 共享同一份顶点缓冲（三个材质三条索引），
				// 若按 geometry 去重会跑 3 次、每次用自己的索引范围均值 ⇒ **最后写入者获胜**
				// （实测把坡面拽到别的块的均值上：亮度 77.6 → 43.6）。
				// 取均值也必须用**整份缓冲**（= 该 prop 实例的整个模型），才是"该道具一个值"。
				flattenedAttrs.add(attr);
				const sum = [0, 0, 0];
				for (let i = 0; i < n; i++) for (let ch = 0; ch < 3; ch++) sum[ch] += arr[i * 3 + ch];
				const mean = sum.map((s) => s / n);
				for (let i = 0; i < n; i++) {
					for (let ch = 0; ch < 3; ch++) {
						arr[i * 3 + ch] = mean[ch] + (1 - flatten) * (arr[i * 3 + ch] - mean[ch]);
					}
				}
				relaxStats.flattened++;
			}
		}
	};

	/**
	 * 第 1 级（逐顶点烘焙）材质的**共享**缓存：属性在几何上 ⇒ 所有这类 mesh 共用同一个材质，
	 * 既能保住 `optimizeScene` 的按材质合并，也避免逐 prop 材质实例爆炸。
	 * ⚠️ 必须与 `fullbrightCache` 分开：没有该属性的 mesh 共用它会让属性读成全 0（渲染成黑）。
	 */
	const acquireVertexLightingMaterial = (mesh: THREE.Mesh): THREE.MeshBasicMaterial => {
		const origMat = mesh.material as THREE.Material | THREE.Material[];
		const firstOrig = Array.isArray(origMat) ? origMat[0] : origMat;
		const origBasic = firstOrig as THREE.MeshBasicMaterial;
		const origMap = (origBasic as unknown as { map?: THREE.Texture | null }).map ?? null;
		const origColor =
			(origBasic as unknown as { color?: THREE.Color }).color?.clone() ??
			new THREE.Color(0xffffff);
		const transparent = (firstOrig as THREE.Material).transparent ?? false;
		const opacity = (firstOrig as THREE.Material).opacity ?? 1;
		const key = [
			origMap ? origMap.uuid : '-',
			origColor.getHexString(),
			transparent ? '1' : '0',
			String(opacity),
			// alpha 相关状态必须进键：否则仅 alphaTest/side 不同的材质会共用同一个替换材质
			String((firstOrig as THREE.Material & { alphaTest?: number }).alphaTest ?? 0),
			String((firstOrig as THREE.Material & { side?: number }).side ?? 0),
			String((firstOrig as THREE.Material & { depthWrite?: boolean }).depthWrite ?? true),
			(firstOrig as THREE.Material & { alphaMap?: THREE.Texture | null }).alphaMap
				? ((firstOrig as THREE.Material & { alphaMap?: THREE.Texture | null }).alphaMap as THREE.Texture).uuid
				: '-',
			// `Wireframe` 着色器标记也必须进键（线框与实体面不能共用同一替换材质）
			(firstOrig.userData as { vbsp_wireframe?: boolean } | undefined)?.vbsp_wireframe ? 'wf' : '-',
		].join('|');
		let mat = vertexLightingCache.get(key);
		if (!mat) {
			mat = new THREE.MeshBasicMaterial({ map: origMap, color: origColor });
			copyMaterialRenderState(firstOrig, mat); // 含 alphaTest/alphaMap/side/depthWrite/blending/unlit
			applyVertexLightingShader(mat);
			vertexLightingCache.set(key, mat);
		}
		return mat;
	};

	/** GLB `material.extras.unlit`（VMT 的 UnlitGeneric / `$selfillum`）⇒ 走**全亮**，不吃任何光照。 */
	const isUnlit = (mesh: THREE.Mesh): boolean => {
		const m = mesh.material as THREE.Material | THREE.Material[];
		const first = Array.isArray(m) ? m[0] : m;
		return (first?.userData as { unlit?: unknown } | undefined)?.unlit === true;
	};

	/** 无 lightmap 图元的**共享**材质（按原材质参数去重；带 cube 的 prop 不走这里）。 */
	const acquireFullbrightMaterial = (mesh: THREE.Mesh): THREE.MeshBasicMaterial => {
	const origMat = mesh.material as THREE.Material | THREE.Material[];
	const firstOrig = Array.isArray(origMat) ? origMat[0] : origMat;
	const origBasic = firstOrig as THREE.MeshBasicMaterial;
	const origMap = (origBasic as unknown as { map?: THREE.Texture | null }).map ?? null;
	const origColor =
		(origBasic as unknown as { color?: THREE.Color }).color?.clone() ?? new THREE.Color(0xffffff);
	const transparent = (firstOrig as THREE.Material).transparent ?? false;
	const opacity = (firstOrig as THREE.Material).opacity ?? 1;
	const key = [
		origMap ? origMap.uuid : '-',
		origColor.getHexString(),
		transparent ? '1' : '0',
		String(opacity),
		// alpha 相关状态必须进键（同 vertexLightingCache 的理由）
		String((firstOrig as THREE.Material & { alphaTest?: number }).alphaTest ?? 0),
		String((firstOrig as THREE.Material & { side?: number }).side ?? 0),
		String((firstOrig as THREE.Material & { depthWrite?: boolean }).depthWrite ?? true),
		(firstOrig.userData as { vbsp_wireframe?: boolean } | undefined)?.vbsp_wireframe ? 'wf' : '-',
	].join('|');
	let mat = fullbrightCache.get(key);
	if (!mat) {
		mat = new THREE.MeshBasicMaterial({ map: origMap, color: origColor });
		copyMaterialRenderState(firstOrig, mat); // 含 alphaTest/alphaMap/side/depthWrite/blending/unlit
		fullbrightCache.set(key, mat);
	}
	return mat;
	};

	scene.traverse((obj) => {
		if (!(obj as THREE.Mesh).isMesh) return;
		const mesh = obj as THREE.Mesh;
		const geom = mesh.geometry as THREE.BufferGeometry;
		if (!geom) return;

		// 契约 §9.6.1：hasLightmap === false 表示该图元只有中性占位 UV，不得施加。
		//
		// ⚠️ **判据必须从 `geometry.userData` 读，不能只读 `mesh.userData`** ✓：
		// GLTFLoader 对 **primitive** 的 extras 走 `assignExtrasToUserData( geometry, primitiveDef )`
		// （`three/examples/jsm/loaders/GLTFLoader.js:4710`）⇒ `extras.hasLightmap` 落在
		// **geometry.userData** 上；mesh 级 extras 只有 meshDef 的 extras（本 GLB 没有）。
		// 此前只读 `mesh.userData.hasLightmap` ⇒ 恒为 `undefined` ⇒ **该防护从未生效**
		// （实测 `hasLightmapMissing=9289` 全部缺失、`True/False=0`；而 GLB 里实际
		// `hasLightmap=true` 33716 个、`false` 440 个）⇒ 中性占位 UV 的图元被错误施加 lightmap。
		// 两处都读（geometry 优先）以兼容不同加载路径/未来写法。
		const hlGeom = (geom.userData as { hasLightmap?: unknown } | undefined)?.hasLightmap;
		const hlMesh = (mesh.userData as { hasLightmap?: unknown }).hasLightmap;
		const hasLightmap = hlGeom !== undefined ? hlGeom : hlMesh;
		if (textureOnly || hasLightmap === false || hasLightmap === undefined) {
			// 占位 UV 面（契约 §9.6.1）⇒ 外部参照实现口径：white 兜底 = 贴图原色 fullbright
			// prop 图元带 node extras.ambientCube（leaf ambient cube，见 vbsp::prop_ambient_cube）
			// ⇒ 在 fullbright 基础上用法线加权混合 6 面 cube（外部参照实现 StudioModel 同语义）
			// ⚠️ ambient cube 是**逐 prop 的 uniform**（`vbspAmbCube`）⇒ 有 cube 的 prop 材质
			// 必须逐 mesh（不可复用）；无 cube 才能用共享材质，否则 optimizeScene 合并不成立。
			// 自发光/无光照材质（extras.unlit）**不吃环境光**：跳过 ambient 相乘 ⇒ 全亮贴图原色
			//
			// ⚠️ **`hasLightmap === false` 必须在「检测 uv1 / uv2」之前判**（2026-09-20 回归）：
			// `bsp_to_gltf_core/convert.rs:1004-1014` 对 `lightmap_region == None`（`light_offset == -1`，
			// 见 `lightmap.rs:326`）的面**照样写 `TEXCOORD_1`**，但每个顶点的值是**中性常量 (0,0)**
			// （只为保住 `mergeGeometries(geoms, true)` 的属性集一致）。实测 surf_666：这类图元
			// **440 个**（`dev/dev_water2` 176、`dev/dev_waterbeneath2` 175、`watersource/*` 42、
			// `dev_nyro/blends/wire_white` 8、`metal/citadel_tilefloor016a` 15 等），且**全部带 uv1**
			// ⇒ 原先只写在「无 uv1」分支里的防护**一次都没命中**，这些面全部以 uv=(0,0) 采图集
			// **同一个像素** ⇒ 整面塌成图集原点那一色（实机表现：「亮面发黑」）。
			// ⚠️ 判据必须从 `geometry.userData` 读，不能只读 `mesh.userData` ✓：
			// GLTFLoader 对 **primitive** 的 extras 走 `assignExtrasToUserData( geometry, primitiveDef )`
			// （`three/examples/jsm/loaders/GLTFLoader.js:4710`）⇒ `extras.hasLightmap` 落在
			// **geometry.userData** 上；mesh 级 extras 只有 meshDef 的 extras（本 GLB 没有）。
			// 此前只读 `mesh.userData.hasLightmap` ⇒ 恒为 `undefined` ⇒ **该防护从未生效**
			// （实测 `hasLightmapMissing=9289` 全部缺失、`True/False=0`；而 GLB 里实际
			// `hasLightmap=true` 33716 个、`false` 440 个）⇒ 中性占位 UV 的图元被错误施加 lightmap。
			// 两处都读（geometry 优先）以兼容不同加载路径/未来写法。
			noLightmapRouted++;
			routeFullbright(mesh);
			return;
		}

		// 检测 uv1 / uv2
		const hasUv1 = !!geom.getAttribute('uv1');
		const hasUv2 = !!geom.getAttribute('uv2');
		if (!hasUv1 && !hasUv2) {
			// 无 lightmap UV ⇒ 同上，fullbright 贴图原色（不吃三点光、不吃环境光）
			noLightmapRouted++;
			routeFullbright(mesh);
			return;
		}

		// UV 通道：**不再复制 uv1 → uv2**。
		//
		// 原写法 `geom.setAttribute('uv2', geom.getAttribute('uv1'))`（注释称 "r151+ lightMap slot
		// 由 uv2 驱动"）有两个问题：
		// 1. **多余**：three r151+ 的 lightMap UV 由 `material.lightMap.channel` 决定
		//    （`getChannel(0)='uv'`、`getChannel(1)='uv1'`），不是写死的 `uv2` ⇒ 只要把
		//    `atlasTexture.channel` 设为 1，就直接读 `uv1`，无需 `uv2`（见 loadLightmapAtlas）；
		//    实测本 GLB 的图元本来 `uv1`+`uv2` 都有（`bothUv=9036`，`uv1Only=0`）⇒ 复制从不生效。
		// 2. **有害**：`setAttribute` 传入的是**同一个 BufferAttribute 实例** ⇒ 凭空多出一份
		//    顶点属性占位，在 optimizeScene 合并几何 / computeBoundingSphere 等路径徒增负担。

		// 保留原材质的 map / color / transparent / opacity 等
		const origMat = mesh.material as THREE.Material | THREE.Material[];
		const firstOrig = Array.isArray(origMat) ? origMat[0] : origMat;
		const origBasic = firstOrig as THREE.MeshBasicMaterial;
		// 诊断开关（出帧脚本 `--debug-lightmap`）：去掉 albedo（map=null + color=white），
		// 只输出 lightmap 项本身 ⇒ 用于判定「画面暗是烘焙数据暗，还是 albedo/管线暗」。
		const debugLightmapOnly = readDebugLightmapOnly();
		const origMap = debugLightmapOnly
			? null
			: ((origBasic as unknown as { map?: THREE.Texture | null }).map ?? null);
		const origColor =
			(origBasic as unknown as { color?: THREE.Color }).color?.clone() ??
			new THREE.Color(0xffffff);
		const origTransparent = (firstOrig as THREE.Material).transparent ?? false;
		const origOpacity = (firstOrig as THREE.Material).opacity ?? 1;

		if (origMap && readDebugTexLinear()) {
			// 诊断：断言贴图像素已是线性 ⇒ 不再让 three 做 sRGB→linear 解码
			origMap.colorSpace = THREE.LinearSRGBColorSpace;
		}

		// ── 材质去重（见函数上方 lightmappedCache 注释）──
		// 键必须覆盖「会改变材质或注入结果」的全部输入：map / color / transparent /
		// opacity / 两个诊断档位。
		const matKey = [
			origMap ? origMap.uuid : '-',
			debugLightmapOnly ? '#ffffff' : origColor.getHexString(),
			origTransparent ? '1' : '0',
			String(origOpacity),
			// alpha 相关状态必须进键（world 侧也有 $alphatest 格栅 / $translucent 玻璃）
			String((firstOrig as THREE.Material & { alphaTest?: number }).alphaTest ?? 0),
			String((firstOrig as THREE.Material & { side?: number }).side ?? 0),
			String((firstOrig as THREE.Material & { depthWrite?: boolean }).depthWrite ?? true),
			// `Wireframe` 着色器标记（world 侧也有：`dev_nyro/blends/wire_white` 8 个面）
			(firstOrig.userData as { vbsp_wireframe?: boolean } | undefined)?.vbsp_wireframe ? 'wf' : '-',
			debugLightmapOnly ? 'lmonly' : 'map',
			isNoInjectStage ? 'noinject' : readDebugAlbedoOnly() ? 'albonly' : 'inject',
		].join('|');
		let newMat = lightmappedCache.get(matKey);
		if (!newMat) {
			newMat = new THREE.MeshBasicMaterial({
				map: origMap,
				color: debugLightmapOnly ? new THREE.Color(0xffffff) : origColor,
				lightMap: readDebugAlbedoOnly() ? null : atlasTexture,
				lightMapIntensity: 1,
			});
			newMat.transparent = origTransparent;
			newMat.opacity = origOpacity;
			// 世界图元同样必须继承 alpha 相关状态（`$alphatest` 的格栅/铁丝网、
			// `$translucent` 的玻璃都在 world 侧有实例）
			copyMaterialRenderState(firstOrig, newMat);
			// 注入 RGBExp32 解码着色器（**只在新建材质时执行一次**；共享实例复用注入结果）。
			//
			// **可比负控 `noinject`**：保留上方**全部材质替换**（`lightMap` 槽、`channel` 设置、
			// 透明/颜色继承都照做 ⇒ `optimizeScene` 的合并形态与 `auto` **完全相同**），
			// **仅跳过 shader 注入**。这样画面差异**只**来自"注入是否生效"这一个变量。
			//
			// 为什么需要它：原 `off` 阶段**提前 return**、连材质都不换 ⇒ 场景构成与其余帧
			// 不同（实测 `meshes` 1162 vs 9289、draw 1493 vs 28757）⇒ **与原帧不可比** ✗，
			// 不能充当"移除注入 ⇒ 应变暗"的负控。`noinject` 才是该负控的正确形态。
			if (!isNoInjectStage && !readDebugAlbedoOnly()) {
				injectLightmapShader(newMat, atlasSize);
			}
			lightmappedCache.set(matKey, newMat);
		}

		// lightmap UV 通道：不显式设置就是 three 默认的 0 = 用漫反射 uv 采样（见
		// resolveLightmapUvChannel 注释）。GLB 的 lightmap 坐标在 TEXCOORD_1。
		//
		// ⚠️ 不得在此处无条件回写 `newMat.lightMap = atlasTexture;`：
		// 构造器里的 `lightMap: readDebugAlbedoOnly() ? null : atlasTexture` 是**唯一真源**。
		// 历史缺陷（交接文档 §3「有效 lightmap 系数 ≈ 1.0」的根因）：这里曾无条件覆盖，
		// 使 `--debug-albedo` 的 null 失效 ⇒ 该帧实际走 three 原生 lightmap 分支
		// （`lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI`，采到的是**未解码的
		// RGBExp32 尾数字节**，不是 albedo-only）⇒ `temp/factor-decompose.mjs` 的分母被压暗
		// π/m ≈ 6.8×（线性）⇒ 量出「有效系数 1.058」的假象。该帧与 `--stage noinject`
		// 在构造上等价（同为原生分支、同样跳过注入），故二者逐桶一致从来不是负控证据。
		// 纯纹理模式 / 无 atlas 时这里根本不会走到（上方已提前 routeFullbright）。
		atlasTexture!.channel = resolveLightmapUvChannel();

		mesh.material = newMat;
		applied++;
	});

	// ── 兜底：未被上面任何分支接管的图元不得保留原材质（2026-09-20 第二轮回归）──
	//
	// 上面三条分支覆盖的是 `hasLightmap === false` / `=== true`（且带 uv1）/ 无 uv1&uv2。
	// 但 GLB 里还有一类：`extras.hasLightmap` **完全缺失**（`undefined`）**且带 uv1** ——
	// 例如从 prop 模型导出的自发光霓虹（`extras.unlit=true`）与部分无贴图的派生网格。
	// 它们会从三个分支**全部漏下去**，原样保留 GLTFLoader 给的 `MeshStandardMaterial`。
	// 而本工程**不加任何灯**（三点光与 2000+ 盏 punctual 灯都被刻意中和，见
	// `scene-brightness-and-lights.md` §2）⇒ `MeshStandardMaterial` 在没有灯/环境贴图时
	// 只剩 `emissive`（GLB 里是 `[0,0,0]`）⇒ **恒渲染成纯黑**。
	// 实测 surf_666：这类图元 47 个 `unlit=true`（`blue_neon`×8、`neon666_01_krazyneon`×18、
	// `glow_red_001`×5、`glow_yellow_008`×5…，共 16211 顶点）+ 64 个无贴图网格。
	// 修法：与既有 fullbright 口径一致 —— 换成 Basic 贴图原色（unlit 的不吃 ambient cube）。
	let fallbackRouted = 0;
	scene.traverse((obj) => {
		if (!(obj as THREE.Mesh).isMesh) return;
		const mesh = obj as THREE.Mesh;
		const m = mesh.material as THREE.Material | THREE.Material[];
		const first = Array.isArray(m) ? m[0] : m;
		if (!first) return;
		// 已被本函数换过的（Basic）不再处理
		if ((first as THREE.Material).type === 'MeshBasicMaterial') return;
		fallbackRouted++;
		routeFullbright(mesh);
	});

	if (fullbright > 0) {
		console.info(
			`[lightmap] fullbright（无 lightmap 图元统一贴图原色，外部参照实现 white 兜底口径）mesh=${fullbright}` +
				`；其中 hasLightmap=false（中性占位 UV，必须跳过 lightmap 注入）=${noLightmapRouted}` +
				`；第 1 级逐顶点预烘焙（sp_<i>.vhv → _VBSP_VLIGHT）=${vertexLightingRouted}` +
				`；漏网兜底（非 Basic 原材质，含 unlit prop）=${fallbackRouted}`,
		);
	}

	return applied;
}

/**
 * 装配后终扫：把**任何**仍带受光材质（`MeshStandardMaterial` 等）的 mesh 收敛到 fullbright。
 *
 * 为什么必须有这一层（2026-09-20 第二轮实测）：`applyLightmapToMeshes` 的三条分支 + 其内部兜底
 * 跑在「GLB 刚挂载」这一刻；而 GLTFLoader 对 **prop 模型**（`extras.unlit=true` 的霓虹/发光）与
 * 部分派生网格给的 `MeshStandardMaterial` 在该时刻取不到可用的 `hasLightmap`/UV 判据，
 * 会整批漏过。本工程**刻意不加任何灯**（三点光 + 2000+ 盏 punctual 灯全部中和，见
 * `scene-brightness-and-lights.md` §2）⇒ 这些材质只剩 `emissive`（GLB 里是 `[0,0,0]`）
 * ⇒ **恒渲染成纯黑**：实测 surf_666 有 122 个图元（47 个 `unlit=true` 的自发光 prop：
 * `blue_neon`×8 / `neon666_01_krazyneon_00041v`×18 / `glow_red_001`×5 / `glow_yellow_008`×5 /
 * `purple_dev_neon`×4 / `blue_dev_neon`×4 / `69_red01` / `tree_deciduous_01a_branches`×2，
 * 外加 75 个水系/线框/派生网格）。
 *
 * 口径与 `applyLightmapToMeshes` 的 fullbright 路径一致：保留原 `map`/`color`/`transparent`/`opacity`，
 * `extras.unlit` 的图元不吃 ambient cube（Source `UnlitGeneric` 语义），其余按需乘 cube。
 *
 * @returns 被收敛的 mesh 数（0 = 无需处理）。
 */
export function fullbrightUnlitLitMaterials(scene: THREE.Scene): number {
	let converted = 0;
	scene.traverse((obj) => {
		const mesh = obj as THREE.Mesh;
		if (!mesh.isMesh) return;
		const cur = mesh.material as THREE.Material | THREE.Material[];
		const list = Array.isArray(cur) ? cur : [cur];
		let touched = false;
		const next = list.map((m) => {
			if (!m || m.type === 'MeshBasicMaterial') return m;
			const src = m as THREE.MeshBasicMaterial;
			const basic = new THREE.MeshBasicMaterial({
				map: (src as unknown as { map?: THREE.Texture | null }).map ?? null,
				color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
			});
			basic.name = m.name;
			// 必须走统一的 `copyMaterialRenderState`：这里此前手抄 `userData/transparent/opacity`，
			// 于是 `side`/`depthWrite`/`alphaTest`/**`extras.vbsp_wireframe`** 全部丢失。
			// 实测（2026-09-20）：`dev_nyro/blends/wire_white`（Source `Wireframe` 着色器，8 个世界面、
			// 单面 768×512×768）正落在这一层 —— 材质带 `userData.vbsp_wireframe=true` 却仍 `wireframe=false`，
			// 画面是一面实心墙。
			copyMaterialRenderState(m, basic);
			touched = true;
			return basic;
		});
		if (!touched) return;
		mesh.material = Array.isArray(cur) ? next : next[0];
		converted++;
	});
	return converted;
}

/**
 * 在 MeshBasicMaterial.onBeforeCompile 注入 RGBExp32 解码 + 手动双线性 shader：
 * main 前插入两个函数、添加 uniform vbsp_AtlasSize、替换内联 lightmap 采样
 * 为 vbsp_ApplyLightmap，并防御性兼容 lightmap_fragment chunk。
 *
 * **不再静默**：两处 `replace` 各自统计命中数，并把结果写进
 * `material.__vbspLightmapInject`；命中为 0 时 `console.error` 明确报出——
 * 这正是本批缺陷的根因形态（字面量失配 → 注入静默失效 → 画面变黑，
 * 此前只打「[lightmap] 施加 mesh=N」的成功日志，完全看不出注入没生效）。
 */
function injectLightmapShader(
	material: THREE.MeshBasicMaterial,
	atlasSize: THREE.Vector2,
): void {
	// uniform 值需每次重编译重新设置（Three.js 不自动保留自定义 uniform）
	const uniformValue = { value: atlasSize.clone() };
	material.onBeforeCompile = (shader) => {
		shader.uniforms.vbsp_AtlasSize = uniformValue;
		shader.uniforms.vbspExposure = exposureUniform;
		shader.uniforms.vbspLightGamma = lightGammaUniform;
		shader.uniforms.vbspLightFloor = lightFloorUniform;
		(material as unknown as { __vbspLightmapUniformBound?: boolean }).__vbspLightmapUniformBound =
			true;

		const frag = shader.fragmentShader;
		const stage = readLightmapStage();

		// `native`：不替换任何东西，让 three 原生 lightmap 路径生效。
		//
		// ⚠️ **这不是"亮度上界"对照** ✗：`native` 同样经由 `lightMap.channel` 决定 UV
		// （`LIGHTMAP_UV = getChannel(lightMap.channel)`），`channel` 未修时它同样采错通道。
		// 且 `atlasTexture` 是同一对象 ⇒ `channel = 1` 落地后对 native 一并生效。
		// ⇒ 正确标签是「原生路径对照，同样受 `channel` 影响」；只有 `auto` 才是修复证据。
		if (stage === 'native') {
			// `applied: null`：**刻意不是 `false`** —— native 按设计"跳过注入"，
			// 既非成功也非失败。若留 undefined，下游 `if (rec.applied) … else 记为失效`
			// 会把 undefined 误判成"注入失效"并打假 error（实测已发生）。
			(material as unknown as { __vbspLightmapInject?: unknown }).__vbspLightmapInject = {
				stage,
				inlineHits: 0,
				chunkHits: 0,
				changed: false,
				applied: null,
				skipped: true,
				note: 'native 阶段：跳过自定义注入，保留 three 原生 lightmap 采样',
			};
			return;
		}

		// `broken`：故意用旧的**失配字面量**（拼成一行）→ 预期命中 0（根因负控）
		const inlineSrc =
			stage === 'broken' ? BASIC_INLINE_LIGHTMAP_SRC_LEGACY_MISMATCH : BASIC_INLINE_LIGHTMAP_SRC;

		// 命中数统计：**真计数**（`split().length - 1`），与 `replace` 同语义。
		// 不能用 `includes() ? 1 : 0`（布尔伪装成计数 ⇒ 恒 ≤ 1；three 若 emit 两份内联块，
		// 真值为 2 而旧写法只报 1 ⇒ 计数失真）。
		// 必须在 replace **之前**数原文（replace 只替换第一处，故命中数即"原文出现次数"）。
		const before = frag;
		const inlineHits = frag.split(inlineSrc).length - 1;
		const chunkHits = frag.split(CHUNK_LIGHTMAP_INCLUDE).length - 1;

		// 插入函数定义（在 void main 之前）
		const injected = VBSP_DECOMPRESS_LIGHTMAP_SAMPLE + '\n' + VBSP_APPLY_LIGHTMAP + '\n';

		// 先替换内联 lightmap 块（MeshBasicMaterial 实际路径）
		let updated = frag.replace(inlineSrc, BASIC_INLINE_LIGHTMAP_REPLACEMENT);
		// 兼容 chunk include 路径（防御性）
		updated = updated.replace(CHUNK_LIGHTMAP_INCLUDE, CHUNK_LIGHTMAP_REPLACEMENT);

		const changed = updated !== before;
		// 注入是否真的进了 shader —— **两条通道取或**，且文本确实变了：
		// - 只看内联通道会误报：three 若改走 `#include <lightmap_fragment>`（inlineHits=0、
		//   chunkHits=1、替换其实成功）⇒ 单通道式判 false ⇒ 配合下方 throw 会打断正常构建（假失败）；
		// - 不能用 `updated.includes('vbsp_ApplyLightmap(')`：替换串**自身**含该 token ⇒ 按构造必真、
		//   对"是否真的替换过"零信息量（例如替换落到注释里也会判 true）。
		const applied = (inlineHits > 0 || chunkHits > 0) && changed;

		// `broken` 的 `applied === false` 是**设计预期**（它故意用失配字面量证明
		// "字面量失配 ⇒ 注入静默失效 ⇒ 画面压暗"这条因果链），故单独归类，不算失败。
		const expectedFail = stage === 'broken';
		const record = {
			stage,
			inlineHits,
			chunkHits,
			changed,
			applied,
			expectedFail,
			fragLen: frag.length,
		};

		(
			material as unknown as {
				__vbspLightmapInject?: unknown;
				__vbspLightmapInjected?: boolean;
			}
		).__vbspLightmapInject = record;
		if (applied) {
			(
				material as unknown as { __vbspLightmapInjected?: boolean }
			).__vbspLightmapInjected = true;
		}

		if (!applied && !expectedFail) {
			const message =
				'[lightmap-shader] 注入未生效：fragment 里既没有内联 lightmap 块也没有 ' +
				'<lightmap_fragment> include（three 版本漂移？）——' +
				`内联命中=${inlineHits}、include 命中=${chunkHits}、stage=${stage}。` +
				'地图将只剩贴图、无烘焙光照。';
			// **不再静默**：这是本批缺陷的根因形态（静默失配 ⇒ 画面压暗却只打成功日志）。
			// 除 `broken`（预期失败）外一律抛错，使调用方/出帧脚本**非零退出**，
			// 而不是把失败藏在一条容易淹没的 console.error 里。
			(
				globalThis as { __vbspLightmapInjectFailed?: boolean }
			).__vbspLightmapInjectFailed = true;
			throw new Error(message);
		}
		if (!applied && expectedFail) {
			// 负控：预期失败 —— 只记录、不抛（否则 `--stage broken` 直接崩溃、产不出对照帧）。
			(
				globalThis as { __vbspLightmapInjectExpectedFail?: boolean }
			).__vbspLightmapInjectExpectedFail = true;
			console.warn(
				`[lightmap-shader] stage=broken（负控，预期失败）：失配字面量命中 0 次 ⇒ 注入未生效。` +
					`内联命中=${inlineHits}、include 命中=${chunkHits}。`,
			);
		}

		// 插入函数定义 + uniform 声明（vbspExposure 与 atlasSize 并列，S1 曝光旋钮）
		updated = VBSP_LIGHTMAP_UNIFORM_DECLS.join('\n') + '\n' + injected + updated;

		shader.fragmentShader = updated;
	};
	material.needsUpdate = true;
}

/**
 * 无 lightmap 图元的 fullbright 统一路径（gamma-parity 计划 §3.1c）。
 * 外部参照实现对无 lightmap 的世界面用 white texture 兜底（LightmappedBase.ts:71 的
 * `uLightmap.setDefault(getWhiteTexture)`）⇒ 最终色 = 贴图原色。本工程对应实现：
 * 换 MeshBasicMaterial 且**不设 lightMap 槽** ⇒ 命中 meshbasic 的 `#else vec3(1.0)`
 * 分支（`outgoing = base × 1.0`），不吃环境光/三点光/任何运行时灯。
 * 保留原 map / color / transparent / opacity；跳过 `off` 负控（调用方保证）。
 */
function applyFullbrightBasic(mesh: THREE.Mesh): THREE.MeshBasicMaterial {
	const origMat = mesh.material as THREE.Material | THREE.Material[];
	const firstOrig = Array.isArray(origMat) ? origMat[0] : origMat;
	const origBasic = firstOrig as THREE.MeshBasicMaterial;
	const origMap = (origBasic as unknown as { map?: THREE.Texture | null }).map ?? null;
	const origColor =
		(origBasic as unknown as { color?: THREE.Color }).color?.clone() ?? new THREE.Color(0xffffff);
	const newMat = new THREE.MeshBasicMaterial({
		map: origMap,
		color: origColor,
	});
	copyMaterialRenderState(firstOrig, newMat);
	mesh.material = newMat;
	return newMat;
}

/**
 * 把**渲染状态**从原材质拷到替换材质（`MeshBasicMaterial`）。
 *
 * 为什么必须有它（2026-09-20，用户口径「铁丝网/格栅这类透明材质看起来是这样的，很有问题」）：
 * 三个替换点（`applyFullbrightBasic` / `acquireFullbrightMaterial` / `acquireVertexLightingMaterial`）
 * 此前只拷 `map / color / transparent / opacity`，于是这些**全部丢失**：
 *
 * | 丢失项 | 后果（本图实测） |
 * |---|---|
 * | `alphaTest` | `metal_grate_07`（GLB `alphaMode=MASK`、cutoff 0.5）⇒ **整块实心板**，格栅孔洞没了 |
 * | `alphaMap` | 同上（alpha 走独立贴图时） |
 * | `side` | `glasswindow007a` / `metalfence007a`（GLB `doubleSided=true`）⇒ **单面**，从背面看不见 |
 * | `depthWrite` | 半透明排序错乱（`$translucent` 材质） |
 * | `blending` | 非普通混合模式（加色/乘算）失效 |
 * | `userData.unlit` | `isUnlit()` 读不到 ⇒ 诊断把自发光误计为普通材质 |
 */
function copyMaterialRenderState(src: THREE.Material | undefined, dst: THREE.MeshBasicMaterial): void {
	if (!src) return;
	const s = src as THREE.Material & {
		alphaTest?: number;
		alphaMap?: THREE.Texture | null;
		depthWrite?: boolean;
		depthTest?: boolean;
		blending?: THREE.Blending;
		polygonOffset?: boolean;
		polygonOffsetFactor?: number;
		polygonOffsetUnits?: number;
	};
	if (typeof s.alphaTest === 'number') dst.alphaTest = s.alphaTest;
	if (s.alphaMap) dst.alphaMap = s.alphaMap;
	if (typeof s.side === 'number') dst.side = s.side;
	if (typeof s.transparent === 'boolean') dst.transparent = s.transparent;
	if (typeof s.opacity === 'number') dst.opacity = s.opacity;
	if (typeof s.depthWrite === 'boolean') dst.depthWrite = s.depthWrite;
	if (typeof s.depthTest === 'boolean') dst.depthTest = s.depthTest;
	if (typeof s.blending === 'number') dst.blending = s.blending;
	if (typeof s.polygonOffset === 'boolean') dst.polygonOffset = s.polygonOffset;
	if (typeof s.polygonOffsetFactor === 'number') dst.polygonOffsetFactor = s.polygonOffsetFactor;
	if (typeof s.polygonOffsetUnits === 'number') dst.polygonOffsetUnits = s.polygonOffsetUnits;
	// unlit 旗标（`extras.unlit`）与其它 GLB 附加信息：整块浅拷，避免诊断口径失真
	dst.userData = { ...(src.userData ?? {}) };
	// `extras.vbsp_wireframe`（Source `Wireframe` 着色器：只画多边形边线）⇒ 用 three 的线框渲染复现。
	// 实测 `dev_nyro/blends/wire_white`（世界面 8 个、单面 768×512×768，属 worldspawn）：不置线框就是一面实心墙。
	if ((src.userData as { vbsp_wireframe?: boolean } | undefined)?.vbsp_wireframe) {
		dst.wireframe = true;
	}
	// `alphaTest > 0` 时 three 需要 `transparent` 与材质的 alphaTest 语义配合：
	// MASK 材质在 glTF 里 `transparent=false` + `alphaTest=cutoff`（实测 GLTFLoader 行为），
	// 这里保持原样即可（three 对 alphaTest 的处理与 transparent 独立）。
}

/**
 * **第 1 级 prop 光照**：逐顶点预烘焙（VRAD 的 `sp_<idx>.vhv`）→ 几何属性 `_VBSP_VLIGHT`。
 *
 * ## 为什么必须有它（2026-09-20，用户口径「一面一个颜色、像没有光照」）
 *
 * 第 2 级（leaf ambient cube）是**每 prop 一个值**、再按法线平方加权取面 ⇒ 模型的每个朝向面
 * 各得一个**平坦**颜色（"一面一个颜色"），而引擎用的是**逐顶点**烘焙值：
 * 外部参照实现 `Geometry.cs:855-895` 读 pakfile 的 `sp_<i>.vhv` → 顶点色 →
 * `Shaders/VertexLitGeneric.ts` 的 `mainSample.rgb * vVertexLighting`。
 *
 * ## 口径（与引擎逐项对齐）
 *
 * 引擎：`屏幕 = 纹理色 × vVertexLighting`（`vVertexLighting = floor(byte) * 2/255`，
 * 导出侧已按此换算成 [0,2] 的 f32 写进属性）。
 * 本工程：`屏幕 = 纹理色 × 光照项^(1/2.2)`（末端 `colorspace_fragment` 被换成纯 γ2.2 编码）
 * ⇒ 令 `光照项^(1/2.2) = vVertexLighting` ⇒ **`光照项 = vVertexLighting^2.2`**。
 *
 * 面板两个旋钮在此路径上的语义与 world 路径一致：
 * `光照项 = pow(vLight, 2.2/γ) × 曝光`（γ=1、曝光=1 时即引擎平价）。
 *
 * ## 与第 2 级的差别（为什么它能共享材质）
 *
 * 光照数据在**几何属性**里（逐实例烘进顶点），不需要逐 prop 的 uniform ⇒ 所有这类 mesh
 * 共用一个材质实例，`optimizeScene` 的按材质合并照常生效。
 */
function applyVertexLightingShader(mat: THREE.MeshBasicMaterial): void {
	mat.onBeforeCompile = (shader) => {
		shader.uniforms.vbspExposure = exposureUniform;
		shader.uniforms.vbspLightGamma = lightGammaUniform;
		// 声明必须来自共享常量（守卫 §10 断言"注入单元自洽"）
		const decls = VBSP_LIGHTMAP_UNIFORM_DECLS.join('\n');
		// ⚠️ 这个数组进的是 **fragment** shader ⇒ **不能出现 `attribute`**
		// （GLSL 里 `attribute` 仅限 vertex 阶段；实测报
		//  `ERROR: 0:81: 'attribute' : Illegal use of reserved word` ⇒ program 无效 ⇒ 模型不渲染）。
		// 属性声明只在下面的 vertex 侧 `vsA` 里出现。
		const fn = [
			'varying vec3 vbspVLight;',
			'vec3 vbspVertexLightTerm() {',
			'	float g = max(vbspLightGamma, 0.001);',
			'	return pow(max(vbspVLight, vec3(0.0)), vec3(2.2 / g)) * vbspExposure;',
			'}',
		].join('\n');
		const vs = shader.vertexShader;
		const vsA = vs.replace(
			'#include <common>',
			'attribute vec3 ' + VERTEX_LIGHTING_ATTR + ';\nvarying vec3 vbspVLight;\n#include <common>',
		);
		const vsB =
			vsA !== vs
				? vsA.replace(
						'#include <begin_vertex>',
						'#include <begin_vertex>\n\tvbspVLight = ' + VERTEX_LIGHTING_ATTR + ';',
					)
				: vsA;
		const vsChanged = vsB !== vs;
		const fs = shader.fragmentShader;
		const mulSrc = 'reflectedLight.indirectDiffuse *= diffuseColor.rgb;';
		const fsA = fs
			.replace('#include <common>', decls + '\n' + fn + '\n#include <common>')
			.replace(mulSrc, mulSrc.slice(0, -1) + ' * vbspVertexLightTerm();');
		const fsChanged = fsA !== fs;
		const applied = vsChanged && fsChanged;
		(mat as unknown as { __vbspVertexLightingInject?: unknown }).__vbspVertexLightingInject = {
			applied,
			vsChanged,
			fsChanged,
		};
		if (!applied) {
			console.error(
				'[vertex-lighting] 注入未生效：vs=' + vsChanged + ' fs=' + fsChanged,
			);
			return;
		}
		shader.vertexShader = vsB;
		shader.fragmentShader = fsA;
	};
	mat.needsUpdate = true;
}

/**
 * prop 静态光照：leaf ambient cube（6 面线性 RGB）按法线平方加权乘入 fullbright 材质。
 * 对齐外部参照实现 `StudioModel.sampleAmbientCube`（顶点色通道）——本工程 prop 顶点
 * 多实例共享 mesh（不逐实例上传顶点色），故 cube 走 node extras + uniform + shader 加权：
 * - cube 数据：`vbsp::Bsp::prop_ambient_cube`（leaf 定位 + 最近采样点 + RGBExp32 线性解码）
 * - 权重：`n.x²·cube[±X] + n.y²·cube[±Y] + n.z²·cube[±Z]`（与外部参照实现同式）
 * - 域：cube 已是线性值，直接乘进 linear 域 diffuseColor（不套外部参照实现的
 *   linearToScreenGamma——那是其 sRGB 直出管线的显示变换，同 gamma-parity 的矫正原则）
 * - 无均匀缩放假设：prop scale=1；mat3(modelMatrix) 变换世界法线
 *
 * ⚠️ 这是**第 2 级**：几何带 `_VBSP_VLIGHT` 时优先走第 1 级（`applyVertexLightingShader`），
 * 因为 cube 是"每 prop 一个值"，无法表达逐顶点梯度（实机即"一面一个颜色"）。
 */
function applyAmbientCubeIfAny(mesh: THREE.Mesh, mat: THREE.MeshBasicMaterial): void {
	// cube 写在 **node extras** 上（model_integrator/mod.rs:132），而 multi-primitive 的
	// prop 被 GLTFLoader 包成 Group（GLTFLoader.js:3862-3882），extras 落在 Group 而非子
	// Mesh（GLTFLoader.js:4280）⇒ 必须向上回溯。实测 surf_666 有 366/501（73%）的 prop
	// 走这条路径，不回溯就永远拿不到 cube（= 纯 fullbright）。
	const cube = resolveAmbientCube(mesh);
	// 命中统计（首帧后由 renderer-main 的 reportInjectStatsOnce 打日志）：
	// hit/miss 按 mesh 调用计；nodes 按独立 cube 引用去重（= 带 cube 的 prop node 数）
	const st = ((globalThis as { __vbspAmbientStats?: { hit: number; miss: number; nodes: Set<unknown> } })
		.__vbspAmbientStats ??= { hit: 0, miss: 0, nodes: new Set<unknown>() });
	if (!Array.isArray(cube) || cube.length !== 18) {
		st.miss++;
		return;
	}
	st.hit++;
	st.nodes.add(cube);
	const uniformValue = {
		value: Array.from({ length: 6 }, (_, i) =>
			new THREE.Vector3(cube[i * 3], cube[i * 3 + 1], cube[i * 3 + 2]),
		),
	};
	mat.onBeforeCompile = (shader) => {
		shader.uniforms.vbspAmbCube = uniformValue;
		shader.uniforms.vbspExposure = exposureUniform;
		shader.uniforms.vbspLightGamma = lightGammaUniform;
		shader.uniforms.vbspLightFloor = lightFloorUniform;
		shader.uniforms.vbspAmbientScale = ambientScaleUniform;
		const vs = shader.vertexShader;
		const vsA = vs.replace(
			'#include <common>',
			'varying vec3 vbspWNormal;\n#include <common>',
		);
		const vsB =
			vsA !== vs
				? vsA.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvbspWNormal = normalize( mat3( modelMatrix ) * normal );')
				: vsA;
		const vsChanged = vsB !== vs;
		const fs = shader.fragmentShader;
		const ambFn = [
			// ⚠️ 声明必须来自共享常量（**不是**手写副本）——2026-09-20 事故：
			// 本路径原先只声明 exposure/gamma/ambientScale，漏了 `vbspLightFloor`，
			// 而 `vbspAmbientWeight()` 里用了它 ⇒ fragment 编译失败 ⇒ 带 cube 的 prop
			// 与水/远地面**全部不渲染**（用户症状：模型完全透明但有碰撞）。
			...VBSP_LIGHTMAP_UNIFORM_DECLS,
			...VBSP_AMBIENT_UNIFORM_DECLS,
			'varying vec3 vbspWNormal;',
			"vec3 vbspAmbientRaw() {",
			"	vec3 n = normalize( vbspWNormal );",
			"	vec3 c = vec3( 0.0 );",
			"	c += vbspAmbCube[ n.x < 0.0 ? 1 : 0 ] * ( n.x * n.x );",
			"	c += vbspAmbCube[ n.y < 0.0 ? 3 : 2 ] * ( n.y * n.y );",
			"	c += vbspAmbCube[ n.z < 0.0 ? 5 : 4 ] * ( n.z * n.z );",
			"	return max(c, vec3(0.0));",
			"}",
			// ⚠️ 显示 gamma 只能套在**光照项**上（2026-09-20 根因修复，与 vbsp_ApplyLightmap 同因）：
			// `reflectedLight.indirectDiffuse *= diffuseColor.rgb` 之后，indirectDiffuse 已含 albedo，
			// 若在那里再 `pow()` 就等于 gamma 套在「albedo × light」的乘积上 —— 暗部会被压掉约 7 倍
			// （pow(0.13×0.012, 1/2.2) ≈ 0.019，而正确是 0.13 × pow(0.012,1/2.2) ≈ 0.0177... 的 7 倍），
			// 表现就是「exposure 拖爆了暗处仍是 000000」。故此处只把**光照**做 `^(1/γ)`，albedo 留给上面那行乘。
			"vec3 vbspAmbientWeight() {",
			// 下限（加法）：同 `vbsp_ApplyLightmap` —— 纯黑必须靠加法解决，倍率救不回 0。
			"	return pow( max(vbspAmbientRaw(), vec3(vbspLightFloor)), vec3(1.0 / max(vbspLightGamma, 0.001)) ) * vbspExposure * vbspAmbientScale;",
			"}",
		].join('\n');
		const mulSrc =
			'reflectedLight.indirectDiffuse *= diffuseColor.rgb;';
		const fsA = fs
			.replace('#include <common>', ambFn + '\n#include <common>')
			.replace(mulSrc, mulSrc.slice(0, -1) + ' * vbspAmbientWeight();');
		const fsChanged = fsA !== fs;
		const applied = vsChanged && fsChanged;
		(
			mat as unknown as { __vbspAmbientInject?: unknown }
		).__vbspAmbientInject = { applied, vsChanged, fsChanged };
		if (!applied) {
			// 不静默：three 版本漂移导致锚点失配时明确报出（fullbright 兜底仍可渲染）
			console.error('[ambient-cube] 注入未生效：vs=' + vsChanged + ' fs=' + fsChanged);
			return;
		}
		shader.vertexShader = vsB;
		shader.fragmentShader = fsA;
	};
	mat.needsUpdate = true;
}

/**
 * 从 Mesh 自身向上找 ambientCube（最多回溯 2 层：Mesh → prop node(Group)）。
 * multi-primitive 的 prop 被 GLTFLoader 包成 Group，node extras 落在 Group 上。
 */
function resolveAmbientCube(mesh: THREE.Mesh): unknown {
	let obj: THREE.Object3D | null = mesh;
	for (let depth = 0; depth < 2 && obj; depth++) {
		const c = (obj.userData as { ambientCube?: unknown }).ambientCube;
		if (c !== undefined) return c;
		obj = obj.parent;
	}
	return undefined;
}

/**
 * 全局曝光旋钮（scene-brightness-and-lights.md §4.2，S1）。
 *
 * 语义：**显示侧亮度倍率，不是数据修正**。默认 1.0 = 忠于 BSP 烘焙数据
 * （已由动态范围体检佐证：surf_666 的 lightmap 上尾 p99.9 = 1.035、max = 2.09，
 * 量级本就正确；图的中位数暗是地图本身性质）。>3 起 p90 亮面在中灰贴图下开始削顶。
 *
 * **所有材质共享同一个 uniform 对象** ⇒ 面板拖动一次即全场景生效，无需重编译材质
 * （若每个材质各自 `{ value: ... }`，改值只能靠 `material.needsUpdate = true` 重编译，
 * 会让滑块手感变成"每次拖动重编几千个 program"）。
 */
/**
 * **world 光照项默认曝光 = 1（外部参照实现平价，2026-09-20 定案）**。
 *
 * ## 口径（两行代数，别再靠"看着调"）
 *
 * 本工程屏幕值 = `(albedo_linear × lightitem)^(1/2.2)`；
 * 而 `albedo_linear = albedo_srgb^2.2`（three 的 sRGB 解码）⇒
 *
 * ```
 * 屏幕值 = albedo_srgb × lightitem^(1/2.2)
 * ```
 *
 * 外部参照实现的 world 路径原文（`Shaders/LightmappedBase.ts:66`）：
 *
 * ```glsl
 * return inColor * pow(sample, vec3(gamma, gamma, gamma));   // gamma = 1.0 / 2.2
 * ```
 *
 * 即 `屏幕值_su = albedo_srgb × luxel^(1/2.2)`。
 *
 * ⇒ 令两者逐项相等：`lightitem^(1/2.2) = luxel^(1/2.2)` ⇒ **`lightitem = luxel`**
 * ⇒ 本工程 shader 的 `pow(L, 1/γ) × 曝光` 取 **γ = 1、曝光 = 1**（pow 退化为恒等）。
 *
 * ## 量级参考（不是取值依据，只用于核对"看起来暗不暗"）
 *
 * `npm run test:lightmap-atlas-stats` 实测图集在用 texel：
 * p25 0.0177 / p50 0.0440 / p75 0.0860 / p90 0.1747 / p99 0.7955 ⇒
 * 屏幕倍率 `luxel^(1/2.2)` = 0.18 / 0.24 / 0.33 / 0.45 / 0.90。
 * 也就是说**平价默认下"被照亮的面"本来就只有贴图原色的三成左右** —— 这是参照实现的语义，
 * 不是缺陷；嫌暗请用面板「亮度（曝光）」「暗部提升（γ）」两个旋钮，别改这里的默认值。
 *
 * ⚠️ 历史错误取法（已全部作废）：×12 / ×24 / 2.3 —— 都是"看着调"出来的，
 * 前两个把画面冲成粉白，2.3 则是在"模型根本没渲染"的画面里标定的。
 */
const LIGHTMAP_EXPOSURE_DEFAULT = 1;

const exposureUniform = { value: readExposureOverride() ?? LIGHTMAP_EXPOSURE_DEFAULT };

/**
 * 光照项 gamma（shadow-lift）。1.0 = 不修正（现状，纯线性域）。
 * <1 抬高暗部、亮部基本不动；用来对齐外部参照实现的 γ2.2 域乘算（§7.4）。
 * 与曝光一样是**所有材质共享**的 uniform ⇒ 面板/出帧改一次全场景生效。
 */
const lightGammaUniform = { value: readGammaOverride() ?? 1 };

/**
 * 模型（prop）烘焙光照亮度倍率：**只作用于 ambient cube 路径**（static prop 的静态照明），
 * 与 world lightmap 的曝光/γ 相互独立。1.0 = 忠于数据；0 = 模型全黑（A/B 用）。
 * 与其余旋钮一样是**全材质共享**的 uniform ⇒ 拖动即时生效、不触发材质重编译。
 */
const ambientScaleUniform = { value: readAmbientScaleOverride() ?? 1 };

/**
 * **暗部抬升下限**（默认 **0 = 关闭**，外部参照实现平价）。
 *
 * 外部参照实现没有这一项：它直接 `albedo × pow(luxel, 1/2.2)`，暗就是暗。
 * 本项是本工程的可选加法下限（`0 × 任何数 = 0`，倍率救不回纯黑），
 * 默认 **0** 以保持平价；要用就注入 `window.__vbspLightFloor = 0.004` 或调
 * `setLightFloor()`（出帧 A/B 用）。
 *
 * 取值语义：对**光照项**取 `max(v, floor)`（加法，不是倍率）——
 * `0.004` 把最暗一档抬到 ≈ `rgb(20)`，中亮部（≥0.05）与渐变不受影响。
 *
 * ⚠️ 它**不在面板**上（面板三个旋钮是曝光/γ/模型光照），因此不属于"亮度拖拽"。
 * 实现位置：world 路径 `vbsp_ApplyLightmap` 的 `max(decoded, vbspLightFloor)`；
 * prop 路径 `vbspAmbientWeight()` 同式。
 */
const lightFloorUniform = { value: readLightFloorOverride() ?? 0 };

/**
 * **prop 光照基线倍率 = `2^2.2 = 4.5948`**（外部参照实现平价；2026-09-20 定案）。
 *
 * ## 来历（不是"补偿"，是参照实现的编码口径）
 *
 * 外部参照实现的 prop 光照不走 lightmap，而是把 **leaf ambient cube** 经
 * `StudioModel.sampleAmbientCube()` 变成顶点色（`StudioModel.ts:96-98`）：
 *
 * ```ts
 * const r = ColorConversion.linearToScreenGamma(rgb.x);   // = 255 * cube^(1/2.2)（8bit）
 * ...
 * return r | (g << 8) | (b << 16);                        // 打包进顶点色整数部分
 * ```
 *
 * 再由 `Shaders/VertexLitGeneric.ts` 还原：
 *
 * ```glsl
 * vVertexLighting = floor(aEncodedColors) * (2.0 / 255.0);   // = 2 * cube^(1/2.2)
 * gl_FragColor = vec4(mainSample.rgb * vVertexLighting * vAlbedoModulation, mainSample.a);
 * ```
 *
 * 即 **`屏幕值_su = albedo_srgb × 2 × cube^(1/2.2)`**。
 * 本工程屏幕值 = `albedo_srgb × lightitem^(1/2.2)`（推导见 `LIGHTMAP_EXPOSURE_DEFAULT`）
 * ⇒ 令两者相等：`lightitem^(1/2.2) = 2 × cube^(1/2.2)` ⇒
 *
 * ```
 * lightitem = 2^2.2 × cube = 4.5948 × cube
 * ```
 *
 * 而本工程 shader 的 prop 光照项是 `pow(cube, 1/γ) × 曝光 × 模型亮度`，
 * 默认（`lightGamma = 1`、`exposure = 1`、`ambientScale = 1`）⇒ 需要把数据侧乘 4.5948。
 *
 * ## 自洽校验（两条路径必须同量级）
 *
 * | 源 | 实测 p50 | 外部参照实现屏幕倍率 |
 * |---|---|---|
 * | world lightmap（图集在用 texel） | 0.0440 | `0.0440^(1/2.2)` = **0.24** |
 * | prop leaf ambient cube（501 prop） | 0.0107 | `2 × 0.0107^(1/2.2)` = **0.25** |
 *
 * ⇒ 两条路径落在同一亮度域 ✓（这正是那个 2× 的来历）。
 *
 * ⚠️ 历史错误值（已作废）：`12.0`（拿 cube 原始值比 world **渲染后**的值，单位混淆）、
 * `1.0`（只看数据同量级，漏了外部参照实现顶点色编码里的 2×）。
 * 临场微调用面板「模型光照」滑块（`setAmbientScale`），不要改这里。
 * 免重建 A/B：加载前注入 `window.__vbspPropCubeGain = N`。
 */
/**
 * 量级补偿（cube 路径）。**已按游戏内实拍重标定（2026-09-20）**：
 *
 * - 靶标：`surf_666` 默认传送旁那个坡（`s1_ramp1b`）游戏内实拍取色
 *   `#5b4e40 / #605846 / #58483f`（亮度 ≈80、sRGB 0.30）；同一材质 `concrete01`
 *   的 albedo 在 sRGB≈0.55（线性≈0.25）⇒ **游戏内的光照倍率 ≈ 0.30**（屏幕域）。
 * - 本工程 cube 路径的屏幕倍率 ≈ `(gain × cube)^(1/2.2)`；实测 `cube`（`s1_ramp1b`
 *   的 leaf ambient，线性）≈0.030 ⇒ 旧值 `2^2.2 = 4.5948` 给出 **0.40**（比游戏亮 1.3×）。
 * - 由 `(gain_new × 0.030)^(1/2.2) = 0.30` 解出 **gain ≈ 0.30^2.2 / 0.030 = 2.44**。
 *
 * 为什么保留"2 的幂"历史值不再用：旧值是按 `vVertexLighting = byte×2/255` 的 2× 编码
 * 推的**上界**，从未与实拍比对；本轮用实拍靶标替换。
 */
const PROP_CUBE_GAIN = 2.44;

/**
 * 触发「方差压缩」的最小**面内**亮度差（中位数，lightitem 量纲 0..2）。
 *
 * 依据（离线审计全部 473 个带逐顶点光照的 prop）：条纹型（该压）面内 Δ 大
 * （`s1_ramp1b` = 0.233），而「面间差异大、面内一致」（正常，不该动）的很小
 * （`kr_stairs` = 0.023、`s1_roof` = 0.000）。取 0.10 把误伤面收到最小。
 */
const PROP_FLATTEN_MIN_TRI_DELTA = 0.1;

/**
 * 运行期覆盖 prop 量级补偿：`window.__vbspPropCubeGain = 4`（需在**加载前**注入，
 * 因为补偿烘在 cube 上、材质编译时读取）。用于免重建的 A/B。
 */
function readPropCubeGainOverride(): number | null {
	const g = globalThis as { __vbspPropCubeGain?: unknown };
	const v = g.__vbspPropCubeGain;
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** 实际生效的 prop 量级补偿（覆盖优先）。 */
function effectivePropCubeGain(): number {
	return readPropCubeGainOverride() ?? PROP_CUBE_GAIN;
}

/** 第 1 级逐顶点光照**重建**的诊断统计（跨函数读取）。 */
const vertexLightingRelaxStats = {
	/** 参与重建的 mesh 数。 */
	meshes: 0,
	/** 接缝焊接的顶点组数。 */
	welded: 0,
	/** 累计执行的松弛次数（每次 = 一遍全顶点）。 */
	relaxed: 0,
	/** 被空间鲁棒滤波判定为"与邻域不一致"并拉回中位数的顶点数。 */
	medianFixed: 0,
	/** 做了方差压缩（向 prop 均值收敛）的 mesh 数。 */
	flattened: 0,
	/** 因「面内本来就一致」而**跳过**方差压缩的 mesh 数（保留原样烘焙值）。 */
	flattenSkipped: 0,
	/** 逐 mesh 平均的 |Δluma|（重建后 vs 原始烘焙值）。 */
	meanAbsDelta: 0,
	/** 单顶点最大 |Δluma|。 */
	maxAbsDelta: 0,
	/** 参与统计的顶点数。 */
	samples: 0,
};

/**
 * 第 1 级重建统计（`[vertex-lighting]` 日志用）。
 * 注意 `meanAbsDelta` 是**逐 mesh 平均后再平均**，用于判断"这份重建偏离烘焙数据多少"。
 */
export function getVertexLightingRelaxStats(): Readonly<typeof vertexLightingRelaxStats> {
	return vertexLightingRelaxStats;
}

/**
 * 第 1 级逐顶点光照的**重建平滑次数**（0 = 原样使用烘焙值）。
 * 由 `renderer-main` 从 `config.lighting.propVertexRelax` 注入；也可免重建 A/B：
 * 加载前设 `window.__vbspPropVertexRelax = 0|1|2`。
 */
let propVertexRelaxPasses = 1;

/** 设置重建平滑次数（≥0；0 = 关闭，最忠于烘焙数据）。 */
export function setPropVertexRelax(passes: number): void {
	if (Number.isFinite(passes) && passes >= 0) propVertexRelaxPasses = Math.floor(passes);
}

/** 读取当前重建平滑次数。 */
export function getPropVertexRelax(): number {
	return propVertexRelaxPasses;
}

/**
 * 第 1 级逐顶点光照的**方差压缩**（0..1）：`v ← mean + (1-flatten)·(v-mean)`，
 * 均值严格不变、只压方差。1 = 该 prop 均匀受光（= 用户游戏内实拍观感）。
 * 由 `renderer-main` 从 `config.lighting.propVertexFlatten` 注入；
 * 免重建 A/B：加载前设 `window.__vbspPropVertexFlatten = 0|0.85|1`。
 */
let propVertexFlattenAmount = 0;

/** 设置方差压缩量（0 = 不压；1 = 完全压平到 prop 均值）。 */
export function setPropVertexFlatten(v: number): void {
	if (Number.isFinite(v) && v >= 0) propVertexFlattenAmount = Math.min(1, v);
}

/** 读取当前方差压缩量。 */
export function getPropVertexFlatten(): number {
	return propVertexFlattenAmount;
}

/** 全局覆盖（`window.__vbspPropVertexFlatten`）优先于配置——免重建 A/B。 */
function readPropVertexFlatten(): number {
	const g = globalThis as { __vbspPropVertexFlatten?: unknown };
	const v = g.__vbspPropVertexFlatten;
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(1, v) : propVertexFlattenAmount;
}

/** 全局覆盖（`window.__vbspPropVertexRelax`）优先于配置——用于免重建 A/B。 */
function readPropVertexRelax(): number {
	const g = globalThis as { __vbspPropVertexRelax?: unknown };
	const v = g.__vbspPropVertexRelax;
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : propVertexRelaxPasses;
}

/**
 * **免重建 A/B**：`window.__vbspVertexLightingOff = true`（需在加载前注入）⇒ 所有 prop 走
 * 第 2 级 leaf ambient cube，忽略 `sp_<i>.vhv`。
 *
 * 用途：判定"引擎是否真的用了这份逐顶点数据"。实测依据（2026-09-20）：
 * - `sp_264.vhv` 的 checksum = `s1_ramp1b.mdl` 的 studiohdr checksum（归属与下标都对）；
 * - 该 prop 的 sprp 记录 `m_Flags = 0x01`（只有 FADES，无 `USE_LIGHTMAP` / `NoPerVertexLighting`）
 *   ⇒ 按外部参照实现的读法应当走逐顶点；
 * - 但它的 `vertFlags = 4`（外部参照实现只特判 `== 2`，其余一律按 4 字节/顶点读），
 *   **引擎是否接受这个变体未经证实**；用户实拍的游戏内该坡是**均匀**的，与本工程的分块不符。
 * 所以留这个开关：切到 cube 后若观感与游戏一致，就说明引擎实际走的是 cube 兜底。
 */
function readVertexLightingOff(): boolean {
	return (globalThis as { __vbspVertexLightingOff?: unknown }).__vbspVertexLightingOff === true;
}

/** 出帧/控制台覆盖：`window.__vbspLightFloor`（默认 0 = 关闭，外部参照实现平价）。 */function readLightFloorOverride(): number | null {
	const g = globalThis as { __vbspLightFloor?: unknown };
	const v = g.__vbspLightFloor;
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** 设置暗部抬升下限（0 = 关闭）。 */
export function setLightFloor(v: number): void {
	if (Number.isFinite(v) && v >= 0) lightFloorUniform.value = v;
}

/** 读取当前暗部抬升下限。 */
export function getLightFloor(): number {
	return lightFloorUniform.value as number;
}

/** 诊断：只输出 albedo（贴图原色，不施加 lightmap）——`window.__vbspDebugAlbedoOnly`。 */
function readDebugAlbedoOnly(): boolean {
	return (globalThis as { __vbspDebugAlbedoOnly?: unknown }).__vbspDebugAlbedoOnly === true;
}

/**
 * 诊断：把 albedo 贴图当成**线性**数据（不做 sRGB→linear 解码）。
 * 用途：验证「贴图是否被二次解码」——若开关后画面显著变亮，说明 VTF→GLB 的像素
 * 已是线性值、three 又解了一次（经典双重解码 ⇒ 暗部被压到 sRGB≈0.2）。
 */
function readDebugTexLinear(): boolean {
	return (globalThis as { __vbspDebugTexLinear?: unknown }).__vbspDebugTexLinear === true;
}

/** 诊断：只输出 lightmap 项（去掉 albedo）——`window.__vbspDebugLightmapOnly`。 */
function readDebugLightmapOnly(): boolean {
	return (globalThis as { __vbspDebugLightmapOnly?: unknown }).__vbspDebugLightmapOnly === true;
}

/** 出帧 A/B 覆盖值（`window.__vbspLightGamma`）。 */
function readGammaOverride(): number | null {
	const g = globalThis as { __vbspLightGamma?: unknown };
	const v = g.__vbspLightGamma;
	return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1 ? v : null;
}

/** 设置光照项 gamma（面板 / config 调用；非法值忽略；A/B 覆盖优先）。 */
export function setLightGamma(value: number): void {
	if (!Number.isFinite(value) || value <= 0 || value > 1) return;
	if (readGammaOverride() !== null) return;
	lightGammaUniform.value = value;
}

/** 读取当前光照项 gamma（诊断用）。 */
export function getLightGamma(): number {
	return lightGammaUniform.value;
}

/** 出帧 A/B 覆盖值（`window.__vbspExposure`，由 addScriptToEvaluateOnNewDocument 注入）。 */
function readExposureOverride(): number | null {
	const g = globalThis as { __vbspExposure?: unknown };
	const v = g.__vbspExposure;
	return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** 设置全局曝光（面板 / config 调用；非法值忽略）。 */
export function setExposure(value: number): void {
	if (!Number.isFinite(value) || value <= 0) return;
	// 出帧 A/B 覆盖优先：注入了 `window.__vbspExposure` 时**忽略**面板/config 写入。
	// 否则面板构造时的 `sendAllPrefs → onSyncExposure(config.lighting.exposure)`
	// 会把注入值立刻冲回默认值（实测：注入 24 → 被回写为 1，A/B 全档同帧）。
	if (readExposureOverride() !== null) return;
	exposureUniform.value = value;
}

/** 读取当前全局曝光（诊断用）。 */
export function getExposure(): number {
	return exposureUniform.value;
}

/** 出帧 A/B 覆盖值（`window.__vbspAmbientScale`）。 */
function readAmbientScaleOverride(): number | null {
	const g = globalThis as { __vbspAmbientScale?: unknown };
	const v = g.__vbspAmbientScale;
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** 设置模型（prop）烘焙光照亮度倍率（面板 / config 调用；非法值忽略）。 */
export function setAmbientScale(value: number): void {
	if (!Number.isFinite(value) || value < 0) return;
	if (readAmbientScaleOverride() !== null) return;
	ambientScaleUniform.value = value;
}

/** 读取当前模型光照亮度倍率（诊断用）。 */
export function getAmbientScale(): number {
	return ambientScaleUniform.value;
}
