import * as THREE from 'three';
import { hasInjection, registerInjection } from '../injection-registry.js';

// ── 光照模式（面板「预烘焙 / 纯纹理」）──────────────────────────────────────
/**
 * 光照模式（面板「预烘焙 / 纯纹理」）——**运行期性能旋钮，不是加载开关**。
 *
 * 两种模式的**加载路径相同**（同一份 GLB、同一批注入材质、同一张 atlas；调用方在
 * `loadLightmapAtlas` 返回 `null` 时才整体跳过），差别只在**每帧片元代价**：
 * - `baked`（预烘焙）：世界面采 atlas（每片元 4 次纹素采样 + 双线性解码），
 *   prop 吃逐顶点烘焙值或 leaf ambient cube（法线平方加权 6 面）；
 * - `texture`（纯纹理）：片元里的烘焙项恒为 1.0，等价于只上漫反射贴图
 *   ⇒ 不采 atlas、不算解码与 cube。
 *
 * 切换只改 `bakedMixUniform` 的值（`setLightingMode`）：不重建场景、不重编译材质、
 * 不打断输入与物理。
 */
export type LightingMode = 'baked' | 'texture';

/** 当前光照模式（模块级；`applyLightmapToMeshes` 读它）。 */
let lightingMode: LightingMode = 'baked';

/**
 * 光照模式的**运行期载体**：1 = 预烘焙（吃烘焙项）、0 = 纯纹理（烘焙项恒 1.0）。
 *
 * 全场景所有注入材质共享**同一个** uniform 对象 ⇒ `setLightingMode` 改一次值即全场景生效：
 * 不重编译 program、不换材质、不重建场景。三条注入路径都读它（见 `vbsp_ApplyLightmap`、
 * `vbspVertexLightTerm`、`vbspAmbientWeight`）。
 */
const bakedMixUniform: { value: number } = { value: 1 };

/**
 * vhv 逐顶点烘焙的伽马处理（调试面板「vhv 线性（去伽马）」）：
 * - `0` = 现状：把 vhv 值当**线性光**，先 `pow(v, 2.2)` 再乘（暗处压得更黑、相邻顶点差被放大）；
 * - `1` = Source 语义：`.vhv` 存的是屏幕倍率（`v*2/255`），直接在**伽马空间**当乘数用。
 *
 * 与 `bakedMixUniform` 同样做成全场景共享的运行期载体：改值下一次绘制即生效，
 * 不重编译 program、不重建场景。
 */
const vhvLinearUniform: { value: number } = { value: 0 };

/** 设置 vhv 项的伽马处理：`true` = 伽马空间直接乘（去 2.2 幂），`false` = 现状。 */
export function setVhvLinear(on: boolean): void {
	vhvLinearUniform.value = on ? 1 : 0;
}

/** 当前 vhv 伽马处理（面板回填用）。 */
export function getVhvLinear(): boolean {
	return vhvLinearUniform.value >= 0.5;
}

/** 设置光照模式：改共享 uniform（下一次绘制即生效）+ 记模式（供 UI / 日志）。 */
export function setLightingMode(mode: LightingMode): void {
	lightingMode = mode === 'texture' ? 'texture' : 'baked';
	bakedMixUniform.value = lightingMode === 'baked' ? 1 : 0;
}

/** 当前光照模式。 */
export function getLightingMode(): LightingMode {
	return lightingMode;
}

/**
 * 全局曝光旋钮。
 *
 * 语义：**显示侧亮度倍率，不是数据修正**。默认 1.0 = 直接采用 BSP 烘焙数据的量级
 * （`LIGHTMAP_EXPOSURE_DEFAULT`）；`>1` 整体提亮，暗部与亮部同比放大。
 *
 * **所有材质共享同一个 uniform 对象** ⇒ 面板拖动一次即全场景生效，无需重编译材质
 * （若每个材质各自 `{ value: ... }`，改值只能靠 `material.needsUpdate = true` 重编译，
 * 会让滑块手感变成"每次拖动重编几千个 program"）。
 */
