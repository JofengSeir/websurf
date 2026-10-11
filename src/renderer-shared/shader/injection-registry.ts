/**
 * 注入登记处：把「材质被哪些着色器注入改造过」变成**可累加的事实**，并据此生成
 * `customProgramCacheKey`。
 *
 * ## 为什么要有这一层（T-648）
 *
 * three.js 的 program 缓存键 = `parameters.customProgramCacheKey()`（缺省是
 * `onBeforeCompile.toString()`）。**键相同 ⇒ 复用同一份 program**，而 program 是
 * 「第一个用这个键编译的材质」的 `onBeforeCompile` 产物。
 *
 * 本仓此前把 `customProgramCacheKey` 写成常量 `'vbsp-fog' + fogMaxDensity`
 * （`lightmap-shader.ts` 三处注入点），于是**全场景所有被 lightmap 注入过的材质共用
 * 一个缓存桶**。后于 lightmap 链式注入的 `world-transition`（`$basetexture2` 雪/岩
 * 混合）与 `bumpmap`（`$bumpmap` 反射扰动）**没有参与键**，它们改过的 GLSL 不进键：
 *
 * - 桶里那份 program 由**先编译的材质**决定带不带这两段注入；
 * - `apps/debug` 走 `precompileScene`（`render/create-renderer.ts`）在装载期一次性编译
 *   全部材质，抢先用**未混合**的材质占桶；
 * - `apps/game` / `apps/viewer` 惰性编译，先编译的恰好是混合材质。
 *
 * 同一张 BSP 导出**逐字节相同**的 GLB，debug 却把 `alpine_rock01` 绑到不含
 * `vbspSecondTex` 的 program 上：采样器 0 号单元（岩石贴图）被当成「第二贴图」采样，
 * `mix()` 退化为纯岩石 —— 这就是 owner 报的「debug 雪盖消失、另两端正常」。
 *
 * ## 口径
 *
 * - 每个注入点在自己改动材质时调用 `registerInjection(material, tag)`；
 * - 键 = 该材质**已登记 tag 的排序集合**（外加各注入自带的变体参数），因此
 *   「有没有被混合注入」必然反映在键里，**结构上不可能再漏**；
 * - 登记即挂一个稳定的 `customProgramCacheKey`，多次登记只增不减；
 * - `setFogMaxDensity` 这类**变体参数**通过 `registerInjection(mat, tag, variant)`
 *   的第三参并入键（值变了键就变 ⇒ 程序自动重编，不需要手动 `needsUpdate` 兜底）。
 *
 * 生产路径零影响：未登记注入的材质保持 three 的缺省键。
 */
import type * as THREE from 'three';

/** 注入 tag（稳定字符串，进缓存键，改名即视作新程序）。 */
export type InjectionTag =
	| 'lightmap'
	| 'vertex-lighting'
	| 'ambient-cube'
	| 'world-transition'
	| 'bumpmap'
	| 'fog';

interface InjectionRecord {
	/** tag → 变体键（无变体为空串）。 */
	tags: Map<InjectionTag, string>;
	/** 已挂到材质上的 `customProgramCacheKey`（用于幂等重挂）。 */
	appliedKey: string;
}

/** 材质 → 其累积注入记录（`WeakMap`：材质被 GC 时记录一并回收）。 */
const records = new WeakMap<THREE.Material, InjectionRecord>();

/** 缓存键前缀（与历史常量 `vbsp-fog` 保持同族，便于日志辨识）。 */
const KEY_PREFIX = 'vbsp-inject';

/** 由 tag 集合算出稳定键（排序 ⇒ 同组合恒同键；变体值进键 ⇒ 值变则键变）。 */
function computeKey(rec: InjectionRecord): string {
	const parts: string[] = [];
	for (const tag of [...rec.tags.keys()].sort()) {
		const variant = rec.tags.get(tag) ?? '';
		parts.push(variant ? `${tag}(${variant})` : tag);
	}
	return `${KEY_PREFIX}|${parts.join(',')}`;
}

/**
 * 登记一次注入并把缓存键刷到材质上。
 *
 * @param material 被改造的材质
 * @param tag 注入来源
 * @param variant 变体参数（如雾密度上限 `0.35`）；同一 tag 重复登记时**后者覆盖前者**
 *                （变体是「当前值」语义，不是叠加）
 * @returns 该材质当前的完整缓存键
 */
export function registerInjection(
	material: THREE.Material,
	tag: InjectionTag,
	variant = '',
): string {
	let rec = records.get(material);
	if (!rec) {
		rec = { tags: new Map(), appliedKey: '' };
		records.set(material, rec);
	}
	rec.tags.set(tag, variant);
	const key = computeKey(rec);
	if (rec.appliedKey !== key) {
		material.customProgramCacheKey = () => key;
		rec.appliedKey = key;
	}
	return key;
}

/** 读某材质当前的注入 tag 列表（按字典序；未登记注入返回空数组）。诊断与门禁用。 */
export function injectionTagsOf(material: THREE.Material): readonly string[] {
	const rec = records.get(material);
	if (!rec) return [];
	return [...rec.tags.keys()].sort();
}

/** 读某材质当前的注入缓存键（未登记注入返回空串）。 */
export function injectionKeyOf(material: THREE.Material): string {
	return records.get(material)?.appliedKey ?? '';
}

/** 某材质是否带某个注入。 */
export function hasInjection(material: THREE.Material, tag: InjectionTag): boolean {
	return records.get(material)?.tags.has(tag) ?? false;
}