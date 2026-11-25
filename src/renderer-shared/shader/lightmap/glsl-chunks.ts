import { SPOT_MAX, DLIGHT_MAX } from './dynamic-lights.js';

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

/**
 * three r165 `envmap_fragment` chunk 的**原始 include 锚点**。
 *
 * ⚠️ `onBeforeCompile` 拿到的是**尚未展开 `#include` 的原始源码**（`resolveIncludes` 发生在
 * 更后面的 `WebGLProgram` 里）⇒ 要改 envmap 必须替换这条 `#include`，**不能**去匹配 chunk
 * 展开后的 `outgoingLight += envColor.xyz * ...`——那条字符串在注入阶段根本不存在，
 * `String.replace` 会**静默无操作**。（曾因此做过一次无效修复：洞内坡体依旧惨白、无明暗。）
 */
const ENVMAP_INCLUDE_SRC = '#include <envmap_fragment>';

/**
 * 替换用：与 three 的 chunk 同构，但**把反射项乘上本路径的光照项**（Source 语义）。
 *
 * 为什么必须调制：`outgoingLight = reflectedLight.indirectDiffuse` 之后才执行 envmap，
 * 而本文件给 `indirectDiffuse` 乘的 `vbspVertexLightTerm()` / `vbspAmbientWeight()`
 * **管不到它**。不调制 ⇒ `$envmap` 以**均匀天空常量**叠加。
 *
 * 实测（surf_boreas，`__vbspEnvMapAll=0` A/B）：带 `$envmap` 的 prop
 * （`ice_transparent`，`$envmaptint` 0.66 ⇒ `applyReflectionEnvMap` 里
 * `reflectivity = min(0.5, 0.66 × 0.35) = 0.231`）在洞内叠加出 **≈0.35** 的常量项，
 * 而同一体素的烘焙项只有 **≈0.004**（线性）⇒ **envmap 是烘焙值的 ~90 倍**，
 * 把逐顶点明暗完全盖住；又因反射源是均匀白天空、`MeshBasicMaterial` 的 `specularStrength`
 * 也不随法线变 ⇒ 洞内坡体 / 冰锥渲染成一块**死亮、毫无明暗变化的板子**。
 * A/B 关掉 envmap 后均值 171.3 → 134.1，木纹与明暗渐变恢复。
 *
 * 仅覆盖实际用到的两个分支（`applyReflectionEnvMap` 固定 `AddOperation`）。
 */
const ENVMAP_MODULATED = (termExpr: string): string =>
	[
		'#ifdef USE_ENVMAP',
		'\tvec3 reflectVec = vReflect;',
		'\t#ifdef ENVMAP_TYPE_CUBE',
		'\t\tvec4 envColor = textureCube( envMap, envMapRotation * vec3( flipEnvMap * reflectVec.x, reflectVec.yz ) );',
		'\t#else',
		'\t\tvec4 envColor = vec4( 0.0 );',
		'\t#endif',
		'\t#ifdef ENVMAP_BLENDING_MULTIPLY',
		'\t\toutgoingLight = mix( outgoingLight, outgoingLight * envColor.xyz, specularStrength * reflectivity * ' +
			termExpr +
			' );',
		'\t#elif defined( ENVMAP_BLENDING_ADD )',
		'\t\toutgoingLight += envColor.xyz * specularStrength * reflectivity * ' + termExpr + ';',
		'\t#endif',
		'#endif',
	].join('\n');

// 注入用的替换锚点与替换文本。
//
// three 0.165.0 的 `meshbasic_frag` 在 `#ifdef USE_LIGHTMAP` 分支里**内联**了 lightmap 采样
// （两行源码，中间是换行 + 两个制表符），`BASIC_INLINE_LIGHTMAP_SRC` 就是这两行的原样拼接，
// 用作 `String.prototype.replace` 的锚点；替换后光照项由 `vbsp_ApplyLightmap` 提供。
//
// `CHUNK_*` 是给走 `#include <lightmap_fragment>` 的材质准备的防御性通道。
// three 0.165.0 的 `ShaderChunk` 只导出 `lightmap_pars_fragment`，没有 `lightmap_fragment`，
// 故此通道在本版本命中数恒为 0；命中数仍被统计，见 `injectLightmapShader`。
// ---------------------------------------------------------------------------