/**
 * **world 光照项默认曝光 = 1（外部参照实现平价）**。
 *
 * ## 口径（两行代数）
 *
 * 本工程屏幕值 = `(albedo_linear × lightitem)^(1/2.2)`；
 * 而 `albedo_linear = albedo_srgb^2.2`（three 的 sRGB 解码）⇒
 *
 * ```
 * 屏幕值 = albedo_srgb × lightitem^(1/2.2)
 * ```
 *
 * 外部参照实现的 world 路径原文（符号见 `Shaders/LightmappedBase.ts`）：
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
 * ## 量级参考（不是取值依据）
 *
 * 图集在用 texel 的分布可用 `npm run test:lightmap-atlas-stats` 复算；
 * 平价默认下**被照亮的面**本就只有贴图原色的三成左右 —— 这是参照实现的语义，
 * 不是缺陷；嫌暗请用面板「亮度（曝光）」「暗部提升（γ）」两个旋钮，不要改这里的默认值。
 */
/** 三端**唯一**的静态光照呈现默认档（SDK 口径：`OVERBRIGHT 2.0f` + 一次屏幕 gamma）。
 *  各应用与面板初值都必须取自本对象，不得在 apps/ 里再写一份 —— 发现分叉请改这里。 */
export const LIGHTING_PRESENTATION_DEFAULTS = {
	exposure: 2.0,
	lightGamma: 1.0,
	ambientScale: 1,
	// 逐顶点光照**不做任何几何侧重写**（T-732 2026-10-27 删除）：直接吃 GLB 的 _VBSP_VLIGHT，
	// 屏 = 贴图 sRGB × vlight（v = 2×byte/255），与引擎口径一致。
} as const;
const LIGHTMAP_EXPOSURE_DEFAULT = LIGHTING_PRESENTATION_DEFAULTS.exposure;

const exposureUniform = { value: readExposureOverride() ?? LIGHTMAP_EXPOSURE_DEFAULT };

/**
 * 光照项 gamma（shadow-lift）。1.0 = 不修正（纯线性域）。
 * <1 抬高暗部、亮部基本不动；用来对齐外部参照实现的 γ2.2 域乘算。
 * 与曝光一样是**所有材质共享**的 uniform ⇒ 面板/出帧改一次全场景生效。
 */
const lightGammaUniform = { value: readGammaOverride() ?? LIGHTING_PRESENTATION_DEFAULTS.lightGamma };

/**
 * 模型（prop）烘焙光照亮度倍率：**只作用于 ambient cube 路径**（static prop 的静态照明），
 * 与 world lightmap 的曝光/γ 相互独立。1.0 = 忠于数据；0 = 模型全黑（A/B 用）。
 * 与其余旋钮一样是**全材质共享**的 uniform ⇒ 拖动即时生效、不触发材质重编译。
 */
const ambientScaleUniform = { value: readAmbientScaleOverride() ?? LIGHTING_PRESENTATION_DEFAULTS.ambientScale };

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
 * **L1 逐顶点烘焙项（vhv）专属增益**——默认 **1 = 关**（数据原样），仅乘 `vbspVertexLightTerm()`
 * 里 `pow(_vbsp_vlight, 2.2/γ)` 这一项，**不碰 world lightmap / 第 2 级 cube** 的量级
 * （第 2 级的量级补偿是数据侧 `PROP_CUBE_GAIN`，与本旋钮无关）。
 *
 * ## 为什么需要（T-732 结论）
 *
 * `surf_boreas` 的 `dek01` 甲板暗条与 `surf_666` 的 `s1_ramp1b` 坡面暗带，探针证实都是
 * **地图自带的 vhv 烘焙值**（重排正确、与世界 lightmap 的阴影自洽），渲染公式忠实呈现；
 * 暗 = 数据，不是管线丢光。要提亮只能动呈现语义——按 owner 裁决（W-A 先例）落**默认关的
 * 试档旋钮**，不改任何默认值。
 *
 * ## 档位参照（屏幕值口径 `albedo_srgb × vlight × (gain·exposure)^(1/2.2)`）
 *
 * - `1`（默认）= 现状：净系数 `exposure=2 ⇒ 2^(1/2.2) ≈ 1.516`；
 * - `4.5948`（= `2^2.2`）：净系数恰为 **×2.0**，即 SDK 引擎口径
 *   （`common_vertexlitgeneric_dx9.h:268-274` 的 `GammaToLinear(staticLightingColor × cOverbright)`
 *   折回屏幕域等价于 vhv 项 ×2；本工程默认只给到 ×1.516）；
 * - 更高 = 继续提亮暗部（亮部会先饱和到贴图原色，无需担心过曝白板）。
 *
 * 免重建 A/B：加载前注入 `window.__vbspVhvGain = N`（材质编译期读取，改值需重载地图）。
 */
