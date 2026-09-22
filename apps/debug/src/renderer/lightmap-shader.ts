/**
 * 离线烘焙静态光照的 three.js 侧落地：RGBExp32 图集解码着色器注入 + prop 三级光照路由。
 *
 * ## 副本关系
 *
 * 三工程（`apps/debug`、`apps/game`、`apps/viewer`）各持一份**同构副本**，
 * 路径都是 `src/renderer/lightmap-shader.ts`，彼此不 import、不跨工程引用；
 * 本文件是上述三份同构副本之一（按所在工程目录定位）。改动只对所在工程生效。
 *
 * ## 上游（Rust/wasm 侧产出 GLB）
 *
 * - `src/wasm-core/bsp_to_gltf_core/lightmap.rs` 的 `build_atlas` 把 VRAD 烘焙结果打成一页
 *   RGBA8 图集；`inject_lightmap_json` 把纹理下标写进 `asset.extras.lightmap.textureIndex`；
 *   `lightmap_uv` 把每个顶点映射到图集内缩矩形（min 加半像素、size 取矩形边长减一）。
 * - `src/wasm-core/bsp_to_gltf_core/convert.rs` 把该 UV 写进 `TEXCOORD_1`，并按面写图元
 *   `extras.hasLightmap`（未命中图集区域的面写中性常量 UV）。
 * - `src/wasm-core/model_integrator/mod.rs` 给 prop 写逐顶点烘焙属性 `_VBSP_VLIGHT`
 *   （glTF 自定义语义，运行期键名见 `VERTEX_LIGHTING_ATTR`）与 node extras 的 `ambientCube`。
 *
 * ## 下游（本文件的消费点）
 *
 * - `apps/game/src/renderer/renderer-main.ts`：`loadLightmapAtlas` → `applyLightmapToMeshes`
 *   → `fullbrightUnlitLitMaterials`，并读注入记录字段做统计。
 * - `apps/debug/src/renderer/renderer-main.ts`：只调 `loadLightmapAtlas` / `applyLightmapToMeshes`
 *   与 `setLightingMode` / `getLightingMode`，不做装配后终扫。
 * - `apps/viewer/src/core/scene.ts`：`loadLightmapAtlas` / `applyLightmapToMeshes` /
 *   `fullbrightUnlitLitMaterials`，传入的是模型根 Group 而非 `THREE.Scene`。
 *
 * ## 三条光照路径（都在片元里替换 three 的 lightmap 采样项）
 *
 * 1. **world 面**：图集 + 手写双线性 + RGBExp32 解码，函数体在 `VBSP_APPLY_LIGHTMAP`；
 * 2. **prop 第 1 级**：几何属性 `_VBSP_VLIGHT` 的逐顶点烘焙值（`applyVertexLightingShader`）；
 * 3. **prop 第 2 级**：node extras 的 leaf ambient cube，按法线平方加权（`applyAmbientCubeIfAny`）。
 *
 * `extras.unlit === true` 的图元不吃任何光照，直接贴图原色（`routeFullbright` 的首个分支）。
 *
 * ## 关键不变量
 *
 * - 图集纹理必须 `NoColorSpace` + `NearestFilter` + 不生成 mipmap：RGBExp32 的指数在 α 通道上，
 *   硬件插值会先混指数再解码。双线性只在 `vbsp_ApplyLightmap` 里对**已解码**的值做。
 * - 解码式：`exp = alpha * 255 - 128`、`rgb_linear = rgb * 2^exp`；rgb 是线性辐射度，
 *   不做 `pow(1/2.2)`，显示变换由 `installGamma22Output` 统一在出口做一次。
 * - lightMap 槽的 UV 由 `Texture.channel` 决定（three r151+ 起），必须显式置 1 才读 `uv1`，
 *   否则回落到 `uv`（漫反射 UV），见 `resolveLightmapUvChannel`。
 * - γ 只作用于**光照项**，不作用于 `albedo × 光照` 的乘积：注入后片元值为
 *   `albedo_linear × 光照项`，出口再整体做 `^(1/2.2)`；若把 `^(1/2.2)` 挪到乘积上，
 *   暗部会被额外压低一个量级（三条路径同此口径）。
 * - 注入材质用到的贴图槽固定为 `map`、`lightMap`、`alphaMap`（后者由
 *   `copyMaterialRenderState` 从原材质继承，可为空），不新增其它纹理槽。
 * - `uniform` 声明只有 `VBSP_LIGHTMAP_UNIFORM_DECLS` / `VBSP_AMBIENT_UNIFORM_DECLS` 两个来源，
 *   三条注入路径都从它们取；缺一条声明就是 GLSL 编译失败、整批 mesh 不绘制。
 * - 图元 `extras.hasLightmap === false` 表示只有中性占位 UV（无真实 luxel），
 *   此时不施加 lightmap，改走 fullbright，避免用无意义 UV 采到图集里别的面。
 *
 * ## 失败语义
 *
 * - `injectLightmapShader` 的两条替换通道都没命中时，除 `broken` 阶段外一律置
 *   `globalThis.__vbspLightmapInjectFailed = true` 并 `throw`，使调用方非零退出。
 * - `applyVertexLightingShader` / `applyAmbientCubeIfAny` 锚点失配时只 `console.error`
 *   并把结果记在材质的注入记录字段上，渲染继续（fullbright 兜底）。
 * - `loadLightmapAtlas` 在缺少 `textureIndex` 或加载（`parser.loadTexture`）失败时
 *   返回 `null`；调用方在 `null` 时整段跳过 lightmap 施加，地图仍是贴图原色。
 *
 * ## 副作用
 *
 * 模块被 import 时即调用 `installGamma22Output()` 覆盖 three 的 `colorspace_fragment` 块，
 * 早于任何材质编译；该覆盖是全局的、幂等的，可用 `globalThis.__vbspOutputGamma22 === false` 关闭。
 */

