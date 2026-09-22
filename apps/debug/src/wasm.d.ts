/**
 * wasm 模块的环境声明：一条 `declare module` 通配声明，匹配任意前缀下的 pkg 入口文件。
 *
 * 实体声明是 wasm-pack 的产物（`npm run build:wasm` 生成到 `apps/debug/pkg/`）；本文件供该
 * 产物缺失时 tsc 解析，随 `apps/debug/tsconfig.json` 的 `include` 进入程序。
 *
 * 本文件落后于源码，两处（只登记，不改声明）：
 * - `PhysWorld` 只声明 17 个成员，而 `src/phys/mod.rs` 的 impl 块有 24 个 `pub fn`，缺
 *   `tick_into` / `state_out_ptr` / `set_state_ex` / `state_full_json` / `seed_from` /
 *   `gate_veto_count` / `debug_trace`；
 * - `BspProcessor` 未声明 `export_glb_with_pakfile_models_with_defaults_and_lights`，而
 *   `src/ts-shared/phys/world-builder.ts` 的 `BspProcessorLike` 要求该成员。
 *
 * 因第一处缺口，`apps/debug/src/renderer/renderer-main.ts` 的 `captureFullPhysState` 与
 * `restoreFullPhysState` 只能先把实例收窄成 `as unknown as { … }`，再调 `state_full_json` /
 * `set_state_ex`。
 */

declare module '*/pkg/websurf_wasm.js' {
  /** 默认导出：取回并实例化 .wasm。本工程的调用点为零（两侧都直接走 `initSync`）。 */
  export default function init(
    module_or_path?: string | URL | Request | ArrayBuffer | Uint8Array,
  ): Promise<unknown>;

  /** 同步初始化（wasm 字节，或 `{ module: 字节 }` 包装）。调用点：`apps/debug/src/main-wasm.ts` 与 `apps/debug/src/worker/main.ts`。 */
  export function initSync(
    module: ArrayBuffer | Uint8Array | { module: ArrayBuffer | Uint8Array },
  ): unknown;

  /** 一次性解析 BSP 并返回元数据 JSON（不持有解析器实例）。本工程调用点为零：主线程走 `BspProcessor` + `metadata()`。 */
  export function parse_bsp(data: Uint8Array | ArrayBuffer): string;

  /** BSP 处理器：构造即解析，实例缓存解析结果供各导出方法复用。 */
  export class BspProcessor {
    constructor(data: Uint8Array | ArrayBuffer);
    /** 元数据 JSON（消费点：`buildWorldBundle` 读 `mapName` 等字段）。 */
    metadata(): string;
    /** 导出地图 GLB 字节（不含 PAKFILE 内嵌模型）。本工程调用点为零。 */
    export_glb(): Uint8Array;
    /** 导出地图 GLB 并把 PAKFILE 内嵌模型合并进去（不注入默认纹理包）。 */
    export_glb_with_pakfile_models(): Uint8Array;
    /** 同上，另把缺失材质的回退纹理包（`defaultsJson`）注入。本工程实际走这条。 */
    export_glb_with_pakfile_models_with_defaults(defaultsJson: string): Uint8Array;
    /** 画质切换 manifest（mosaic 字节码表）JSON；须在导出 GLB 之前调用。 */
    export_mosaic_manifest(): string;
    /** 内嵌模型的「可视网格」三角形碰撞 JSON（与显示网格逐位一致）；须在导出 GLB 之前调用。 */
    export_model_tri_colliders(): string;
    /** 内嵌模型的「自带物理碰撞体」(.phy) 凸包三角形 JSON；须在导出 GLB 之前调用。 */
    export_model_phy_colliders(): string;
    /** 出生点 JSON（消费点：`spawn-loader` 与 `buildWorldBundle`）。 */
    parse_spawn_points(): string;
    /** 传送点 JSON（消费点：`apps/debug/src/world/teleport-manager.ts` 建目的地表与触发器表）。 */
    parse_teleports(): string;
    /** PVS 数据 JSON（消费点：`src/ts-shared/world/pvs-manager.ts`）。 */
    parse_pvs_data(): string;
    /** brush 平面列表 JSON，入参是 brush 过滤条件 JSON（物理碰撞体来源）。 */
    export_brushes_planes(filter_json: string): string;
    /** 缺失材质纹理名列表 JSON（VMT/VTF 缺失 → 占位色）。 */
    export_missing_textures(): string;
  }

