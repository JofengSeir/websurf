/**
 * wasm 模块的环境声明：一条 `declare module` 通配声明，匹配任意前缀下的 pkg 入口文件。
 *
 * 实体声明是 wasm-pack 的产物（`npm run build:wasm` 生成到 `apps/debug/pkg/`）；本文件供该
 * 产物缺失时 tsc 解析，随 `apps/debug/tsconfig.json` 的 `include` 进入程序。
 *
 * 本文件与源码的成员集已对齐（T-007 / T-309 已结案）：`PhysWorld` 33 个成员、`BspProcessor`
 * 26 个成员，与 `npm run build:wasm` 的产物（`apps/debug/pkg/websurf_wasm.d.ts`）逐名一致；
 * 此前缺失的 16 + 12 个成员以「文件末尾的同名 interface 声明合并」补上（见文末补录块）。
 *
 * 历史缺口（供追溯）：`PhysWorld` 曾只声明 17 个成员（缺 `tick_into` / `state_out_ptr` /
 * `set_state_ex` / `state_full_json` / `seed_from` 与全部 `debug_*` 诊断），`BspProcessor` 曾缺
 * `export_glb_with_pakfile_models_with_defaults_and_lights`（`BspProcessorLike` 要求该成员）；
 * `renderer-main.ts` 的 `captureFullPhysState` / `restoreFullPhysState` 当时只能把实例收窄成
 * `as unknown as { … }` 再调 `state_full_json` / `set_state_ex`（本轮已去掉收窄）。
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
    /**
     * `.phy` 凸体块的**生成补面** JSON（VBSP `AddBrushBevels` 的移植，只服务第六路线框显示）：
     * 每块一条 `{ name, min, max, box, edge, rejected, planes: [[nx,ny,nz,d], ...] }`。
     * 内部复用 `export_model_phy_colliders` 的输出，故同样须在导出 GLB 之前调用。
     */
    export_model_phy_bevels(): string;
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
    /** 卡死（离地判定）时自动恢复默认碰撞箱三围的开关（见 src/phys/mod.rs 的 set_auto_restore_hull）。 */
    set_auto_restore_hull(enabled: boolean): void;
  }
}
  /** 同上的 bg 侧入口（只有默认导出 init）。本仓无引用点。 */

declare module '*/pkg/websurf_wasm_bg.js' {
  export default function init(): Promise<unknown>;
}

/**
 * 补录（T-007 / T-309）：与上方同名类**声明合并**（class + interface 合并），把此前缺失的成员补齐，
 * 使手写声明与 `npm run build:wasm` 的产物（`apps/debug/pkg/websurf_wasm.d.ts`）成员集逐名一致。
 * 放在文件末尾是为了不改动上方任何一行 ⇒ 文档锚点行号零漂移。
 */
declare module '*/pkg/websurf_wasm.js' {
  /** `BspProcessor` 补录的 12 个成员（T-309）。 */
  export interface BspProcessor {
    /** 导出 BSP brush 的凸包碰撞体 JSON（webgl-kz 口径：顶点 + 三角面索引）。 */
    export_colliders(): string;
    /** 同上，带 brush 过滤条件 JSON。 */
    export_colliders_with_filter(filter_json: string): string;
    /** 导出 GLB（内嵌模型由调用方给定的 models / textures JS 句柄提供）。 */
    export_glb_with_models(models_js: any, textures_js: any): Uint8Array;
    /** 导出 GLB（PAKFILE 模型 + 缺失纹理回退 + BSP 光照 + lightmap 图集面积上限）。 */
    export_glb_with_pakfile_models_with_defaults_and_atlas_limit(defaults_json: string, lightmap_max_atlas_area: number): Uint8Array;
    /** 导出 GLB（PAKFILE 模型 + 缺失纹理回退 + BSP 光照）；`buildWorldBundle` 走这条。 */
    export_glb_with_pakfile_models_with_defaults_and_lights(defaults_json: string): Uint8Array;
    /** 导出 GLB（PAKFILE 模型 + BSP 光照），不注入缺失纹理回退表。 */
    export_glb_with_pakfile_models_with_lights(): Uint8Array;
    /** 实例是否仍持有 BSP（导出入口消费后为 false）。 */
    is_alive(): boolean;
    /** 列出 PAKFILE 内打包文件名（不含内容），JSON `{ files: string[], total: number }`。 */
    list_pakfile(): string;
    /** 实体 JSON（消费点：`apps/debug/src/world/` 的实体面）。 */
    parse_entities(): string;
    /** 按名读 PAKFILE 内的文件字节。 */
    read_pakfile_file(name: string): Uint8Array;
    /** 读 PAKFILE 内的脚本清单（Lua / cfg 等参与触发逻辑的资源）。 */
    read_pakfile_scripts(): string;
    /** 释放 wasm 侧内存（wasm-bindgen 亦提供 `[Symbol.dispose]`）。 */
    free(): void;
  }

  /** `PhysWorld` 补录的 16 个成员（T-007）。 */
  export interface PhysWorld {
    /** 与 `tick` 同义但把状态写进 22 槽缓冲（零分配支路）。 */
    tick_into(dt: number, keys_mask: number, dx: number, dy: number): void;
    /** 22 槽状态缓冲的指针（零分配支路）。 */
    state_out_ptr(): number;
    /** 用全量 JSON 写回玩家状态（严格校验；失败即 Err）。 */
    set_state_ex(json: string): void;
    /** 全量状态 JSON（`include_event` 决定是否带事件槽）。 */
    state_full_json(include_event: boolean): string;
    /** 从另一实例播种（种子面 / 回放起点）。 */
    seed_from(src: PhysWorld): void;
    /** 盒-AABB 门校验被否决的次数（进程内单调递增，同一 wasm 模块共享）。 */
    gate_veto_count(): number;
    /** 诊断：对线段扫掠，返回 `[fraction, nx, ny, nz]`。 */
    debug_trace(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): Float64Array;
    /** 诊断：在给定点并置 `is_position_free` 与 `trace` 两种查询并报一致性。 */
    debug_position_probe(x: number, y: number, z: number): Float64Array;
    /** 诊断：碰撞归属（供 `.phy` / brush 之争定性）。 */
    debug_collide_attrib(x: number, y: number, z: number): Float64Array;
    /** 诊断：`tri_meshes` 第 `index` 个网格的模型名；越界返回空串。 */
    debug_tri_mesh_name(index: number): string;
    /** 诊断：`check_stuck` 候选枚举的只读重放，返回 13 个数。 */
    debug_stuck_probe(x?: number | null, y?: number | null, z?: number | null): Float64Array;
    /** 诊断：`.phy` 凸体转 brush 的统计 JSON。 */
    debug_hull_stats(): string;
    /** 诊断：取玩家当前碰撞箱六分量 `[min_x,min_y,min_z,max_x,max_y,max_z]`。 */
    debug_hull(): Float64Array;
    /** 诊断：卡死判据的盒尺寸敏感性扫描表。 */
    debug_free_table(x: number, feet_y: number, z: number, half_x: number, max_h: number, max_hz: number): Float64Array;
    /** 诊断：沿指定方向能否脱身的扫描（修法 E 的实测入口）。 */
    debug_normal_escape(x: number, y: number, z: number, nx: number, ny: number, nz: number, max_d: number): Float64Array;
    /** 释放 wasm 侧内存。 */
    free(): void;
  }
}
