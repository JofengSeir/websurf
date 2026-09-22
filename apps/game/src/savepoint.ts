/**
 * 存点（SavePoint）：按地图持久化的点位存档。
 *
 * 行为要点（逐条对应下方实现）：
 * - 存点字段：位置 / 朝向（yaw、pitch）/ 速度矢量 / 着地状态 / 时间戳；
 * - 容量上限 `SAVEPOINT_MAX`：`add` 超出时用 `shift()` 遗弃最早一条，`load` 载入时只保留
 *   末尾 `SAVEPOINT_MAX` 条；
 * - 按地图分键持久化：localStorage 键 = `websurf-game.savepoints.` + 地图名；
 * - 读写失败都不抛出：`load` 打 `console.error` 并清空内存列表（返回空数组）；`persist`
 *   打 `console.error` 后返回，内存列表不受影响；
 * - `load('')` 只清内存、不读存储；`persist` 在地图名为空时不写存储。
 *
 * 调用点：`apps/game/src/app.ts` 的存点段（`load` / `add` / `latest` / `all` / `delete`）
 * 与面板存点列表（`apps/game/src/panel/panel-controller.ts` 的 `renderSavePoints` 及读点、
 * 删除回调）。`getMap()` 与 `clear()` 在本工程内**零调用点**。
 */

/** 存点数据（渲染物理 `state()` 的字段 + 时间戳；读点时按它 `set_state` 完整恢复）。
 *  `t` 只被写入（`apps/game/src/app.ts` 构造存点时取 `performance.now()`），
 *  **无读取点**：存点列表按插入顺序渲染，不按时间排序。 */
export interface SavePoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
  /** 存点时间戳（performance.now()）。 */
  t: number;
}

/** 存点列表上限（`add` 超出时遗弃最早一条）。 */
export const SAVEPOINT_MAX = 50;

/** localStorage 键前缀（后接地图名）。 */
const STORAGE_PREFIX = 'websurf-game.savepoints.';

/** 存点存储：按地图读写列表，容量上限见 `SAVEPOINT_MAX`。 */
export class SavePointStore {
  private list: SavePoint[] = [];
  private map = '';

  /** 切换地图：清空内存列表并从 localStorage 载入该地图存点，返回列表的浅拷贝。
   *  `mapName` 为空串时直接返回空列表（不读存储）；JSON 解析抛异常时打 `console.error`
   *  并清空列表；解析结果不是数组时静默保持空列表。 */
  load(mapName: string): SavePoint[] {
    this.map = mapName || '';
    this.list = [];
    if (!this.map) return this.list;
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + this.map);
      if (raw) {
        const parsed = JSON.parse(raw) as SavePoint[];
        if (Array.isArray(parsed)) {
          this.list = parsed.slice(-SAVEPOINT_MAX);
        }
      }
    } catch (err) {
      console.error('[savepoint] 读取失败:', err);
      this.list = [];
    }
    return [...this.list];
  }

  /** 当前地图名（持久化键的后半段）。 */
  getMap(): string {
    return this.map;
  }

  /** 全部存点（浅拷贝）。 */
  all(): SavePoint[] {
    return [...this.list];
  }

  /** 追加一个存点；超出 `SAVEPOINT_MAX` 时遗弃最早一条，随后写存储，返回列表浅拷贝。 */
  add(p: SavePoint): SavePoint[] {
    this.list.push(p);
    if (this.list.length > SAVEPOINT_MAX) {
      this.list.shift(); // 遗弃最早
    }
    this.persist();
    return [...this.list];
  }

  /** 删除指定索引的存点（无二次确认）；索引越界时不改列表、也不写存储。 */
  delete(index: number): SavePoint[] {
    if (index >= 0 && index < this.list.length) {
      this.list.splice(index, 1);
      this.persist();
    }
    return [...this.list];
  }

  /** 清空当前地图的存点并写存储（空列表同样落盘）。 */
  clear(): void {
    this.list = [];
    this.persist();
  }

  /** 最近一个存点（C 键读点的目标）；列表为空时返回 null。 */
  latest(): SavePoint | null {
    return this.list.length > 0 ? this.list[this.list.length - 1] : null;
  }

  /** 整表序列化写回 localStorage（键由当前地图名决定）；地图名为空时不写。 */
  private persist(): void {
    try {
      if (!this.map) return;
      localStorage.setItem(STORAGE_PREFIX + this.map, JSON.stringify(this.list));
    } catch (err) {
      console.error('[savepoint] 写入失败:', err);
    }
  }
}
