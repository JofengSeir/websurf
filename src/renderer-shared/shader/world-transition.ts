/**
 * `WorldVertexTransition`（双贴图地形混合，起源引擎的岩石/雪混合）渲染端注入。
 *
 * 数据来源（导出侧，见 `src/wasm-core/bsp_to_gltf_core/convert.rs` 与 `.../materials.rs`）：
 * - 逐顶点混合权重 → 几何属性 `_VBSP_BLEND`（glTF 自定义语义，GLTFLoader 载入后小写化为
 *   `_vbsp_blend`）；
 * - VMT 的 `$basetexture2` → glTF 第二贴图，下标写进材质 extras `vbsp_basetexture2`。
 *
 * 为什么用「第一贴图 uuid → 第二贴图」的注册表而不是材质 `userData`：
 * 三个工程的 lightmap 装配会**另建**材质实例（`MeshBasicMaterial`），只搬渲染状态、不搬
 * `userData`，材质 extras 在装配后就查不到了；而第一贴图实例是**同一个对象**被搬过去的，
 * 故以它为键最稳。
 *
 * 注入方式：**链式**接在既有 `onBeforeCompile` 之后，不覆盖 lightmap 注入（本模块在装配
 * 收尾后调用，此时 lightmap 已挂好）。片元里按混合权重要求 `mix(第一贴图, 第二贴图)`。
 */
import * as THREE from 'three';

/** 材质 extras 里指向 glTF 第二贴图下标的键（与导出侧一致）。 */
const SECOND_TEXTURE_KEY = 'vbsp_basetexture2';
/** 几何属性名：glTF 语义 `_VBSP_BLEND` 经 GLTFLoader 小写化后的键。 */
const BLEND_ATTR = '_vbsp_blend';
/** 第一贴图 → 第二贴图（`collectWorldTransitionTextures` 填，`applyWorldTransitionShaders` 读）。 */
const secondByFirstTexture = new Map<string, THREE.Texture>();
/** 已注入的材质，避免同一材质重复挂 `onBeforeCompile`。 */
const patched = new WeakSet<THREE.Material>();

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
 * 装配**之前**调用：把「第一贴图实例 → 第二贴图」的对应关系收集起来。
 *
 * 返回收集到的条数。材质 extras 没有 `vbsp_basetexture2`、或该贴图解析失败时跳过。
 */
export async function collectWorldTransitionTextures(gltf: unknown, root: THREE.Object3D): Promise<number> {
	const parser = (gltf as { parser?: TextureDependencyParser } | null)?.parser;
	if (!parser) return 0;
	const wanted = new Map<string, number>();
	root.traverse((obj) => {
		const mesh = obj as THREE.Mesh;
		if (!mesh.isMesh) return;
		for (const material of materialsOf(mesh)) {
			const index = (material.userData as Record<string, unknown> | undefined)?.[SECOND_TEXTURE_KEY];
			if (typeof index === 'number') wanted.set(keyOf(material), index);
		}
	});
	let collected = 0;
	for (const [key, index] of wanted) {
		try {
			const texture = (await parser.getDependency('texture', index)) as THREE.Texture | null;
			if (!texture) continue;
			secondByFirstTexture.set(key, texture);
			collected++;
		} catch {
			// 解析失败只说明这张第二贴图用不上，画面退回「只用第一贴图」
		}
	}
	return collected;
}

/** 给单个材质链上混合注入（保留既有 `onBeforeCompile`）。 */
export function applyWorldTransitionToMaterial(material: THREE.Material, second: THREE.Texture): void {
	if (patched.has(material)) return;
	patched.add(material);
	const previous = material.onBeforeCompile;
	material.onBeforeCompile = (shader, renderer) => {
		if (typeof previous === 'function') previous.call(material, shader, renderer);
		shader.uniforms.vbspSecondTex = { value: second };
		const blendDecl = 'attribute float ' + BLEND_ATTR + ';\nvarying float vbspBlend;';
		const blendCopy = '#include <begin_vertex>\n\tvbspBlend = ' + BLEND_ATTR + ';';
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', blendDecl + '\n#include <common>')
			.replace('#include <begin_vertex>', blendCopy);
		// ⚠️ 不能从 `shader.fragmentShader` 里找 varying 名：`onBeforeCompile` 拿到的还是**未展开的**
		// `#include <…>` 模板，`vMapUv` 只出现在 chunk 源码里 ⇒ 那样的判断永远命中不到、会退成 `vUv`，
		// 而 three 0.165 的 fragment 里只有 `vMapUv` ⇒ program 编译失败 ⇒ 该批 mesh 一个像素都不画。
		// 正解：从 three 自己的 `map_fragment` chunk 里读它实际用的 UV 变量名。
		const mapChunk = (THREE.ShaderChunk as unknown as Record<string, string>).map_fragment ?? '';
		const uv = /texture2D\(\s*map\s*,\s*([A-Za-z_]\w*)\s*\)/.exec(mapChunk)?.[1] ?? 'vMapUv';
		console.info('[world-transition] 注入双贴图混合：UV varying = ' + uv + '（取自 three 的 map_fragment chunk）');
		const mix = [
			'#include <map_fragment>',
			'\tdiffuseColor.rgb = mix(diffuseColor.rgb, texture2D(vbspSecondTex, ' + uv + ').rgb, clamp(vbspBlend, 0.0, 1.0));',
		].join('\n');
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', 'varying float vbspBlend;\nuniform sampler2D vbspSecondTex;\n#include <common>')
			.replace('#include <map_fragment>', mix);
	};
	material.needsUpdate = true;
}

/**
 * 装配**收尾后**调用：给场景里所有「第一贴图已登记第二贴图」的材质挂上混合注入。
 *
 * 返回注入的材质数；小于等于 0 表示这张图没有双贴图地形（`WorldVertexTransition`）。
 */
export function applyWorldTransitionShaders(root: THREE.Object3D): number {
	// 诊断开关：`window.__vbspWorldTransitionOff = true` ⇒ 本次不注入（A/B 对照用，与
	// lightmap-shader 的 `__vbspVertexLightingOff` 同策）。
	if ((globalThis as { __vbspWorldTransitionOff?: unknown }).__vbspWorldTransitionOff === true) return 0;
	const seen = new Set<THREE.Material>();
	root.traverse((obj) => {
		const mesh = obj as THREE.Mesh;
		if (!mesh.isMesh) return;
		for (const material of materialsOf(mesh)) seen.add(material);
	});
	let applied = 0;
	for (const material of seen) {
		const second = secondByFirstTexture.get(keyOf(material));
		if (!second) continue;
		applyWorldTransitionToMaterial(material, second);
		applied++;
	}
	console.info('[world-transition] 双贴图地形混合：登记贴图 ' + secondByFirstTexture.size + ' 张，注入材质 ' + applied + ' 个');
	return applied;
}