const SPOT_FRAG_DECLS = `
uniform int vbspSpotCount;
uniform vec3 vbspSpotPos[${SPOT_MAX}];
uniform vec3 vbspSpotDir[${SPOT_MAX}];
uniform vec3 vbspSpotColor[${SPOT_MAX}];
uniform float vbspSpotRange[${SPOT_MAX}];
uniform float vbspSpotCosOuter[${SPOT_MAX}];
uniform float vbspSpotCosInner[${SPOT_MAX}];
uniform float vbspSpotScale;
uniform int vbspDLightCount;
uniform vec3 vbspDLightPos[${DLIGHT_MAX}];
uniform vec3 vbspDLightColor[${DLIGHT_MAX}];
uniform float vbspDLightRange[${DLIGHT_MAX}];
uniform float vbspDLightScale;
varying vec3 vbspSpotWPos;

vec3 vbspSpotLight(vec3 P) {
	if (vbspSpotCount <= 0 && vbspDLightCount <= 0) return vec3(0.0);
	vec3 N = normalize(cross(dFdx(P), dFdy(P)));
	vec3 V = normalize(cameraPosition - P);
	vec3 sum = vec3(0.0);
	for (int i = 0; i < ${SPOT_MAX}; i++) {
		if (i >= vbspSpotCount) break;
		vec3 toL = vbspSpotPos[i] - P;
		float d = length(toL);
		if (d <= 0.001 || d > vbspSpotRange[i]) continue;
		vec3 L = toL / d;
		float ndl = abs(dot(N, L));
		float att = 1.0 - d / vbspSpotRange[i];
		att *= att;
		float cd = dot(-L, vbspSpotDir[i]);
		float cone = smoothstep(vbspSpotCosOuter[i], vbspSpotCosInner[i], cd);
		// 近场散射/泛光：贴近车体或墙面安装的灯具对外照射时，对灯座周围表面仍有近距离漫反射与掠射反光。
		float spillR = min(vbspSpotRange[i] * 0.22, 95.0);
		float near = clamp(1.0 - d / spillR, 0.0, 1.0);
		float spill = near * near * (0.28 + 0.52 * ndl) * 0.75;
		float contrib = max(att * cone * ndl, spill);
		if (contrib <= 0.001) continue;
		vec3 H = normalize(L + V);
		float nh = abs(dot(N, H));
		float nh2 = nh * nh;
		float nh4 = nh2 * nh2;
		float sheen = nh4 * nh4 * nh4 * 0.45;
		sum += vbspSpotColor[i] * (contrib * (1.0 + sheen));
	}
	for (int i = 0; i < ${DLIGHT_MAX}; i++) {
		if (i >= vbspDLightCount) break;
		vec3 toL = vbspDLightPos[i] - P;
		float d = length(toL);
		if (d <= 0.001 || d > vbspDLightRange[i]) continue;
		vec3 L = toL / d;
		float att = 1.0 - d / vbspDLightRange[i];
		sum += vbspDLightColor[i] * (att * att * abs(dot(N, L)) * vbspDLightScale);
	}
	// 软上限：spot 是加法光，白贴图上直接叠很容易过曝成纯白（观感像闪光灯）。
	// 这里限幅到 0.55，保留亮斑又不会把材质细节烧掉。
	return min(sum * vbspSpotScale, vec3(0.55));
}
`;

const SPOT_VERT_DECL = 'varying vec3 vbspSpotWPos;\n';

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
/**
 * 与 `BASIC_INLINE_LIGHTMAP_SRC` 对应的**失配**字面量：把 three 源码里分行的两行拼成一行
 * （去掉了中间的换行与两个制表符）⇒ `String.prototype.replace` 命中 0 次 ⇒ 注入静默失效。
 *
 * `broken` 阶段专门用它制造「锚点失配 ⇒ 注入不生效」的对照帧，故必须保留逐字形态。
 */
const BASIC_INLINE_LIGHTMAP_SRC_LEGACY_MISMATCH =
	'vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );reflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;';
// ---------------------------------------------------------------------------
// 雾密度上限（`env_fog_controller` 的 `fogmaxdensity`）
// ---------------------------------------------------------------------------

/** three 线性雾分支里那句的唯一可定位片段（短串，不依赖缩进形式）。 */
const FOG_SMOOTHSTEP = 'float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );';

/** 夹取版：只在编译期定义了 `FOG_MAX_DENSITY` 的程序里生效，其余走 `#else` 原式。 */
const FOG_SMOOTHSTEP_CAPPED =
	'#ifdef FOG_MAX_DENSITY\n\t\tfloat fogFactor = min( smoothstep( fogNear, fogFar, vFogDepth ), FOG_MAX_DENSITY );\n#else\n\t\tfloat fogFactor = smoothstep( fogNear, fogFar, vFogDepth );\n#endif';
export {
  ENVMAP_INCLUDE_SRC, ENVMAP_MODULATED, SPOT_FRAG_DECLS, SPOT_VERT_DECL,
  BASIC_INLINE_LIGHTMAP_SRC, BASIC_INLINE_LIGHTMAP_REPLACEMENT, CHUNK_LIGHTMAP_INCLUDE,
  CHUNK_LIGHTMAP_REPLACEMENT, COLORSPACE_CHUNK_NAME, GAMMA22_OUTPUT,
  BASIC_INLINE_LIGHTMAP_SRC_LEGACY_MISMATCH, FOG_SMOOTHSTEP, FOG_SMOOTHSTEP_CAPPED,
}
