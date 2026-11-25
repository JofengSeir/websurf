import * as THREE from 'three';
import type { GLTF, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { registerInjection } from '../injection-registry.js';
import { outputGamma22Enabled } from '../../scene/render-context.js';
import {
  BASIC_INLINE_LIGHTMAP_REPLACEMENT,
  BASIC_INLINE_LIGHTMAP_SRC,
  BASIC_INLINE_LIGHTMAP_SRC_LEGACY_MISMATCH,
  CHUNK_LIGHTMAP_INCLUDE,
  CHUNK_LIGHTMAP_REPLACEMENT,
  COLORSPACE_CHUNK_NAME,
  ENVMAP_INCLUDE_SRC,
  ENVMAP_MODULATED,
  FOG_SMOOTHSTEP,
  FOG_SMOOTHSTEP_CAPPED,
  GAMMA22_OUTPUT,
  SPOT_FRAG_DECLS,
  SPOT_VERT_DECL,
  VBSP_AMBIENT_UNIFORM_DECLS,
  VBSP_APPLY_LIGHTMAP,
  VBSP_DECOMPRESS_LIGHTMAP_SAMPLE,
  VBSP_LIGHTMAP_UNIFORM_DECLS,
  VERTEX_LIGHTING_ATTR,
} from './glsl-chunks.js';
import { spotUniforms } from './dynamic-lights.js';
import {
  ambientScaleUniform,
  applyReflectionEnvMap,
  bakedMixUniform,
  effectivePropCubeGain,
  exposureUniform,
  fogMaxDensity,
  lightFloorUniform,
  lightGammaUniform,
  readDebugAlbedoOnly,
  readDebugLightmapOnly,
  readDebugTexLinear,
  readVertexLightingOff,
  registerInjectedMaterial,
  vhvGainUniform,
  vhvLinearUniform,
} from './state.js';

// A/B 开关（排查用）：`globalThis.__vbspOutputGamma22 === false` ⇒ 保留 three 的分段 sRGB。
// 读函数在 `scene/render-context.ts`（T-P2-1：读点单一；这里是**载入期**逃生舱，
// 早于 RenderSession 存在，所以不走运行期上下文传递）。

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
			// **不做任何几何侧重写**（T-732 2026-10-27）：直接吃 GLB 的 `_VBSP_VLIGHT`。
			// 之前的接缝焊接 / 空间鲁棒滤波 / 拉普拉斯 / 方差压缩会在低模上伪造硬边色带
			// （`s1_ramp1b` 每行只有 2~6 个顶点 ⇒ 相邻行被中位数互相拉平），已整段删除。
			// **不叠 leaf ambient cube**：`.vhv` 的逐顶点值本身就含间接光（vrad 的 direct+indirect）。
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
			// **extras 整块进键**：水面材质靠 userData.vbsp_water 注入，若只按 map/颜色/透明度
			// 去重，boreas 的 water01 与 water_pure_beneath（同色同透明度）会共用一个材质 ⇒
			// 后者拿到前者的参数（甚至被当成非水材质）。vbsp_envmap / unlit 同理。
			JSON.stringify(firstOrig.userData ?? {}),
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
		// 同 vertexLightingCache：extras 整块进键，避免不同水材质/反射参数被并成一个。
		JSON.stringify(firstOrig.userData ?? {}),
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

		// 第 1 级逐顶点烘焙：先消掉条带之间的光照跳变（否则 Gouraud 会画成硬边）。
		// 只对带该属性的几何生效；无属性时零开销。
		// 逐顶点光照去接缝统一在**合并之后**做（见 render-session 的 mergeMain）：
		// 这里每 mesh 跑一遍会在载图时重复一遍同样的计算（boreas 实测多花十几秒）。

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
		{
			const g = (globalThis as { __vbspFullbrightNames?: string[] }).__vbspFullbrightNames
				?? ((globalThis as unknown as { __vbspFullbrightNames: string[] }).__vbspFullbrightNames = []);
			if (g.length < 12) g.push((mesh.name || '(anon)') + '@' + (list[0]?.name || '?'));
		}
	});
	const fbn = (globalThis as { __vbspFullbrightNames?: string[] }).__vbspFullbrightNames;
	if (converted > 0 && fbn?.length) console.info('[lightmap] 终扫点名：' + fbn.join(' ｜ '));
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
		shader.uniforms.vbspExposure = exposureUniform; registerInjectedMaterial(material); registerInjection(material, 'lightmap', String(fogMaxDensity));
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

		// spot 直接光：声明 + 在 lightmap 项之后累加（无 spot 时 count=0，循环体直接 break，零开销）。
		updated = SPOT_FRAG_DECLS + updated;
		// 内联路径与 `#include <lightmap_fragment>` 路径最终都会换成同一句
		// `... += vbsp_ApplyLightmap(...)`；不能按内联原文找（chunk 路径下它已不在），
		// 必须按这个稳定调用点追加，否则 spot 项会被静默丢掉。
		const APPLY_LIGHTMAP_CALL = 'reflectedLight.indirectDiffuse += vbsp_ApplyLightmap(lightMap, vLightMapUv);';
		updated = updated.replace(
			APPLY_LIGHTMAP_CALL,
			APPLY_LIGHTMAP_CALL + '\n\treflectedLight.indirectDiffuse += vbspSpotLight(vbspSpotWPos);',
		);
		// 调试：临时把 spot 结果画出来（验证完必须删掉）。
		shader.uniforms = Object.assign(shader.uniforms, spotUniforms);
		shader.vertexShader =
			SPOT_VERT_DECL +
			shader.vertexShader.replace(
				'#include <project_vertex>',
				'#include <project_vertex>\n\tvbspSpotWPos = transformed;',
			);

		shader.fragmentShader = fogMaxDensityDefine() + updated;
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
	// **透明材质不写深度**（T-650）：GLTFLoader 对 BLEND 只置 transparent，depthWrite 仍是 true；
	// 写深度会让后画的透明面互相遮挡，冰/玻璃叠层看起来像实心。
	if (dst.transparent) dst.depthWrite = false;
	if (typeof s.depthTest === 'boolean') dst.depthTest = s.depthTest;
	if (typeof s.blending === 'number') dst.blending = s.blending;
	// `extras.vbsp_additive`（Source `$additive 1`）：加色混合，`dst = dst + src`。
	// 典型用例 `project_tendies/tendies_endsmoke` 的烟幕面 —— 按普通 alpha 混合会画成
	// 「一堵白墙」（boreas 光柱旁那根白柱），加色后才是柔和的假体积烟。
	// three 的 `AdditiveBlending` 默认 `blendSrc = SrcAlpha`（与 Source 的
	// `kRenderTransAdd` 一致），因此贴图 alpha 依然参与衰减。
	if ((src.userData as { vbsp_additive?: boolean } | undefined)?.vbsp_additive) {
		dst.transparent = true;
		dst.blending = THREE.AdditiveBlending;
		dst.depthWrite = false;
		// Source 的 `$vertexalpha 1` 会让烟幕按顶点 alpha 淡出；我们的 BSP 导出还没有
		// 顶点色的 alpha 通道，8 层位移面叠在一起会把柱心加到纯白。给一个统一的
		// 整体不透明度近似那层淡出，避免「一堵白墙」。
		// 2026-11-15 按 scout 量测（远景观测盘内白像素 22.8% vs Source 6.7%）从 0.16 压到
		// 0.10：0.16 时烟幕仍盖住符文盘中心，0.06~0.10 是建议区间。
		dst.opacity = 0.10;
	}
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
	registerInjectedMaterial(dst);
	applyReflectionEnvMap(dst, src);
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
		shader.uniforms.vbspLightGamma = lightGammaUniform; registerInjectedMaterial(mat); registerInjection(mat, 'vertex-lighting', String(fogMaxDensity));
		shader.uniforms.vbspBakedMix = bakedMixUniform; shader.uniforms.vbspLightFloor = lightFloorUniform; shader.uniforms.vbspAmbientScale = ambientScaleUniform;
		// T-732：vhv 项专属增益（默认 1 = 关；试档旋钮，不参与任何默认观感）
		shader.uniforms.vbspVhvGain = vhvGainUniform;
		// 调试面板：vhv 项的伽马处理（0 = pow(2.2)，1 = 伽马空间直接乘）
		shader.uniforms.vbspVhvLinear = vhvLinearUniform;
		// 声明必须来自共享常量（守卫断言"注入单元自洽"）
		const decls = [...VBSP_LIGHTMAP_UNIFORM_DECLS, 'uniform float vbspAmbientScale;', 'uniform float vbspVhvGain;', 'uniform float vbspVhvLinear;'].join('\n');
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
			// 第 1 级只有 vhv 一项（cube 项已随重建层一起删除；不叠 cube 是为了不把间接光算两次）
			// ex = 2.2/g（把 vhv 当线性光）或 1（Source 语义：vhv 是伽马空间乘数，直接乘）。
			'	float ex = mix(2.2 / g, 1.0, clamp(vbspVhvLinear, 0.0, 1.0));',
			'	return pow(max(vbspVLight, vec3(vbspLightFloor)), vec3(ex)) * vbspVhvGain * vbspExposure;',
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
			.replace(mulSrc, mulSrc.slice(0, -1) + ' * vbspVertexLightTerm();')
			// `$envmap` 反射要被烘焙光照调制，见 `ENVMAP_MODULATED` 的实测说明
			.replace(ENVMAP_INCLUDE_SRC, ENVMAP_MODULATED('vbspVertexLightTerm()'));
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
		shader.fragmentShader = fogMaxDensityDefine() + fsA;
	};
	mat.needsUpdate = true;
}