  /** VTF 字节 → PNG 字节。本工程调用点为零（Rust 侧在解析 PAKFILE 材质时内部调用）。 */
  export function decode_vtf_to_png(data: Uint8Array): Uint8Array;

  /** PNG 字节 → mosaic 纹理字节码文本。本工程调用点为零（由离线脚本产出纹理包）。 */
  export function mosaic_encode(png: Uint8Array, name: string): string;

  /** mosaic 字节码 → PNG 字节（最近邻放大 ×scale）。调用点：`renderer-main` 的画质切换路径（经 `main-wasm` 转出）。 */
  export function mosaic_decode(code: string, scale: number): Uint8Array;

  /** 解压默认纹理包（MTZ 容器字节）→ 纹理表 JSON 文本。调用点：`apps/debug/src/app.ts` 与 `apps/debug/src/default-pack.ts`。 */
  export function decompress_mtz(bytes: Uint8Array): string;

  /**
   * 物理世界（共享自仓库根 `src/phys/mod.rs`，websurf-phys）。
   * `build_world` 的四个 JSON 入参与 `BspProcessor` 的 `export_brushes_planes` /
   * `export_model_tri_colliders` / `export_model_phy_colliders` / `parse_teleports` /
   * `parse_spawn_points` 输出同构，无需中间转换。
   */
  export class PhysWorld {
    /** 构造空世界；世界数据由 `build_world` 灌入，出生朝向在 `build_world` 里由 `spawn_yaw` 设定。 */
    constructor();
    /** 加载世界数据：brush JSON + 三角网格 JSON + 传送点 JSON + 出生位置与朝向（度）。 */
    build_world(
      brush_json: string,
      tri_json: string,
      teleport_json: string,
      spawn_x: number,
      spawn_y: number,
      spawn_z: number,
      spawn_yaw: number,
    ): void;
    /** 权威步进一个固定步长：移动 / 碰撞 / 传送 / 死亡，返回状态对象（字段见 `state`）。 */
    tick(dt: number, keys_mask: number, dx: number, dy: number): any;
    /** 预测微步：只推进运动与碰撞，不产生传送与死亡副作用。 */
    predict(dt: number, keys_mask: number, dx: number, dy: number): any;
    /** 重生到 `build_world` 给定的初始出生点。 */
    respawn(): void;
    /** 传送到指定坐标（yaw 单位为度）。 */
    teleport_to(x: number, y: number, z: number, yaw: number): void;
    /** 覆盖出生点列表，JSON 形如 `[[x,y,z,yaw], …]`。 */
    set_spawn_points(json: string): void;
    /** 传送到出生点列表的第 idx 个；越界时不做任何改动。 */
    teleport_to_spawn(idx: number): void;
    /** 覆盖位置 / 朝向 / 速度 / 着地四项；其余状态字段保持实例当前值。 */
    set_state(
      pos_x: number,
      pos_y: number,
      pos_z: number,
      yaw: number,
      pitch: number,
      vel_x: number,
      vel_y: number,
      vel_z: number,
      on_ground: boolean,
    ): void;
    /** 只覆盖速度三轴（位置与朝向不动）。 */
    set_velocity(vx: number, vy: number, vz: number): void;
    /** 只覆盖 yaw / pitch（度）。本工程调用点为零。 */
    set_yaw_pitch(yaw: number, pitch: number): void;
    /** 设置掉落死亡的 Y 阈值。 */
    set_death_y(y: number): void;
    /** 参数 JSON patch：蛇形键名，逐字段覆盖，未出现的键保持原值。 */
    set_params(json: string): void;
    /** 设置碰撞箱三围（半宽 / 站立高 / 蹲伏高，HU），即时生效。 */
    set_hull(half_width: number, stand_height: number, duck_height: number): void;
    /** 开关 noclip：开启后步进不参与碰撞，也不触发传送与死亡判定。 */
    set_noclip(enabled: boolean): void;
    /** 当前状态对象：`posX` / `posY` / `posZ`（HU）、`yaw` / `pitch`（度）、`velX` / `velY` / `velZ`（HU/s）、`onGround`、`contactTicks`、`eyeHeight`（HU）。 */
    state(): any;
    /** 取最近一次物理事件（`{ kind: 'teleport', … }` 或 `{ kind: 'death' }`），无事件返回 null；一次性消费。 */
    take_event(): any;
  }
}
  /** 同上的 bg 侧入口（只有默认导出 init）。本仓无引用点。 */

declare module '*/pkg/websurf_wasm_bg.js' {
  export default function init(): Promise<unknown>;
}
