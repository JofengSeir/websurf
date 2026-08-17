/**
 * 存点（SavePoint）— 按地图持久化的点位存档。
 *
 * 用户定调（2026-08-18）：
 * - 存点记录：位置 / 朝向（yaw,pitch）/ 速度矢量 / 着地状态；
 * - 上限 50 个，超出时遗弃最早的（shift）；
 * - 按地图持久化：localStorage 键 `websurf-game.savepoints.{mapName}`；
 * - 支持删除任意存点（面板列表，无确认弹窗）。
 */

/** 存点数据（predPhys.state() 全量字段，读点时 set_state 完整恢复）。 */
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
  /** 存点时间戳（performance.now()，列表排序用）。 */
  t: number;
}

/** 存点列表上限（超出遗弃最早）。 */
export const SAVEPOINT_MAX = 50;

/** localStorage 键前缀（后接地图名）。 */
const STORAGE_PREFIX = 'websurf-game.savepoints.';

/** 存点存储：按地图读写列表，容量上限 50。 */
export class SavePointStore {
  private list: SavePoint[] = [];
  private map = '';

  /** 切换地图：清内存并从 localStorage 加载该地图存点。 */
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

  /** 当前地图名。 */
  getMap(): string {
    return this.map;
  }

  /** 全部存点（浅拷贝）。 */
  all(): SavePoint[] {
    return [...this.list];
  }

  /** 添加存点（超出上限遗弃最早），返回添加后列表。 */
  add(p: SavePoint): SavePoint[] {
    this.list.push(p);
    if (this.list.length > SAVEPOINT_MAX) {
      this.list.shift(); // 遗弃最早
    }
    this.persist();
    return [...this.list];
  }

  /** 删除指定索引存点（无确认），返回剩余列表。 */
  delete(index: number): SavePoint[] {
    if (index >= 0 && index < this.list.length) {
      this.list.splice(index, 1);
      this.persist();
    }
    return [...this.list];
  }

  /** 清空当前地图存点（换地图时用）。 */
  clear(): void {
    this.list = [];
    this.persist();
  }

  /** 最近一个存点（C 键读点目标）；无则 null。 */
  latest(): SavePoint | null {
    return this.list.length > 0 ? this.list[this.list.length - 1] : null;
  }

  /** 持久化到 localStorage（按地图）。 */
  private persist(): void {
    try {
      if (!this.map) return;
      localStorage.setItem(STORAGE_PREFIX + this.map, JSON.stringify(this.list));
    } catch (err) {
      console.error('[savepoint] 写入失败:', err);
    }
  }
}