import * as THREE from 'three';
import type { GLTF, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';

// ---------------------------------------------------------------------------
// GLSL 片段：RGBExp32 解码 + 手写双线性采样
// ---------------------------------------------------------------------------

/**
 * 解码单个 RGBExp32 样本（只被 `VBSP_APPLY_LIGHTMAP` 调用）。
 *
 * 图集是 RGBA8 且纹理为 `NoColorSpace`，采样值域 [0,1]（= 原始字节 / 255）：
 * `rgb` 是尾数、`a` 是指数偏移（`exp + 128`）。
 * 解码 `exp = a * 255 - 128`、`rgb * 2^exp`，得到线性辐射度，不做钳制也不做显示变换。
 *
 * @param texel 图集纹素（RGBA8 归一化值）。
 * @returns 线性 RGB（不裁剪负指数带来的极小值）。
 */
export const VBSP_DECOMPRESS_LIGHTMAP_SAMPLE = /* glsl */ `
vec3 vbsp_DecompressLightmapSample(vec4 texel) {
	float expV = texel.a * 255.0 - 128.0;
	return texel.rgb * pow(2.0, expV);
}
`;

/**
 * 手写双线性采样 + RGBExp32 解码，返回**光照项**（不含 albedo）。
 *
 * 图集用 `NearestFilter`，故这里显式取 4 个最近邻纹素（坐标先 `- 0.5` 对齐纹素中心），
 * 每个先解码再 `mix`，不依赖 GPU 过滤。
 *
 * 返回值的语义：three 的 `MeshBasicMaterial` 片元里原本是
 * `lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI`，本工程把它整段换成
 * `vbsp_ApplyLightmap(...)` 的返回值，随后仍由 `reflectedLight.indirectDiffuse *= diffuseColor.rgb`
 * 乘上 albedo ⇒ **本函数的返回值就是「光照项」本身**，显示 gamma 必须在此处施加
 * （套在乘积之后会把暗部再压一个量级）。
 *
 * 分支与算式（`vbspBakedMix < 0.5` 即纯纹理模式时整条采样被跳过）：
 * `max(decoded, vbspLightFloor)` → `pow(值, 1 / max(vbspLightGamma, 0.001))` → 乘 `vbspExposure`。
 *
 * 依赖 uniform（声明见 `VBSP_LIGHTMAP_UNIFORM_DECLS`）：`vbsp_AtlasSize`、`vbspBakedMix`、
 * `vbspLightFloor`、`vbspLightGamma`、`vbspExposure`。
 */
export const VBSP_APPLY_LIGHTMAP = /* glsl */ `
vec3 vbsp_ApplyLightmap(sampler2D atlas, vec2 uv) {
	// 纯纹理模式（vbspBakedMix = 0，2026-09-21）：**整条采样直接跳过**，返回 1.0 ⇒ 调用方那行
	// indirectDiffuse += light × albedo 退化成 += albedo（外部参照实现 white 兜底口径）。
	//
	// 为什么是**运行时 uniform 分支**而不是"切模式重换材质"：uniform 分支在所有片元上一致（无 divergent
	// 波前分裂），GPU 只跑活的那一侧 ⇒ **既不采 atlas、也不算解码**，同时**零重编译、零场景重建**
	// ⇒ 面板切换不打断输入/物理，也不会让移动中的帧时间跳变（这正是面板小字承诺的语义）。
	// 反之若靠 material.lightMap = null + needsUpdate 切，要重编几百个 program（实测 1.4~2.5 s 冻结）。
	if (vbspBakedMix < 0.5) {
		return vec3(1.0);
	}
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
 * 光照项 `uniform` 声明的**唯一事实来源**。
 *
 * 三条注入路径（world lightmap / 逐顶点烘焙 / ambient cube）都在各自拼出的 GLSL 片段里
 * 引用同一批 `vbsp*` uniform，声明必须一律取自本数组，不得在任一路径里手写副本。
 * 漏改任一路径的后果不是「某个 uniform 取不到值」的软失败，而是
 * `undeclared identifier` ⇒ GLSL 编译失败 ⇒ program 无效 ⇒ 该批 mesh 一个像素都不画；
 * 几何与碰撞由 Rust 侧独立生成，因此症状是「模型看不见、碰撞正常」。
 *
 * 类型与取值来源（与各注入函数里写进 `shader.uniforms` 的对象一一对应）：
 * - `vbsp_AtlasSize: vec2` ← 逐材质新建的 `THREE.Vector2`，值 = 图集像素尺寸；
 * - `vbspExposure: float` ← `exposureUniform`；
 * - `vbspLightGamma: float` ← `lightGammaUniform`；
 * - `vbspLightFloor: float` ← `lightFloorUniform`；
 * - `vbspBakedMix: float` ← `bakedMixUniform`。
 *
 * 声明了但某条路径不赋值的 uniform（如 `applyVertexLightingShader` 不设 `vbspLightFloor`）
 * 不会被该路径生成的代码读取，GLSL 允许未使用的声明。
 */
export const VBSP_LIGHTMAP_UNIFORM_DECLS = [
	'uniform vec2 vbsp_AtlasSize;',
	'uniform float vbspExposure;',
	'uniform float vbspLightGamma;',
	'uniform float vbspLightFloor;',
	'uniform float vbspBakedMix;',
];

/**
 * ambient cube 路径在 `VBSP_LIGHTMAP_UNIFORM_DECLS` 之外**额外**需要的声明：
 * `vbspAmbCube[6]`（`vec3` 数组，值 = 6 个 `THREE.Vector3`）与
 * `vbspAmbientScale: float`（← `ambientScaleUniform`）。
 *
 * 下标含义由 `vbspAmbientRaw` 的写法固定：`0/1` = ±X、`2/3` = ±Y、`4/5` = ±Z，
 * 与 `src/wasm-core/vbsp/data/game.rs` 里 `LeafAmbientSample::cube` 的 face 序一致。
 */
export const VBSP_AMBIENT_UNIFORM_DECLS = [
	'uniform vec3 vbspAmbCube[6];',
	'uniform float vbspAmbientScale;',
];

/**
 * 第 1 级 prop 光照（逐顶点预烘焙）的几何属性名，取的是**运行期**键名。
 *
 * 导出侧写在 GLB primitive 的自定义语义 `_VBSP_VLIGHT` 上（glTF 规定自定义属性须以 `_` 开头），
 * 而 three 的 `GLTFLoader` 对未知属性名会转小写
 * （`ATTRIBUTES[ name ] || name.toLowerCase()`）⇒ 运行期键名是 `_vbsp_vlight`。
 * 这里必须是运行期名字：写成大写原样时 `getAttribute` 恒为 `null`，
 * `routeFullbright` 会整条跳过第 1 级路径。
 *
 * 写入侧见 `src/wasm-core/model_integrator/mod.rs` 的 `push_vertices`（由 `add_models_to_gltf` 调用）；
 * 读取侧见本文件的 `hasVertexLightingAttr`。
 */
export const VERTEX_LIGHTING_ATTR = '_vbsp_vlight';

// 注入用的替换锚点与替换文本。
//
// three 0.165.0 的 `meshbasic_frag` 在 `#ifdef USE_LIGHTMAP` 分支里**内联**了 lightmap 采样
// （两行源码，中间是换行 + 两个制表符），`BASIC_INLINE_LIGHTMAP_SRC` 就是这两行的原样拼接，
// 用作 `String.prototype.replace` 的锚点；替换后光照项由 `vbsp_ApplyLightmap` 提供。
//
// `CHUNK_*` 是给走 `#include <lightmap_fragment>` 的材质准备的防御性通道。
// three 0.165.0 的 `ShaderChunk` 只导出 `lightmap_pars_fragment`，没有 `lightmap_fragment`，
// 故此通道在本版本命中数恒为 0；命中数仍被统计，见 `injectLightmapShader`。
const BASIC_INLINE_LIGHTMAP_SRC =
	'vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );\n\t\treflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;';

const BASIC_INLINE_LIGHTMAP_REPLACEMENT =
	'reflectedLight.indirectDiffuse += vbsp_ApplyLightmap(lightMap, vLightMapUv);';

const CHUNK_LIGHTMAP_INCLUDE = '#include <lightmap_fragment>';
const CHUNK_LIGHTMAP_REPLACEMENT =
	'reflectedLight.indirectDiffuse += vbsp_ApplyLightmap(lightMap, vLightMapUv);';

// ---------------------------------------------------------------------------
// 输出编码：纯 γ2.2，替换 three 的分段 sRGB
// ---------------------------------------------------------------------------

/**
 * 输出编码的替换目标与替换文本（`COLORSPACE_CHUNK_NAME` / `GAMMA22_OUTPUT`）。
 *
 * three 0.165.0 的 `colorspace_fragment` 块内容是
 * `gl_FragColor = linearToOutputTexel( gl_FragColor );`，`SRGBColorSpace` 走
 * `sRGBTransferOETF` —— **分段**曲线：`x <= 0.0031308` 时 `12.92x`，否则
 * `1.055 * x^(1/2.4) - 0.055`。本工程把整块换成**纯 γ2.2**：`pow(max(rgb, 0), 1/2.2)`
 * （指数是 2.2，与 sRGB 的 2.4 不同；二者只在深暗部明显分歧）。
 *
 * 只覆盖 `ShaderChunk` 里的**块文本**，不动 `renderer.outputColorSpace`：背景 clear color
 * 仍走 three 的路径。三条注入路径与诊断档都经本文件的材质 ⇒ 覆盖面为全部受控材质。
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
 * 全局安装 γ2.2 输出编码：把 three 的 `colorspace_fragment` **块内容**整体换掉。
 *
 * 用**全局 ShaderChunk 覆盖**而不是逐材质 `onBeforeCompile` 的原因：
 * three 的 `Material.customProgramCacheKey()` 默认返回 `onBeforeCompile.toString()`，
 * 给材质新设 `onBeforeCompile` 会改变程序缓存键 ⇒ 新增着色器程序 ⇒ 首次可见时多一次编译；
 * 覆盖 ShaderChunk 只改块的文本、不碰缓存键，对全部受控材质一致生效。
 *
 * 幂等：块文本已等于 `GAMMA22_OUTPUT` 时不重复写入；`outputGamma22Enabled()` 为假时整体跳过。
 */
export function installGamma22Output(): void {
	if (!outputGamma22Enabled()) return;
	const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
	if (chunks[COLORSPACE_CHUNK_NAME] !== GAMMA22_OUTPUT) {
		chunks[COLORSPACE_CHUNK_NAME] = GAMMA22_OUTPUT;
	}
}

// 模块加载即安装：早于任何材质编译 ⇒ 首个 program 就带 γ2.2 出口。
installGamma22Output();

// ---------------------------------------------------------------------------
// 出帧对照的阶段开关（仅诊断通道读取；正常游玩取兜底值 auto）
// ---------------------------------------------------------------------------

/**
 * 出帧对照的阶段开关，读自 `globalThis.__vbspLightmapStage`。
 *
 * 正常运行时该全局不存在，`readLightmapStage()` 一律返回 `'auto'`。各值对本文件的影响：
 * - `auto`：不在 `LIGHTMAP_STAGES` 里，是读取端对「未设 / 非法值」的兜底 ⇒ 按正常逻辑注入；
 * - `off`：`applyLightmapToMeshes` 立刻返回 0，不换材质、不注入；
 * - `broken`：内联锚点换成 `BASIC_INLINE_LIGHTMAP_SRC_LEGACY_MISMATCH`，
 *   使 `applied === false` 成为**预期**结果（只告警不抛错）；
 * - `native`：`injectLightmapShader` 记下 `applied: null` 后返回，保留 three 原生 lightmap 采样；
 * - `channel0` / `channel1`：强制 lightmap UV 通道取 0 / 1，见 `resolveLightmapUvChannel`；
 * - `noinject`：材质照常替换（分块与 draw 形态与 `auto` 相同），仅跳过 shader 注入。
 *
 * 读取端用类型断言，字段缺失或不是合法字符串时视为 `auto`。
 */
export type LightmapStage =
	| 'auto'
	| 'off'
	| 'broken'
	| 'native'
	| 'channel0'
	| 'channel1'
	| 'noinject';

/** 全部合法 stage 取值（不含兜底值 `auto`）；读取端用它校验全局字段。 */
const LIGHTMAP_STAGES: readonly LightmapStage[] = [
	'off',
	'broken',
	'native',
	'channel0',
	'channel1',
	'noinject',
];

/** 读取全局阶段开关；无 `window`、字段类型不对或值不在 `LIGHTMAP_STAGES` 里都返回 `auto`。 */
export function readLightmapStage(): LightmapStage {
	const g = globalThis as { __vbspLightmapStage?: unknown };
	const v = g.__vbspLightmapStage;
	return typeof v === 'string' && (LIGHTMAP_STAGES as readonly string[]).includes(v)
		? (v as LightmapStage)
		: 'auto';
}

/** 该 stage 是否属于「跳过自定义光照」类（`native` 与 `noinject`）。 */
export function isLightmapSkipStage(stage: string): boolean {
	return stage === 'native' || stage === 'noinject';
}

/**
 * lightmap 采样应使用的 UV 通道号（正确值 = 1）。
 *
 * three 0.165.0 的 lightmap UV 通道**必须显式指定**：`WebGLPrograms.getParameters()` 里
 * `lightMapUv: HAS_LIGHTMAP && getChannel( material.lightMap.channel )`，而
 * `getChannel(v)` 在 `v === 0` 时返回 `'uv'`、否则返回 `` `uv${v}` ``；
 * `Texture.channel` 默认值是 0 ⇒ 不设置时 `LIGHTMAP_UV === 'uv'`，
 * 即 lightmap 会用漫反射 UV 采样（采到图集里别处的纹素）。
 *
 * GLB 契约里 lightmap 坐标写在 `TEXCOORD_1`（GLTFLoader r151+ 映射到 `uv1`），
 * 故取 `channel = 1` ⇒ `LIGHTMAP_UV === 'uv1'`。
 */
export const LIGHTMAP_UV_CHANNEL_CORRECT = 1;

/**
 * 解析本次运行应使用的 lightmap UV 通道。
 * `channel0` / `channel1` 两个 stage 是出帧对照的正负控开关：
 * - `channel0`：强制 0 = three 默认 = 用漫反射 uv 采样；
 * - `channel1`：强制 1 = 用 uv1 = lightmap 真坐标。
 * 其余 stage（含兜底 `auto`）一律取 `LIGHTMAP_UV_CHANNEL_CORRECT`。
 */
export function resolveLightmapUvChannel(): number {
	const stage = readLightmapStage();
	if (stage === 'channel0') return 0;
	if (stage === 'channel1') return 1;
	return LIGHTMAP_UV_CHANNEL_CORRECT;
}

/**
 * 与 `BASIC_INLINE_LIGHTMAP_SRC` 对应的**失配**字面量：把 three 源码里分行的两行拼成一行
 * （去掉了中间的换行与两个制表符）⇒ `String.prototype.replace` 命中 0 次 ⇒ 注入静默失效。
 *
 * `broken` 阶段专门用它制造「锚点失配 ⇒ 注入不生效」的对照帧，故必须保留逐字形态。
 */
const BASIC_INLINE_LIGHTMAP_SRC_LEGACY_MISMATCH =
	'vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );reflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;';

// ---------------------------------------------------------------------------
// Atlas 加载
// ---------------------------------------------------------------------------

/**
 * 从 GLB 的 lightmap extras 加载图集纹理。
 *
 * 取值顺序：`asset.extras.lightmap.textureIndex` 优先，缺失时回落到
 * `scene.userData.extras.lightmap.textureIndex`；两者都没有、或 `textureIndex < 0` 时返回 `null`。
 *
 * 拿到纹理后**就地**强制三件事（都是解码正确性的前提，改的是纹理对象本身）：
 * `colorSpace = NoColorSpace`（采样值即原始字节 / 255，不做 sRGB 解码）、
 * `minFilter` / `magFilter = NearestFilter`（避免硬件在指数域上插值）、`generateMipmaps = false`；
 * 并置 `name` 供诊断识别。
 *
 * @param parser GLTFParser（调用方传 `gltf.parser`）。
 * @param gltf GLTF 解析结果。
 * @returns 图集纹理；无 `textureIndex` 或 `parser.loadTexture` 抛错时返回 `null`
 *   （错误只 `console.error`，不向上抛；调用方在 `null` 时跳过整段光照施加）。
 */
export async function loadLightmapAtlas(
	parser: GLTFParser,
	gltf: GLTF,
): Promise<THREE.Texture | null> {
	// textureIndex 有两个可选位置：asset.extras.lightmap 与 scene.userData.extras.lightmap
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

/** 当前光照模式（模块级；`applyLightmapToMeshes` 与 `isTextureOnlyMode` 读它）。 */
let lightingMode: LightingMode = 'baked';

/**
 * 光照模式的**运行期载体**：1 = 预烘焙（吃烘焙项）、0 = 纯纹理（烘焙项恒 1.0）。
 *
 * 全场景所有注入材质共享**同一个** uniform 对象 ⇒ `setLightingMode` 改一次值即全场景生效：
 * 不重编译 program、不换材质、不重建场景。三条注入路径都读它（见 `vbsp_ApplyLightmap`、
 * `vbspVertexLightTerm`、`vbspAmbientWeight`）。
 */
const bakedMixUniform: { value: number } = { value: 1 };

/** 设置光照模式：改共享 uniform（下一次绘制即生效）+ 记模式（供 UI / 日志）。 */
export function setLightingMode(mode: LightingMode): void {
	lightingMode = mode === 'texture' ? 'texture' : 'baked';
	bakedMixUniform.value = lightingMode === 'baked' ? 1 : 0;
}

/** 当前光照模式。 */
export function getLightingMode(): LightingMode {
	return lightingMode;
}

/** 是否纯纹理模式（只有 `'texture'` 为真）。 */
export function isTextureOnlyMode(): boolean {
	return lightingMode === 'texture';
}

// ---------------------------------------------------------------------------
// 应用 lightmap 到 mesh
// ---------------------------------------------------------------------------

/**
 * 把 lightmap 施加到 `scene` 子树里的全部 mesh：逐图元路由到三条光照路径之一，
 * 并把原材质换成注入过 shader 的 `MeshBasicMaterial`。
 *
 * 处理顺序（先命中的分支接手，同一次 traverse 里后续判据不再看该 mesh）：
 * 1. `readLightmapStage() === 'off'` ⇒ 整个函数立刻返回 0（不换材质、不注入、不改UV）；
 * 2. `geometry.userData.hasLightmap`（缺失时回落 `mesh.userData.hasLightmap`）为 `false`
 *    或 `undefined` ⇒ `routeFullbright`，计入 `noLightmapRouted`；
 * 3. 既无 `uv1` 也无 `uv2` ⇒ `routeFullbright`，同样计入 `noLightmapRouted`；
 * 4. 其余（有 lightmap UV）⇒ 建/复用注入材质并换上，`applied` 加一，并把
 *    `atlasTexture.channel` 写成 `resolveLightmapUvChannel()`（同一对象、同值，幂等）；
 * 5. 第一次 `traverse` 结束后再扫一遍场景：材质类型仍不是 `MeshBasicMaterial` 的 mesh
 *    （GLTFLoader 给 prop / 派生网格的 `MeshStandardMaterial` 等）一律走 `routeFullbright`，
 *    计入 `fallbackRouted`。
 *
 * 材质去重：参数相同（map / color / transparent / opacity / alphaTest / side / depthWrite /
 * alphaMap / 线框标记 / 诊断档）时复用同一材质实例，使 `optimizeScene` 按材质实例分组的合并
 * 仍然成立。带 ambient cube 的 prop 是例外——cube 是逐 prop 的 uniform，必须逐 mesh 建材质。
 *
 * 边界：`atlasTexture` 为 `null` 时本函数自身不判空；三个调用点都在 `loadLightmapAtlas`
 * 返回 `null` 时提前返回，故第 4 步执行时它非空。
 *
 * @param scene 只用到 `traverse`，故类型放宽到 `Object3D`：debug 传 `THREE.Scene`，
 *   viewer 传自己的模型根 Group。
 * @param atlasTexture lightmap 图集纹理（来自 `loadLightmapAtlas`）。
 * @returns 换上注入材质（第 4 步）的 mesh 数；`off` 阶段恒为 0。
 */
export function applyLightmapToMeshes(
	scene: THREE.Object3D,
	atlasTexture: THREE.Texture | null,
): number {
	// 负控阶段 `off`：完全不施加 lightmap（不换材质、不注入）——
	// 用于出帧对照证明「黑屏确由 lightmap 缺失造成」。
	if (readLightmapStage() === 'off') {
		console.warn('[lightmap] stage=off（负控）：跳过 lightmap 施加，画面预期回到无烘焙光照状态');
		return 0;
	}
	// `off` 不可比：它连材质都不换（分块与 draw 与其余帧不同），不能充当「移除注入 ⇒ 应变暗」
	// 的负控；该负控由 `noinject` 承担（材质照换、仅跳过注入，见下方注入处）。
	const isNoInjectStage = readLightmapStage() === 'noinject';

	// 两种光照模式在这里走同一条路：材质一律按「带烘焙项」构建并注入，模式差异只由共享
	// uniform `vbspBakedMix` 在片元里决定（纯纹理时烘焙项分支直接返回 1.0）。
	// 不按模式分叉建材质的原因：分叉后纯纹理模式的材质没有注入，面板切回预烘焙只能重建场景。

	const atlasW = (atlasTexture?.image?.width as number) || 0;
	const atlasH = (atlasTexture?.image?.height as number) || 0;
	const atlasSize = new THREE.Vector2(atlasW, atlasH);

	let applied = 0;
	// fullbright 统一路径计数：无 lightmap 的图元换 Basic、输出贴图原色。
	let fullbright = 0;

	// ── 材质去重（性能关键）────────────────────────────────────────────────
	// `optimizeScene` 的块内合并按**材质实例恒等**分组（`new Map<THREE.Material, …>`）⇒
	// 若每个 mesh 各拿一个新材质实例，合并完全失效。因此把「参数完全相同」的新材质
	// 复用同一实例（同 map / color / transparent / opacity / alphaTest / side / depthWrite /
	// alphaMap / 线框标记 / 诊断档位），让按材质合并重新成立。
	//
	// 例外：带 ambient cube 的 prop —— cube 是**逐 prop 的 uniform**（`vbspAmbCube`），
	// 材质不可复用，必须逐 mesh（见 `applyAmbientCubeIfAny`）。
	const lightmappedCache = new Map<string, THREE.MeshBasicMaterial>();
	const fullbrightCache = new Map<string, THREE.MeshBasicMaterial>();
	/**
	 * 第 1 级（逐顶点预烘焙）材质的**共享**缓存。
	 * 光照数据在**几何属性** `_VBSP_VLIGHT` 上 ⇒ 这类 mesh 共用同一材质实例是安全的。
	 * 必须与 `fullbrightCache` 分开：没有该属性的 mesh 若共用它，属性会读成全 0（渲成黑）。
	 */
	const vertexLightingCache = new Map<string, THREE.MeshBasicMaterial>();
	/** 走第 1 级（逐顶点烘焙）的 mesh 数（诊断口径）。 */
	let vertexLightingRouted = 0;
	/** 因 `hasLightmap !== true`（只有中性占位 UV）而改走 fullbright 的图元数（诊断口径）。 */
	let noLightmapRouted = 0;

	/**
	 * fullbright 的**唯一收敛点**（三个入口共用：`hasLightmap !== true` / 无 lightmap UV /
	 * 装配后终扫兜底）。
	 *
	 * 三级优先：
	 * 1. `extras.unlit === true` ⇒ 贴图原色，不吃任何光照（跳过 ambient cube）；
	 * 2. 几何带 `_VBSP_VLIGHT` 且未被 `window.__vbspVertexLightingOff` 关掉
	 *    ⇒ 第 1 级逐顶点烘焙，材质可全场景共享（数据在几何上，不需要逐 prop uniform）；
	 * 3. 否则走第 2 级 leaf ambient cube（逐 prop uniform ⇒ 材质不可复用）；
	 *    cube 不可用时退到共享材质，保住 `optimizeScene` 的按材质合并。
	 *
	 * 本函数只在 `traverse` 回调里被调用，晚于其后定义的 `hasVertexLightingAttr` /
	 * `reconstructVertexLighting` / `acquireVertexLightingMaterial` 的初始化。
	 */
	const routeFullbright = (mesh: THREE.Mesh): void => {
		const unlit = isUnlit(mesh);
		if (!unlit && hasVertexLightingAttr(mesh) && !readVertexLightingOff()) {
			// 第 1 级：逐顶点预烘焙（数据在几何上 ⇒ 材质全场景共享）。
			// 必须**显式赋值**给 mesh：`acquire*` 只建/取缓存实例，不做赋值
			// （只有 `applyFullbrightBasic` 内部赋值）。漏赋值 ⇒ 该 mesh 仍持旧材质。
			reconstructVertexLighting(mesh);
			mesh.material = acquireVertexLightingMaterial(mesh);
			vertexLightingRouted++;
			fullbright++;
			return;
		}
		const rawCube = unlit ? undefined : resolveAmbientCube(mesh);
		// 第 2 级：leaf ambient cube（逐 prop uniform ⇒ 材质不可复用）。
		// 数据侧补偿：cube 的 18 个分量逐个乘 `effectivePropCubeGain()`（默认 `PROP_CUBE_GAIN`），
		// 只在长度恰为 18 时做，否则原样传给 `applyAmbientCubeIfAny` 由其判为 miss。
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

	/** 几何是否带第 1 级逐顶点烘焙属性（值来自 GLB 的 `_VBSP_VLIGHT`，见 `VERTEX_LIGHTING_ATTR`）。 */
	const hasVertexLightingAttr = (mesh: THREE.Mesh): boolean => {
		const g = mesh.geometry as THREE.BufferGeometry | undefined;
		return !!g && !!g.getAttribute && !!g.getAttribute(VERTEX_LIGHTING_ATTR);
	};

	/** 已做过重建的几何（同一 geometry 只重建一次）。 */
	const reconstructedGeoms = new WeakSet<THREE.BufferGeometry>();
	/** 已做过方差压缩的**属性**（多 primitive 共享同一份缓冲 ⇒ 按属性去重而非按 geometry）。 */
	const flattenedAttrs = new WeakSet<THREE.BufferAttribute>();
	/** 重建统计（模块级，供 `getVertexLightingRelaxStats()` 读出）。 */
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
	 * 适用面：烘焙值只落在**网格顶点**上，大三角形内部由 Gouraud 插值给出大段线性渐变，
	 * 三角形之间只有 C0 连续 ⇒ 逐顶点场的分布与真实光照不一致时，观感是"一块一块的色阶"。
	 *
	 * 三步（都不改 pakfile 数据，只改渲染用的几何属性；`propVertexRelax = 0` 时整体跳过）：
	 * 1. **接缝焊接**：位置相同且法线相同的顶点是同一个着色点（UV 接缝复制），
	 *    按点烘焙本应给同一个值 ⇒ 取均值。
	 * 2. **空间鲁棒滤波**（`propVertexRelax ≥ 1`，默认开）：与"同法线的 2 环空间邻域"的
	 *    中位数相差超过 `MEDIAN_THRESHOLD` 的顶点，判为与邻域不一致并拉回中位数；
	 *    未判不一致的顶点一个都不动。邻域要求法线同向（`dot > 0.9`）。
	 * 3. **Laplacian 松弛**（`propVertexRelax ≥ 3`）：更"平"，但会整体偏离烘焙值，
	 *    属口味档（次数由 `propVertexRelaxPasses` 决定）。
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
		// 判据：同法线（`dot > 0.9`）的 2 环邻域中位数与当前顶点的 Luma 相差超过
		// `MEDIAN_THRESHOLD` ⇒ 该顶点不可信，拉回中位数（未超阈值的顶点不动）。
		// 邻域用**索引图 2 环**（O(E)，不做事先的空间哈希），
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
		// 本步把场写成 `mean + (1-flatten)×(v-mean)`：均值严格不变，只有方差被压。
		// flatten=1 等价于"该 prop 均匀受光"。逐顶点场"量级对、分布错"时，
		// 观感是"一块一块的色阶"，本步正是压这个分布。
		const flattenRaw = readPropVertexFlatten();
		const flatten = Number.isFinite(flattenRaw) ? Math.min(1, Math.max(0, flattenRaw)) : 0;
		if (flatten > 0 && !flattenedAttrs.has(attr)) {
			// ⚠️ **按 prop 自适应**：全局压方差会把面内本来就一致的正常 prop 一起改掉。
			// 判据用**面内**亮度差（Luma 的 max-min，取全体三角形的**中位数**）：
			//   · 面内不一致（条纹型，该压）⇒ medianTri ≥ `PROP_FLATTEN_MIN_TRI_DELTA`（0.10）⇒ 压平
			//   · 面间差异大但面内一致（正常）⇒ medianTri 低于阈值 ⇒ `flattenSkipped++`，保留原样
			// ⚠️ 判别必须在**原始烘焙值**（`before` 快照）上做：本函数第②步的鲁棒滤波会把离群顶点
			// 拉回邻域中位数，若在它之后判别，条纹型 prop 会被误判为"面内一致"而全部跳过压平。
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
				// 按**属性**去重（`flattenedAttrs`）：glTF 多 primitive 共享同一份顶点缓冲
				// （三个材质三条索引），若按 geometry 去重会跑 3 次、每次用自己的索引范围均值
				// ⇒ **最后写入者获胜**。
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

		// `extras.hasLightmap === false` 表示该图元只有中性占位 UV，不得施加 lightmap。
		//
		// ⚠️ **判据必须从 `geometry.userData` 读，不能只读 `mesh.userData`** ✓：
		// GLTFLoader 对 **primitive** 的 extras 走 `assignExtrasToUserData( geometry, primitiveDef )`
		// ⇒ `extras.hasLightmap` 落在 **geometry.userData** 上；
		// mesh 级 extras 只承载 meshDef 的 extras，与 primitive 的 extras 不同源。
		// ⇒ 只读 `mesh.userData.hasLightmap` 时该值为 `undefined`，本分支恒不命中。
		// 后果不是"少一次优化"：中性占位 UV 的图元会带着 `uv1` 落进下方的施加分支，
		// 以 uv=(0,0) 采图集**同一个像素**，整面塌成图集原点那一色。
		// 故两处都读（geometry 优先），使判据在 primitive 级与 mesh 级 extras 上都成立。
		const hlGeom = (geom.userData as { hasLightmap?: unknown } | undefined)?.hasLightmap;
		const hlMesh = (mesh.userData as { hasLightmap?: unknown }).hasLightmap;
		const hasLightmap = hlGeom !== undefined ? hlGeom : hlMesh;
		if (hasLightmap === false || hasLightmap === undefined) {
			// 占位 UV 面 ⇒ 外部参照实现口径：white 兜底 = 贴图原色 fullbright
			// prop 图元带 node extras.ambientCube（leaf ambient cube，见 vbsp::prop_ambient_cube）
			// ⇒ 在 fullbright 基础上用法线加权混合 6 面 cube（外部参照实现 StudioModel 同语义）
			// ⚠️ ambient cube 是**逐 prop 的 uniform**（`vbspAmbCube`）⇒ 有 cube 的 prop 材质
			// 必须逐 mesh（不可复用）；无 cube 才能用共享材质，否则 optimizeScene 合并不成立。
			// 自发光/无光照材质（extras.unlit）**不吃环境光**：跳过 ambient 相乘 ⇒ 全亮贴图原色
			//
			// ⚠️ **`hasLightmap === false` 必须在「检测 uv1 / uv2」之前判**：
			// `src/wasm-core/bsp_to_gltf_core/convert.rs` 的 `push_bsp_face_bsp` 对
			// `lightmap_region == None`（`light_offset == -1`，判据在
			// `src/wasm-core/bsp_to_gltf_core/lightmap.rs` 的 `build_atlas`）的面**照样写
			// `TEXCOORD_1`**，但每个顶点的值是**中性常量 (0,0)**，只为保住
			// `mergeGeometries(geoms, true)` 的属性集一致 ⇒ 这类图元带 `uv1`。
			// ⇒ 把判据放到 uv 检测之后时，这些面全部以 uv=(0,0) 采图集**同一个像素**，
			// 整面塌成图集原点那一色；判据置于其前才拦得住。
			// ⚠️ 判据必须从 `geometry.userData` 读，不能只读 `mesh.userData` ✓：
			// GLTFLoader 对 **primitive** 的 extras 走 `assignExtrasToUserData( geometry, primitiveDef )`
			// ⇒ `extras.hasLightmap` 落在 **geometry.userData** 上；
			// mesh 级 extras 只承载 meshDef 的 extras，与 primitive 的 extras 不同源。
			// ⇒ 只读 `mesh.userData.hasLightmap` 时该值为 `undefined`，本分支恒不命中。
			// 故两处都读（geometry 优先），使判据在 primitive 级与 mesh 级 extras 上都成立。
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

		// UV 通道：**不复制 uv1 → uv2**。
		//
		// 原写法 `geom.setAttribute('uv2', geom.getAttribute('uv1'))` 有两个问题：
		// 1. **多余**：three r151+ 的 lightMap UV 由 `material.lightMap.channel` 决定
		//    （`getChannel(0)='uv'`、`getChannel(1)='uv1'`），不是写死的 `uv2` ⇒ 只要把
		//    `atlasTexture.channel` 设为 1，就直接读 `uv1`，无需 `uv2`（见 loadLightmapAtlas）。
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
			// `Wireframe` 着色器标记：线框与实体面不能共用同一个替换材质
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
			// 为什么需要它：`off` 阶段在函数开头就 `return 0`，连材质都不换 ⇒ 场景构成与其余帧
			// 不同（mesh 数与 draw 调用数都变了）⇒ **与原帧不可比** ✗，
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
		// 构造器里的 `lightMap: readDebugAlbedoOnly() ? null : atlasTexture` 是**唯一真源**，
		// 回写会使 `--debug-albedo` 的 null 失效 ⇒ 该帧走 three 原生 lightmap 分支而不是
		// 只输出 albedo：采到的是**未解码的 RGBExp32 尾数字节**
		// （原生式 `lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI`）。
		// 后果落在出帧分解上：该帧成为 `temp/factor-decompose.mjs` 的分母，分母被压暗
		// π/m 倍（原生项含 `RECIPROCAL_PI = 1/π`，而 albedo-only 项是余弦加权的 `m ≈ 1`）
		// ⇒ 商被等比抬高，量出「有效系数 ≈ 1」的假象。
		// 该帧与 `--stage noinject` 在构造上等价（同为原生分支、同样跳过注入），
		// 故二者逐桶一致不能充当负控生效的证据。
		// 纯纹理模式 / 无 atlas 时这里根本不会走到（上方已提前 routeFullbright）。
		atlasTexture!.channel = resolveLightmapUvChannel();

		mesh.material = newMat;
		applied++;
	});

	// ── 兜底：未被上面任何分支接管的图元不得保留原材质 ──
	//
	// 上面三条分支覆盖的是 `hasLightmap === false` / `=== true`（且带 uv1）/ 无 uv1&uv2。
	// 但 GLB 里还有一类：`extras.hasLightmap` **完全缺失**（`undefined`）**且带 uv1** ——
	// 例如从 prop 模型导出的自发光霓虹（`extras.unlit=true`）与部分无贴图的派生网格。
	// 它们会从三个分支**全部漏下去**，原样保留 GLTFLoader 给的 `MeshStandardMaterial`。
	// 而本工程**不加任何灯**（三点光与 punctual 灯都被刻意中和）⇒ `MeshStandardMaterial`
	// 在没有灯/环境贴图时只剩 `emissive`，GLB 里该值是 `[0,0,0]` ⇒ 这些图元**恒渲染成纯黑**。
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
 * 为什么必须有这一层：`applyLightmapToMeshes` 的三条分支 + 其内部兜底
 * 跑在「GLB 刚挂载」这一刻；而 GLTFLoader 对 **prop 模型**（`extras.unlit=true` 的霓虹/发光）与
 * 部分派生网格给的是 `MeshStandardMaterial`，在该时刻取不到可用的 `hasLightmap`/UV 判据，
 * 会整批漏过。本工程**刻意不加任何灯**（三点光与 punctual 灯全部中和）⇒ 这些材质只剩
 * `emissive`（GLB 里是 `[0,0,0]`）⇒ **恒渲染成纯黑**。
 * 本层在装配完成后重扫一次场景，按**材质类型**（非 `MeshBasicMaterial`）而非 extras 判据收敛，
 * 故与上述时点无关。
 *
 * 口径与 `applyLightmapToMeshes` 的 fullbright 路径一致：保留原 `map`/`color`/`transparent`/`opacity`，
 * `extras.unlit` 的图元不吃 ambient cube（Source `UnlitGeneric` 语义），其余按需乘 cube。
 *
 * @returns 被收敛的 mesh 数（0 = 无需处理）。
 */
export function fullbrightUnlitLitMaterials(scene: THREE.Object3D): number {
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
			// 材质渲染状态只有 `copyMaterialRenderState` 一个拷贝入口，三个替换点都必须走它；
			// 手抄字段的写法会漏掉 `side`/`depthWrite`/`alphaTest`/`userData.vbsp_wireframe`。
			// 例：Source `Wireframe` 着色器的世界图元在 GLB 里带 `userData.vbsp_wireframe=true`，
			// 材质丢掉该标记就保持 `wireframe=false`，线框面被画成实心面。
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
 * 为什么必须有它：两处 `replace` 各自统计命中数，并把结果写进
 * `material.__vbspLightmapInject`；命中为 0 时 `console.error` 明确报出——
 * 字面量失配 ⇒ 注入未生效 ⇒ 片元仍走 three 原生采样路径。
 * 只打「[lightmap] 施加 mesh=N」这条成功日志时，命中 0 与命中 1 的输出完全相同。
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
		// 模式开关的运行期载体（全场景共享同一对象，见 `bakedMixUniform`）
		shader.uniforms.vbspBakedMix = bakedMixUniform;
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
			// 既非成功也非失败。留 `undefined` 时下游的
			// `if (rec.applied) … else 记为失效` 会把它误判成"注入失效"并打假 error，
			// 故这里显式给 `null`。
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
			// 字面量失配只让片元回落到原生采样路径（画面压暗、日志仍打成功），
			// 故此处除写 `__vbspLightmapInject` 外还置 `__vbspLightmapInjectFailed` 并抛错：
			// 除 `broken`（预期失败）外一律抛，使调用方/出帧脚本**非零退出**，
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
 * 无 lightmap 图元的 fullbright 统一路径。
 * 外部参照实现对无 lightmap 的世界面用 white texture 兜底（其 `uLightmap.setDefault(getWhiteTexture)`，
 * 符号见 `Shaders/LightmappedBase.ts`）⇒ 最终色 = 贴图原色。本工程对应实现：
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
 * 为什么必须有它：三个替换点（`applyFullbrightBasic` / `acquireFullbrightMaterial` /
 * `acquireVertexLightingMaterial`）都以本函数为**唯一**状态拷贝入口；逐字段手抄时下列状态会丢失，
 * 而每一项都对应一个可见的几何/深度/混合后果：
 *
 * | 未拷贝的字段 | 代码事实与后果 |
 * |---|---|
 * | `alphaTest` | 保持 `MeshBasicMaterial` 默认 0 ⇒ `alphaTest > 0` 的 MASK 材质（镂空贴图）整块变实心 |
 * | `alphaMap` | 保持 `null` ⇒ alpha 走独立贴图时抠图失效 |
 * | `side` | 保持 `FrontSide` ⇒ 原 `DoubleSided` 的图元从背面不可见 |
 * | `depthWrite` / `depthTest` | 保持 three 默认值 ⇒ 半透明图元的排序/遮挡关系改变 |
 * | `blending` | 保持 `NormalBlending` ⇒ 原有加色/乘算混合失效 |
 * | `polygonOffset*` | 保持关闭 ⇒ 贴花/共面图元的 z-fighting 防护失效 |
 * | `userData` | 浅拷整块（含 `extras.unlit` 与 `extras.vbsp_wireframe`），供 `isUnlit()` 与线框复现读取 |
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
	// 不置 `wireframe` 时该图元按实心面绘制。
	if ((src.userData as { vbsp_wireframe?: boolean } | undefined)?.vbsp_wireframe) {
		dst.wireframe = true;
	}
	// `alphaTest > 0` 时 three 需要 `transparent` 与材质的 alphaTest 语义配合：
	// glTF 的 MASK 材质是 `transparent=false` + `alphaTest=cutoff`（GLTFLoader 的赋值形态），
	// 这里保持原样即可（three 对 alphaTest 的处理与 transparent 独立）。
}

/**
 * **第 1 级 prop 光照**：逐顶点预烘焙（VRAD 的 `sp_<idx>.vhv`）→ 几何属性 `_VBSP_VLIGHT`。
 *
 * ## 为什么必须有它
 *
 * 第 2 级（leaf ambient cube）是**每 prop 一个值**、再按法线平方加权取面 ⇒ 模型的每个朝向面
 * 各得一个**平坦**颜色（"一面一个颜色"），而外部参照实现走的是**逐顶点**烘焙值：
 * 它的几何处理读 pakfile 的 `sp_<i>.vhv` 写成顶点色，再由 `Shaders/VertexLitGeneric.ts` 的
 * `mainSample.rgb * vVertexLighting` 还原。
 *
 * ## 口径（与外部参照实现逐项对齐）
 *
 * 外部参照实现：`屏幕 = 纹理色 × vVertexLighting`（`vVertexLighting = floor(byte) * 2/255`，
 * 导出侧已按此换算成 [0,2] 的 f32 写进属性）。
 * 本工程：`屏幕 = 纹理色 × 光照项^(1/2.2)`（末端 `colorspace_fragment` 被换成纯 γ2.2 编码）
 * ⇒ 令 `光照项^(1/2.2) = vVertexLighting` ⇒ **`光照项 = vVertexLighting^2.2`**。
 *
 * 面板两个旋钮在此路径上的语义与 world 路径一致：
 * `光照项 = pow(vLight, 2.2/γ) × 曝光`（γ=1、曝光=1 时即平价；见 `vbspVertexLightTerm`）。
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
		shader.uniforms.vbspBakedMix = bakedMixUniform;
		// 声明必须来自共享常量（守卫断言"注入单元自洽"）
		const decls = VBSP_LIGHTMAP_UNIFORM_DECLS.join('\n');
		// ⚠️ 这个数组进的是 **fragment** shader ⇒ **不能出现 `attribute`**
		// （GLSL 里 `attribute` 仅限 vertex 阶段，出现在 fragment 里时编译报
		//  `'attribute' : Illegal use of reserved word` ⇒ program 无效 ⇒ 模型不渲染）。
		// 属性声明只在下面的 vertex 侧 `vsA` 里出现。
		const fn = [
			'varying vec3 vbspVLight;',
			'vec3 vbspVertexLightTerm() {',
			// 纯纹理模式：逐顶点烘焙项恒 1.0（= 贴图原色），与 world 路径同一开关语义
			'	if (vbspBakedMix < 0.5) { return vec3(1.0); }',
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
 * 因为 cube 是"每 prop 一个值"，无法表达逐顶点梯度（即"一面一个颜色"）。
 */
function applyAmbientCubeIfAny(mesh: THREE.Mesh, mat: THREE.MeshBasicMaterial): void {
	// cube 写在 **node extras** 上（`src/wasm-core/model_integrator/mod.rs` 里把
	// `ambient_cube` 写成 `extras.ambientCube` 的那一段），而 multi-primitive 的
	// prop 被 GLTFLoader 包成 Group，extras 落在 Group 而非子 Mesh ⇒ 必须向上回溯，
	// 否则 `resolveAmbientCube` 恒取不到 cube（= 纯 fullbright）。
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
		shader.uniforms.vbspBakedMix = bakedMixUniform;
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
			// ⚠️ 声明必须来自共享常量（**不是**手写副本）：本路径的 `vbspAmbientWeight()`
			// 读了 `vbspLightFloor`，手写声明时漏掉它 ⇒ fragment 编译失败 ⇒ 带 cube 的 prop
			// 与水/远地面**全部不渲染**（症状：模型完全透明但有碰撞）。
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
			// ⚠️ 显示 gamma 只能套在**光照项**上（与 `vbsp_ApplyLightmap` 同因）：
			// `reflectedLight.indirectDiffuse *= diffuseColor.rgb` 之后，indirectDiffuse 已含 albedo，
			// 若在那里再 `pow()` 就等于 gamma 套在「albedo × light」的乘积上 —— 暗部会被额外压低一个量级，
			// 下限也救不回（`exposure` 拖到很大时暗处仍为 0）。故此处只把**光照**做 `^(1/γ)`，albedo 留给上面那行乘。
			"vec3 vbspAmbientWeight() {",
			// 纯纹理模式：ambient cube 项恒 1.0（不吃烘焙光照），与另两条路径同一开关
			"	if (vbspBakedMix < 0.5) { return vec3(1.0); }",
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
const LIGHTMAP_EXPOSURE_DEFAULT = 1;

const exposureUniform = { value: readExposureOverride() ?? LIGHTMAP_EXPOSURE_DEFAULT };

/**
 * 光照项 gamma（shadow-lift）。1.0 = 不修正（纯线性域）。
 * <1 抬高暗部、亮部基本不动；用来对齐外部参照实现的 γ2.2 域乘算。
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
 * 触发「方差压缩」的最小**面内**亮度差（中位数，lightitem 量纲 0..2）。
 *
 * 判据：`medianTri` 低于它时记为 `flattenSkipped` 并保留原样烘焙值，否则压平。
 * `medianTri` 取每个三角形三个顶点 Luma 的 max-min、再对全体三角形取中位数，
 * 故"面间差异大但面内一致"的正常 prop 落在阈值以下、不被改动。
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
 * 均值严格不变、只压方差。1 = 该 prop 均匀受光（逐顶点梯度被完全抹平），
 * 0 = 保留烘焙值的原始分布。
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
	// 会把注入值立刻冲回 `LIGHTMAP_EXPOSURE_DEFAULT`，使 A/B 各档落在同一帧。
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