const vhvGainUniform = { value: readVhvGainOverride() ?? 1 };

/**
 * **prop 光照基线倍率 = `2^2.2 = 4.5948`**（外部参照实现平价）。
 *
 * ## 来历（不是"补偿"，是参照实现的编码口径）
 *
 * 外部参照实现的 prop 光照不走 lightmap，而是把 **leaf ambient cube** 经
 * `StudioModel.sampleAmbientCube()` 变成顶点色（符号见 `StudioModel.ts`）：
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
 * 临场微调用面板「模型光照」滑块（`setAmbientScale`），不要改这里。
 * 免重建 A/B：加载前注入 `window.__vbspPropCubeGain = N`。
 */
/**
 * 量级补偿（cube 路径）。cube 是**线性**值，本常量把数据侧抬到参照实现的
 * `2 × cube^(1/2.2)` 顶点色编码域（推导见上一段 `PROP_CUBE_GAIN` 的口径）。
 * 免重建 A/B：加载前注入 `window.__vbspPropCubeGain`（见 `readPropCubeGainOverride`）。
 */
const PROP_CUBE_GAIN = 2.44;

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

/** 应用共享层默认档（三端 init 的唯一调用点；不要在 apps/ 里逐项写死）。 */
export function applyLightingPresentationDefaults(): void {
	const d = LIGHTING_PRESENTATION_DEFAULTS;
	setExposure(d.exposure);
	setLightGamma(d.lightGamma);
	setAmbientScale(d.ambientScale);
}

/**
 * **免重建 A/B**：`window.__vbspVertexLightingOff = true`（需在加载前注入）⇒ 所有 prop 走
 * 第 2 级 leaf ambient cube，忽略 `sp_<i>.vhv`。
 *
 * 用途：把第 1 级与第 2 级的画面差异做成单变量对照（不重建场景、不重编译材质）。
 * 相关的数据侧事实（读码可得）：
 * - `sp_<idx>.vhv` / `sp_hdr_<idx>.vhv` 的解析与 `vert_flags` 分支在
 *   `src/wasm-core/vhv.rs` 的 `parse_vhv`：`vert_flags == 2` ⇒ 每顶点 3 组 RGBA（取均值），
 *   否则一律按 1 组 RGBA（4 字节/顶点）读；
 * - 该解析结果经 `src/wasm-core/model_integrator/mod.rs` 写成 glTF 自定义属性
 *   `_VBSP_VLIGHT`，本文件的第 1 级路径读它。
 * ⇒ 该开关给出"第 1 级是否在起作用"的对照面。
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

/** 诊断：只输出 albedo（贴图原色，不施加 lightmap）——`window.__vbspDebugAlbedoOnly`。 */
function readDebugAlbedoOnly(): boolean {
	return (globalThis as { __vbspDebugAlbedoOnly?: unknown }).__vbspDebugAlbedoOnly === true;
}

