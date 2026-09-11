/**
 * 自定义传送点（侧边栏面板数据层）：保存/读取自定义传送位置（当前玩家位置或
 * 手动输入坐标），一键传送回该位置（surf 练习点、bug 复现点等）。
 * 持久化：localStorage 按地图名分组（key = vbsp:customTeleports:<mapName>）；
 * 纯函数设计，便于测试与复用（主线程 app.ts 消费）。
 */

/** 单个自定义传送点。 */
export interface CustomTeleport {
	/** 唯一 id（时间戳 + 随机后缀，避免同毫秒冲突）。 */
	id: string;
	/** 显示名称（用户输入，缺省为坐标字符串）。 */
	name: string;
	/** 目标坐标（Y-up，Source 单位）。 */
	pos: [number, number, number];
	/** 目标 yaw（度，0 = 朝 -Z）。缺省 = 传送时保持当前朝向。 */
	yaw: number | null;
	/** 创建时间戳（ms）。 */
	createdAt: number;
}

/** localStorage 分组前缀。 */
const STORAGE_PREFIX = 'vbsp:customTeleports:';

/** 最大保存条数（防止恶意输入撑爆 localStorage）。 */
const MAX_PER_MAP = 50;

/** 生成唯一 id。 */
function makeId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 读取某地图的自定义传送点列表。
 * 解析失败（损坏数据）时返回空数组，不抛异常。
 */
export function loadCustomTeleports(mapName: string): CustomTeleport[] {
	try {
		const raw = localStorage.getItem(STORAGE_PREFIX + mapName);
		if (!raw) return [];
		const arr = JSON.parse(raw) as unknown;
		if (!Array.isArray(arr)) return [];
		// 过滤非法条目（防御损坏数据）
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

/** 保存某地图的自定义传送点列表。 */
export function saveCustomTeleports(mapName: string, list: CustomTeleport[]): void {
	try {
		localStorage.setItem(STORAGE_PREFIX + mapName, JSON.stringify(list));
	} catch {
		// localStorage 满（QuotaExceededError）时静默失败，UI 层提示
	}
}

/** 新增一个传送点（追加到末尾，截断到 MAX_PER_MAP）。返回更新后的列表。 */
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

/** 删除指定 id 的传送点。返回更新后的列表；id 不存在时返回原列表。 */
export function removeCustomTeleport(mapName: string, id: string): CustomTeleport[] {
	const list = loadCustomTeleports(mapName);
	const next = list.filter((t) => t.id !== id);
	if (next.length === list.length) return list;
	saveCustomTeleports(mapName, next);
	return next;
}

/** 清空某地图的全部自定义传送点。 */
export function clearCustomTeleports(mapName: string): void {
	try {
		localStorage.removeItem(STORAGE_PREFIX + mapName);
	} catch {
		// 忽略
	}
}
