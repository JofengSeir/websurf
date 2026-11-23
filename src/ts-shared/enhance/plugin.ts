/**
 * 增强插件的最小契约（宿主与插件之间的唯一接口）。
 *
 * 设计约束（对应 owner「增强型可选插件、默认不影响性能」的要求）：
 *   1. **默认零成本**：插件模块只在被启用时才动态 `import`；没启用时宿主不订阅任何
 *      每帧/每事件回调（`EnhanceHost` 在装载数为 0 时把事件 sink 置空）。
 *   2. **不改核心语义**：插件只消费实体层已经 emit 的事件 / 地图导出数据，不修改
 *      Rust 物理链与共享渲染会话的行为；要改已生效的链必须另立任务并做 A/B。
 *   3. **可整体卸载**：`dispose()` 后不得留下定时器、事件订阅或对渲染对象的引用。
 *
 * 这里故意不 import three / renderer-shared：插件通过 `EnhanceRuntime` 注入的能力
 * （传送、读玩家状态、日志）与宿主打交道，具体由各端宿主适配。
 */
import type { EntityEvent } from '../entity/types.js';

/** 换图完成时可拿到的地图级上下文（不包含大体积 GLB，避免插件误持有）。 */
export interface EnhanceSceneContext {
  /** 地图文件名（日志/诊断用）。 */
  mapName?: string;
  /** `buildWorldBundle().entityIoJson`：实体 I/O 连接 + 实体体积。 */
  entityIoJson?: string;
  /** `parse_teleports()` 的静态传送表（Rust 链用的同一份数据，插件只读）。 */
  teleportJson?: string;
  /**
   * 合并后的渲染场景根（宿主注入，通常是 three 的 `Scene`）。
   *
   * 插件契约故意不 import three：需要遍历几何的插件（如 `brush-visibility`）在这里
   * 拿到根后按结构类型自省 `traverse` / `geometry.userData`，宿主不暴露具体类型。
   * 换图后该引用失效（每次 `onMapLoad` 拿新根）；插件不得跨图持有。
   */
  sceneRoot?: unknown;
}

/** 宿主注入给插件的能力（全部走宿主，插件不认识具体渲染/物理类）。 */
export interface EnhanceRuntime {
  /**
   * 传送到指定位置（脚底原点，Y-up）+ 指定朝向（度）。
   * 宿主负责同时写主线程预测物理与权威 Worker（两线必须同参）。
   */
  teleport(pos: readonly number[], yawDeg?: number): void;
  /** 当前玩家物理状态（脚底原点 + yaw）；物理未就绪返回 null。 */
  getPlayerState(): { posX: number; posY: number; posZ: number; yaw?: number } | null;
  /** 统一日志前缀（`[enhance]`）；插件不应绕过它直接打 console。 */
  log(message: string): void;
}

/** 一个增强插件：由工厂函数创建，生命周期由 `EnhanceHost` 管理。 */
export interface EnhancePlugin {
  /** 与 `ENHANCE_FLAGS` 中的 id 一致。 */
  readonly id: string;
  /** 换图完成（实体系统已装配）时调用；插件在这里重置状态、读地图数据。 */
  onMapLoad?(context: EnhanceSceneContext): void;
  /** 实体运行期事件（宿主已过滤掉高频的 `input` 事件）。 */
  onEvent?(event: EntityEvent): void;
  /** 面板/控制台显示的一行状态（诊断用；可选）。 */
  statusText?(): string;
  /** 卸载：释放所有订阅与缓存。 */
  dispose?(): void;
}

/** 插件工厂：宿主按需动态 import 模块后调用，注入 runtime 后返回插件实例。 */
export type EnhancePluginFactory = (runtime: EnhanceRuntime) => Promise<EnhancePlugin>;
