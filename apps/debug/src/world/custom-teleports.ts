/**
 * 自定义传送点的数据层（侧边栏面板用）：按地图名分组保存玩家当前位置或手输坐标，
 * 之后一键传送回去。
 *
 * 持久化：localStorage，键为 `STORAGE_PREFIX + 地图名`；每个函数各自 try/catch，
 * 存储不可用时降级为空列表或忽略写入，不抛异常。
 *
 * 消费点：`apps/debug/src/app.ts`（列表渲染、新增、删除、清空与「传送到该点」按钮）。
 * 其中 `saveCustomTeleports` 只被本文件的 `addCustomTeleport` 与 `removeCustomTeleport` 调用。
 */

/** 单个自定义传送点。 */
export interface CustomTeleport {
	/** 唯一 id：`makeId` 生成（时间戳 + 随机后缀）。 */
	id: string;
	/** 显示名称（用户输入或坐标字符串）。 */
	name: string;
	/** 目标坐标 `[x, y, z]`（Y-up，Source 单位）。 */
	pos: [number, number, number];
	/** 目标 yaw（度）；null = 传送时保持当前朝向。 */
	yaw: number | null;
	/** 创建时间戳（`Date.now()`，毫秒）。 */
	createdAt: number;
}

/** localStorage 键前缀（实际键 = 前缀 + 地图名）。 */
const STORAGE_PREFIX = 'vbsp:customTeleports:';

/** 单张地图的保存上限（条）；`addCustomTeleport` 超出时丢最旧的条目。 */
const MAX_PER_MAP = 50;

/** 生成 id：`Date.now()` 的 36 进制 + 6 位随机 36 进制字符。 */
function makeId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 读取某地图的传送点列表。
 * 键不存在、JSON 解析失败或顶层不是数组时返回空数组；条目逐条过滤，只保留 `id` 为字符串且
 * `pos` 为长度 3 数组的对象（其余字段不校验）。
 */
export function loadCustomTeleports(mapName: string): CustomTeleport[] {
	try {
		const raw = localStorage.getItem(STORAGE_PREFIX + mapName);
		if (!raw) return [];
		const arr = JSON.parse(raw) as unknown;
		if (!Array.isArray(arr)) return [];
		// 逐条过滤（挡掉手工改坏或半截写入的数据）
		return arr.filter(
			(t): t is CustomTeleport =>
				!!t &&
				typeof t === 'object' &&
				typeof (t as CustomTeleport).id === 'string' &&
				Array.isArray((t as CustomTeleport).pos) &&
				(t as CustomTeleport).pos.length === 3,
		);
	} catch {
		return [];
	}
}

/** 覆盖写入某地图的传送点列表；写入抛错（配额用尽等）时静默放弃。 */
export function saveCustomTeleports(mapName: string, list: CustomTeleport[]): void {
	try {
		localStorage.setItem(STORAGE_PREFIX + mapName, JSON.stringify(list));
	} catch {
		// 写入失败（如配额用尽）时静默放弃，由调用方的 UI 提示
	}
}

/** 追加一个传送点（补 id 与创建时间），只保留最后 `MAX_PER_MAP` 条并落盘，返回新列表。 */
export function addCustomTeleport(
	mapName: string,
	tp: Omit<CustomTeleport, 'id' | 'createdAt'>,
): CustomTeleport[] {
	const list = loadCustomTeleports(mapName);
	const entry: CustomTeleport = {
		...tp,
		id: makeId(),
		createdAt: Date.now(),
	};
	const next = [...list, entry].slice(-MAX_PER_MAP);
	saveCustomTeleports(mapName, next);
	return next;
}

/** 按 id 删除；id 不存在时原样返回传入的列表且不落盘。 */
export function removeCustomTeleport(mapName: string, id: string): CustomTeleport[] {
	const list = loadCustomTeleports(mapName);
	const next = list.filter((t) => t.id !== id);
	if (next.length === list.length) return list;
	saveCustomTeleports(mapName, next);
	return next;
}

/** 删除某地图的整条存储键（含删除失败时静默）。 */
export function clearCustomTeleports(mapName: string): void {
	try {
		localStorage.removeItem(STORAGE_PREFIX + mapName);
	} catch {
		// 删除失败时静默
	}
}