/**
 * prop 静态光照：leaf ambient cube（6 面线性 RGB）按法线平方加权乘入 fullbright 材质。
 * 对齐外部参照实现 `StudioModel.sampleAmbientCube`（顶点色通道）——本工程 prop 顶点
 * 多实例共享 mesh（不逐实例上传顶点色），故 cube 走 node extras + uniform + shader 加权：
 * - cube 数据：`vbsp::Bsp::prop_ambient_cube`（leaf 定位 + 最近采样点 + RGBExp32 线性解码）
 * - 权重：按 **Source 分量**取槽（cube 槽是 Source 世界轴；由 Three 世界法线换回 Sx=n.z、Sy=n.x、Sz=n.y）——引擎同式见 `common_vertexlitgeneric_dx9.h` 的 `VertexShaderAmbientLight`
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
	// 暴露可变 uniform 向量数组：动态实体移出室内后由 DynamicAmbientTracker 平滑原地更新，免重编译。
	(mat.userData as Record<string, unknown>).__vbspAmbCubeUniform = uniformValue;
	mat.onBeforeCompile = (shader) => {
		shader.uniforms.vbspAmbCube = uniformValue;
		shader.uniforms.vbspExposure = exposureUniform; registerInjectedMaterial(mat); registerInjection(mat, 'ambient-cube', String(fogMaxDensity));
		shader.uniforms.vbspLightGamma = lightGammaUniform;
		shader.uniforms.vbspLightFloor = lightFloorUniform;
		shader.uniforms.vbspAmbientScale = ambientScaleUniform;
		shader.uniforms.vbspBakedMix = bakedMixUniform;
		shader.uniforms = Object.assign(shader.uniforms, spotUniforms);
		const vs = shader.vertexShader;
		const vsA = vs.replace(
			'#include <common>',
			SPOT_VERT_DECL + 'varying vec3 vbspWNormal;\n#include <common>',
		);
		const vsB0 =
			vsA !== vs
				? vsA.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvbspWNormal = normalize( mat3( modelMatrix ) * normal );')
				: vsA;
		const vsB =
			vsB0 !== vsA
				? vsB0.replace('#include <project_vertex>', '#include <project_vertex>\n\tvbspSpotWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;')
				: vsB0;
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
			// Source 轴由 Three 世界轴换回（Sx=n.z, Sy=n.x, Sz=n.y），再按面序 +X/-X/+Y/-Y/+Z/-Z 加权。
			"	c += vbspAmbCube[ n.z < 0.0 ? 1 : 0 ] * ( n.z * n.z );",
			"	c += vbspAmbCube[ n.x < 0.0 ? 3 : 2 ] * ( n.x * n.x );",
			"	c += vbspAmbCube[ n.y < 0.0 ? 5 : 4 ] * ( n.y * n.y );",
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
			.replace('#include <common>', SPOT_FRAG_DECLS + '\n' + ambFn + '\n#include <common>')
			.replace(
				mulSrc,
				mulSrc.slice(0, -1) + ' * vbspAmbientWeight();\n\treflectedLight.indirectDiffuse += vbspSpotLight(vbspSpotWPos) * (diffuseColor.rgb + vec3(0.12));',
			)
			// 同上：`$envmap` 反射要被第 2 级 ambient 光照调制
			.replace(ENVMAP_INCLUDE_SRC, ENVMAP_MODULATED('vbspAmbientWeight()'));
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
		shader.fragmentShader = fogMaxDensityDefine() + fsA;
	};
	mat.needsUpdate = true;
}

/**
 * 从 Mesh 自身向上找 ambientCube（一路回溯到根；多层 Group 的 extras 在最外层节点上）。
 * 固定只回溯 2 层会漏掉层级更深的 prop。
 */
