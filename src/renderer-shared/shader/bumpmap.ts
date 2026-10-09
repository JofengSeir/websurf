/**
 * `$bumpmap`（法线贴图）渲染端注入 —— 冰面/岩石的凹凸高光细节（T-627 / T-454 P8）。
 *
 * 数据来源（导出侧）：VMT 的 `$bumpmap` → glTF 贴图（键 `<材质名>#bump`），纹理**下标**写进材质
 * extras `vbsp_bumpmap`（`src/wasm-core/model_integrator/mod.rs` 的 `push_material`，解析在
 * `src/wasm-core/pakfile_models.rs`，取图在 `src/wasm-core/render_bundle.rs`）。
 *
 * 为什么用「第一贴图 uuid → 法线贴图」注册表而不是材质 `userData`：与 `world-transition.ts` 同因——
 * 装配期的 lightmap 会**另建**材质实例（只搬渲染状态、不搬 `userData`），而第一贴图实例是同一个对象。
 *
 * 注入方式：**链式**接在既有 `onBeforeCompile` 之后（装配收尾后调用）。只扰动**反射方向**：
 * - **不设** `normalMap` / `bumpMap`：`MeshBasicMaterial` 的 fragment 没有 `normal` 符号，一旦设了
 *   属性 three 就会打开 `USE_NORMALMAP` / `USE_BUMPMAP`（`WebGLPrograms` 只看字段有无）⇒ 整批材质
 *   编译失败、一个像素都不画；
 * - **没有 TANGENT 可用**（模型顶点只有 pos+uv+normal，world 面只有 POSITION/TEXCOORD/`_VBSP_BLEND`）
 *   ⇒ 不建 TBN、不做法线光照扰动，法线图只当作「视图空间扰动量」用；
 * - 只对**有 `envMap` 的材质**注入（`vReflect` 只在 `USE_ENVMAP` 下存在）：把法线图的 XY 加在
 *   `vReflect` 上，反射随凹凸图案起波纹 = 冰面的凹凸高光。没有 `$envmap` 的材质本次不注入
 *   （它们的 `$bumpmap` 没有可作用的通道，见 `TODO.md` T-627 的处置说明）。
 */
import * as THREE from 'three';

/** 材质 extras 里指向 glTF 法线贴图下标的键（与导出侧一致）。 */
const BUMP_TEXTURE_KEY = 'vbsp_bumpmap';
/** 第一贴图 → 法线贴图（`collectBumpTextures` 填，`applyBumpShaders` 读）。 */
const bumpByFirstTexture = new Map<string, THREE.Texture>();
/** 已注入的材质，避免同一材质重复挂 `onBeforeCompile`。 */
const patched = new WeakSet<THREE.Material>();
/** 默认扰动强度：足够看出凹凸、又不至于让反射完全散掉（A/B 时可按材质覆盖）。 */
const DEFAULT_STRENGTH = 0.35;

