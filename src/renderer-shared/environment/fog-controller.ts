/**
 * `env_fog_controller` → 线性雾参数。
 *
 * 从 `parse_entities()` 的 JSON 里取地图雾控制器，归一成 `{ color, start, end }`
 * （`color` 为 0xRRGGBB，`start`/`end` 为 HU 距离）；没有控制器、`fogenable` 为 0、
 * 或 `end <= start` 时返回 null（表示不用地图雾）。
 *
 * `fogcolor` 写作 "R G B"（0–255）。`maxDensity` 取 `fogmaxdensity`（SDK `CFogController` 的同名键，
 * 默认 1.0，见 `test/project/source-sdk-2013-master/src/game/server/fogcontroller.cpp:61/103`）：它是雾因子的**上限**，
 * `<1` 时远处不再饱和成纯雾色。`fogblend`/`fogcolor2` 仍未建模（夹具图均 `fogblend = 0`）。
 */

/** 线性雾参数（`color` 为 0xRRGGBB，端点单位 HU）。 */
export interface FogParams {
	color: number;
	start: number;
	end: number;
	/** 雾因子上限（`fogmaxdensity`，0..1；1 = 不加限）。 */
	maxDensity: number;
}

/** 实体列表项（`parse_entities()` 的最小结构面）。 */
type EntityLike = { classname?: string; props?: Record<string, string> };

/** 实体 JSON（`parse_entities()` 的输出：数组或 `{ entities }`）→ 雾参数；无则 null。 */
export function fogParamsFromEntities(entitiesJson: string): FogParams | null {
	let list: EntityLike[] = [];
	try {
		const parsed: unknown = JSON.parse(entitiesJson);
		list = Array.isArray(parsed) ? (parsed as EntityLike[]) : ((parsed as { entities?: EntityLike[] }).entities ?? []);
	} catch {
		return null;
	}
	for (const e of list) {
		if (e?.classname !== 'env_fog_controller') continue;
		const p = e.props ?? {};
		if ((p.fogenable ?? '1') === '0') return null;
		const rgb = (p.fogcolor ?? '').trim().split(/\s+/).map(Number);
		if (rgb.length < 3 || rgb.some((v) => !Number.isFinite(v))) return null;
		const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
		const color = (clamp(rgb[0]) << 16) | (clamp(rgb[1]) << 8) | clamp(rgb[2]);
		const start = Number.parseFloat(p.fogstart ?? '');
		const end = Number.parseFloat(p.fogend ?? '');
		if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
		const md = Number.parseFloat(p.fogmaxdensity ?? '1');
		const maxDensity = Number.isFinite(md) ? Math.min(1, Math.max(0, md)) : 1;
		return { color, start, end, maxDensity };
	}
	return null;
}