function resolveAmbientCube(mesh: THREE.Mesh): unknown {
	let obj: THREE.Object3D | null = mesh;
	for (let depth = 0; depth < 16 && obj; depth++) {
		const c = (obj.userData as { ambientCube?: unknown }).ambientCube;
		if (c !== undefined) return c;
		obj = obj.parent;
	}
	return undefined;
}
/** 注入材质编译期预置的 `#define`；上限为 1 时返回空串（不改既有程序）。 */
function fogMaxDensityDefine(): string {
	(globalThis as { __vbspFogDefine?: string }).__vbspFogDefine = fogMaxDensity < 1 ? 'DEFINED:' + fogMaxDensity : 'NONE';
	return fogMaxDensity < 1 ? `#define FOG_MAX_DENSITY ${fogMaxDensity.toFixed(4)}\n` : '';
}

/** 全局安装夹取式 `fog_fragment`（幂等；未定义该宏的程序不受影响）。 */
function installFogMaxDensity(): void {
	const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
	const cur = chunks.fog_fragment;
	if (cur && !cur.includes('FOG_MAX_DENSITY')) {
		chunks.fog_fragment = cur.replace(FOG_SMOOTHSTEP, FOG_SMOOTHSTEP_CAPPED);
	(globalThis as { __vbspFogChunkPatched?: boolean }).__vbspFogChunkPatched = Boolean(chunks.fog_fragment && chunks.fog_fragment.includes('FOG_MAX_DENSITY'));
	}
}
installFogMaxDensity();