/** 诊断/调参入口：`window.__vbspBumpStrength = <number>` 覆盖扰动强度（无头 A/B 与手感调参用）。 */
function strengthOverride(): number | null {
	const v = (globalThis as { __vbspBumpStrength?: unknown }).__vbspBumpStrength;
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 细节通道强度：`window.__vbspBumpDetail = <number>` 可覆盖（0 = 关掉细节通道，只留反射扰动）。 */
const DEFAULT_DETAIL = 0.6;

function detailOverride(): number | null {
	const v = (globalThis as { __vbspBumpDetail?: unknown }).__vbspBumpDetail;
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** GLTFLoader 暴露的依赖解析器（本模块只用到取贴图这一项）。 */
interface TextureDependencyParser {
	getDependency(type: string, index: number): Promise<unknown>;
}

/** 材质数组归一（`Mesh.material` 可能是单材质或数组）。 */
function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
	return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/** 注册表键：优先第一贴图实例（装配后被沿用），没有第一贴图时退回材质自身 id。 */
function keyOf(material: THREE.Material): string {
	const map = (material as THREE.MeshBasicMaterial).map;
	return map ? 'tex:' + map.uuid : 'mat:' + material.uuid;
}

/**
 * 装配**之前**调用：把「第一贴图实例 → 法线贴图」的对应关系收集起来。
 *
 * 返回收集到的条数。材质 extras 没有 `vbsp_bumpmap`、或该贴图解析失败时跳过。
 */
export async function collectBumpTextures(gltf: unknown, root: THREE.Object3D): Promise<number> {
	const parser = (gltf as { parser?: TextureDependencyParser } | null)?.parser;
	if (!parser) return 0;
	const wanted = new Map<string, number>();
	root.traverse((obj) => {
		const mesh = obj as THREE.Mesh;
		if (!mesh.isMesh) return;
		for (const material of materialsOf(mesh)) {
			const index = (material.userData as Record<string, unknown> | undefined)?.[BUMP_TEXTURE_KEY];
			if (typeof index === 'number') wanted.set(keyOf(material), index);
		}
	});
	let collected = 0;
	for (const [key, index] of wanted) {
		try {
			const texture = (await parser.getDependency('texture', index)) as THREE.Texture | null;
			if (!texture) continue;
			bumpByFirstTexture.set(key, texture);
			collected++;
		} catch {
			// 解析失败只说明这张法线图用不上，画面退回「无凹凸细节」
		}
	}
	return collected;
}

/** 给单个材质链上反射扰动注入（保留既有 `onBeforeCompile`）。 */
export function applyBumpToMaterial(material: THREE.Material, bump: THREE.Texture, strength = DEFAULT_STRENGTH): void {
	if (patched.has(material)) return;
	patched.add(material);
	const previous = material.onBeforeCompile;
	material.onBeforeCompile = (shader, renderer) => {
		if (typeof previous === 'function') previous.call(material, shader, renderer);
		// ⚠️ 与 `world-transition.ts` 同一个坑：`onBeforeCompile` 拿到的 fragment 还是**未展开的**
		// `#include <…>` 模板，UV varying 名只能从 three 自己的 `map_fragment` chunk 里读。
		const mapChunk = (THREE.ShaderChunk as unknown as Record<string, string>).map_fragment ?? '';
		const uv = /texture2D\(\s*map\s*,\s*([A-Za-z_]\w*)\s*\)/.exec(mapChunk)?.[1] ?? 'vMapUv';
		// ⚠️ `vReflect` 在片元里是 `in`（three 的 WebGL2 前缀把 `varying` 定义成 `in`）⇒ **不能赋值**
		// （赋值会得到 `'assign' : l-value required`，整批材质编译失败、mesh 直接不画）。正解是把
		// `envmap_fragment` 这段 chunk 内联进来、把里面的 `vReflect` 换成自己的局部变量。
		const chunk = (THREE.ShaderChunk as unknown as Record<string, string>).envmap_fragment ?? '';
		if (!chunk.includes('vReflect')) {
			console.warn('[bumpmap] three 的 envmap_fragment 里没有 vReflect ⇒ 跳过注入（版本变了？）');
			return;
		}
		shader.uniforms.vbspBumpTex = { value: bump };
		shader.uniforms.vbspBumpStrength = { value: strength };
		shader.uniforms.vbspBumpDetail = { value: detailOverride() ?? DEFAULT_DETAIL };
		const inlined = chunk.replace(/vReflect/g, 'vbspReflect');
		const block = [
			'#ifdef USE_ENVMAP',
			'\tvec2 vbspBumpXy = texture2D(vbspBumpTex, ' + uv + ').xy * 2.0 - 1.0;',
			'\tvec3 vbspReflect = normalize(vReflect + vec3(vbspBumpXy * vbspBumpStrength, 0.0));',
			'#endif',
			inlined,
		].join('\n');
		// 细节通道（近似）：本渲染器的反射源是**均匀白天空**（天空盒立方体），单靠扰动反射方向看不出凹凸
		// （实测：强度调到 3.0 仍逐像素相同），故同时把法线图的亮度当作「表面细节」按比例调制基色。
		// 这是**近似**：法线图的 RGB 不是亮度纹理，`$bumpmap` 在引擎里作用在受光/反射上而非基色；
		// 详见 `TODO.md` T-627 的处置说明与 `documents/` 对应篇。
		const detail = [
			'#include <map_fragment>',
			'\t{',
			'\t\tvec2 vbspBumpVec = texture2D(vbspBumpTex, ' + uv + ').xy * 2.0 - 1.0;',
			'\t\tfloat vbspRelief = clamp(length(vbspBumpVec), 0.0, 1.0);',
			'\t\tdiffuseColor.rgb *= mix(1.0, 0.82 + 0.36 * vbspRelief, vbspBumpDetail);',
			'\t}',
		].join('\n');
		// 诊断：记录两个 include 标记是否存在（不存在时 replace 会静默失败 ⇒ 注入块变死代码）
		const src = shader.fragmentShader;
		shader.fragmentShader = src
			.replace(
				'#include <common>',
				'uniform sampler2D vbspBumpTex;\nuniform float vbspBumpStrength;\nuniform float vbspBumpDetail;\n#include <common>',
			)
			.replace('#include <map_fragment>', detail)
			.replace('#include <envmap_fragment>', block);
	};
	material.needsUpdate = true;
}

/**
 * 装配**收尾后**调用：给场景里所有「第一贴图已登记法线贴图、且挂了 envMap」的材质注入反射扰动。
 *
 * 返回注入的材质数；0 表示这张图没有可作用的 `$bumpmap` 材质（或都没有 `$envmap`）。
 */
export function applyBumpShaders(root: THREE.Object3D): number {
	// 诊断开关：`window.__vbspBumpOff = true` ⇒ 本次不注入（A/B 对照用，与 `__vbspWorldTransitionOff` 同策）。
	if ((globalThis as { __vbspBumpOff?: unknown }).__vbspBumpOff === true) return 0;
	const seen = new Set<THREE.Material>();
	root.traverse((obj) => {
		const mesh = obj as THREE.Mesh;
		if (!mesh.isMesh) return;
		for (const material of materialsOf(mesh)) seen.add(material);
	});
	let applied = 0;
	let pendingEnv = 0;
	let noMap = 0;
	for (const material of seen) {
		const bump = bumpByFirstTexture.get(keyOf(material));
		if (!bump) continue;
		// 注入块用基色贴图的 UV varying（`vMapUv`）采样法线图 ⇒ 没有基色贴图的材质直接跳过，
		// 否则引用了不存在的 varying 会让程序编译失败。
		if (!(material as THREE.MeshBasicMaterial).map) {
			noMap++;
			continue;
		}
		// 装配期 `envMap` 可能还没挂上（反射源来自天空盒，晚于装配）；这里**照注入**——注入块的
		// `#ifdef USE_ENVMAP` 在没有 envMap 时编译成空，等 `setReflectionEnvMap` 补挂并重编程序后
		// 自动生效。反过来（等 envMap 到了再注入）会漏掉全部装配期材质。
		if (!(material as THREE.MeshBasicMaterial).envMap) pendingEnv++;
		applyBumpToMaterial(material, bump, strengthOverride() ?? DEFAULT_STRENGTH);
		applied++;
	}
	console.info(
		'[bumpmap] $bumpmap 注入：登记法线图 ' +
			bumpByFirstTexture.size +
			' 张，注入材质 ' +
			applied +
			' 个（其中装配期尚无 envMap ' +
			pendingEnv +
			' 个，待反射源补挂后生效；无基色贴图跳过 ' +
			noMap +
			' 个）',
	);
	return applied;
}