/**
 * 诊断：把 albedo 贴图当成**线性**数据（不做 sRGB→linear 解码）。
 * 用途：判据是「同一帧开/关该开关的像素差」——VTF→GLB 的像素若已是线性值，
 * three 再解一次就是双重解码，暗部被额外压低；置 `LinearSRGBColorSpace` 即跳过这一次解码。
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
	return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 8 ? v : null;
}

/** 设置光照项 gamma（面板 / config 调用；非法值忽略；A/B 覆盖优先）。 */
export function setLightGamma(value: number): void {
	if (!Number.isFinite(value) || value <= 0 || value > 8) return; // 窗口 (0,8]：γ>1 才是抬高暗部（旧 (0,1] 与语义相反，2.2 一直被忽略）
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
	// 会把注入值立刻冲回 `LIGHTMAP_EXPOSURE_DEFAULT`，使 A/B 各档落在同一帧。
	if (readExposureOverride() !== null) return;
	exposureUniform.value = value;
}

/** 出帧 A/B 覆盖值（`window.__vbspAmbientScale`）。 */
function readAmbientScaleOverride(): number | null {
	const g = globalThis as { __vbspAmbientScale?: unknown };
	const v = g.__vbspAmbientScale;
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * 运行期覆盖 L1 vhv 项增益：`window.__vbspVhvGain = N`（材质**编译期**读取，改值需重载地图；
 * 与 `readPropCubeGainOverride` 同型）。非法（非有限 / 负数）一律忽略，保持默认 1 = 关。
 * 只作用于第 1 级逐顶点烘焙路径，见 `vhvGainUniform` 的档位说明。
 */
function readVhvGainOverride(): number | null {
	const g = globalThis as { __vbspVhvGain?: unknown };
	const v = g.__vbspVhvGain;
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** 设置模型（prop）烘焙光照亮度倍率（面板 / config 调用；非法值忽略）。 */
export function setAmbientScale(value: number): void {
	if (!Number.isFinite(value) || value < 0) return;
	if (readAmbientScaleOverride() !== null) return;
	ambientScaleUniform.value = value;
}

/** 当前地图的雾密度上限（1 = 不加限）。 */
let fogMaxDensity = 1;

/** 经过本文件注入的材质（值变化时标记重编）。 */
const injectedMaterials = new Set<THREE.Material>();

/** 登记一个注入材质（三处 `onBeforeCompile` 首行调用）。 */
function registerInjectedMaterial(m: THREE.Material): void {
	injectedMaterials.add(m);
}

/**
 * 设置雾密度上限（0..1）：值变化时标记已缓存的注入材质重编，
 * 兼容「先建材质、后拿到地图雾」的加载顺序。
 *
 * T-648：雾上限同时是**缓存键的变体分量**（见 `injection-registry.ts`），因此这里
 * 先把新值刷进每个材质的键（键一变，`customProgramCacheKey` 返回值即变，three 下次
 * 取程序自然拿到新 program），再补一次 `needsUpdate` 兜底既有语义。
 */
export function setFogMaxDensity(v: number): void {
	if (!Number.isFinite(v) || v <= 0) return;
	// 诊断/出帧 A/B 覆盖：`globalThis.__vbspFogMaxDensity`（数字）优先于地图值。
	const ov = (globalThis as { __vbspFogMaxDensity?: unknown }).__vbspFogMaxDensity;
	if (typeof ov === 'number' && Number.isFinite(ov) && ov > 0) v = ov;
	const clamped = Math.min(1, v);
	if (clamped === fogMaxDensity) return;
	fogMaxDensity = clamped;
	(globalThis as { __vbspFogCap?: number }).__vbspFogCap = clamped;
	for (const m of injectedMaterials) {
		// 该材质当初是哪个注入点的产物，这里就以同 tag 重登记新变体值
		for (const tag of ['lightmap', 'vertex-lighting', 'ambient-cube'] as const) {
			if (hasInjection(m, tag)) registerInjection(m, tag, String(clamped));
		}
		m.needsUpdate = true;
	}
}


// ── env_cubemap 近似反射（VMT `$envmap`）────────────────────────────────────
// 引擎里 `$envmap env_cubemap` 的材质（冰、玻璃、水）亮部主要来自环境反射；本工程用
// 2D 天空盒的立方体贴图作为近似源，tint 取自 VMT 的 `$envmaptint`（经材质 extras 落到
// userData.vbsp_envmap）。诊断覆盖：globalThis.__vbspEnvMapAll（数字）对所有替换材质生效。
let reflectionEnvMap: THREE.Texture | null = null;

/** 设置反射源（唯一调用方是 `environment/scene-environment.ts`；null 清除）。 */
export function setReflectionEnvMap(tex: THREE.Texture | null): void {
	reflectionEnvMap = tex;
	(globalThis as { __vbspEnvMapReady?: boolean }).__vbspEnvMapReady = tex !== null;
	// 材质通常在天空盒之前建好 ⇒ 这里对已登记的注入材质补挂一次（含 userData.vbsp_envmap 与全局覆盖）
	for (const m of injectedMaterials) {
		applyReflectionEnvMap(m, m);
		m.needsUpdate = true;
	}
}

/** 把 VMT 的 `$envmap` 意图落到 three 的 envMap（Basic 材质支持 envMap/reflectivity/combine）。 */
function applyReflectionEnvMap(dst: THREE.Material, src: THREE.Material): void {
	const ov = (globalThis as { __vbspEnvMapAll?: unknown }).__vbspEnvMapAll;
	const raw = (src.userData as { vbsp_envmap?: unknown }).vbsp_envmap;
	const tint = typeof ov === 'number' ? ov : Array.isArray(raw) && raw.length >= 3 ? Number(raw[0]) : null;
	if (tint === null || !Number.isFinite(tint)) return;
	const m = dst as THREE.MeshBasicMaterial;
	if (!reflectionEnvMap) { noteEnvMapMissing(); return; }
	m.envMap = reflectionEnvMap as THREE.CubeTexture;
	// Source 的 $envmap 是**叠加**在漫反射之上的反射高光（非混入），强度按 tint 缩放后仍须保守：
	// MixOperation + 0.66 会把整个材质混成天空色（实测 879 个材质一起变惨白）。
	m.combine = THREE.AddOperation;
	m.reflectivity = Math.max(0, Math.min(0.5, tint * 0.35));
	(globalThis as { __vbspEnvMapApplied?: number }).__vbspEnvMapApplied =
		((globalThis as { __vbspEnvMapApplied?: number }).__vbspEnvMapApplied ?? 0) + 1;
}

/**
 * `$envmap` 材质已登记、但反射源为空时的缺源告警（首次一条 + 累计计数）。
 *
 * 定义在文件末尾：`setReflectionEnvMap` / `applyReflectionEnvMap` 的行号被文档锚点钉住
 * （看板 `T-458`），插在中间会让锚点整体平移。
 */
function noteEnvMapMissing(): void {
	const g = globalThis as { __vbspEnvMapMissing?: number; __vbspEnvMapMissingWarned?: boolean };
	g.__vbspEnvMapMissing = (g.__vbspEnvMapMissing ?? 0) + 1;
	if (!g.__vbspEnvMapMissingWarned) {
		g.__vbspEnvMapMissingWarned = true;
		console.warn('[lightmap-shader] $envmap 材质已登记但反射源为空（场景未登记天空盒）⇒ 这批材质的反射高光整体缺失');
	}
}

/** 反射源状态只读出口（三端一致性探针与门禁读它；`globalThis.__vbspEnvMap*` 保留兼容）。 */
export function getReflectionEnvMapState(): { ready: boolean; applied: number; missing: number } {
	const g = globalThis as { __vbspEnvMapReady?: boolean; __vbspEnvMapApplied?: number; __vbspEnvMapMissing?: number };
	return { ready: g.__vbspEnvMapReady === true, applied: g.__vbspEnvMapApplied ?? 0, missing: g.__vbspEnvMapMissing ?? 0 };
}
export {
  bakedMixUniform, vhvLinearUniform, exposureUniform, lightGammaUniform, ambientScaleUniform,
  lightFloorUniform, vhvGainUniform, effectivePropCubeGain, readVertexLightingOff,
  readDebugAlbedoOnly, readDebugTexLinear, readDebugLightmapOnly, fogMaxDensity,
  registerInjectedMaterial, applyReflectionEnvMap,
}
