/**
 * WASM 模块类型声明 — 当 pkg/ 不存在时供 tsc 类型检查使用
 * 实际运行时由 wasm-pack 生成（crates/wasm → pkg/websurf_wasm.js）
 */

declare module '*/pkg/websurf_wasm.js' {
  /** 初始化 WASM 模块（获取并实例化 .wasm 文件；可传 URL 或字节）。 */
  export default function init(
    module_or_path?: string | URL | Request | ArrayBuffer | Uint8Array,
  ): Promise<unknown>;

  /** 同步初始化（wasm 字节 或 `{ module: bytes }` 两种形态均支持，与 pkg 生成的 initSync 一致）。 */
  export function initSync(
    module: ArrayBuffer | Uint8Array | { module: ArrayBuffer | Uint8Array },
  ): unknown;

  /** 仅解析 BSP 元数据（不持有 Bsp 实例）。返回 BspMetadata JSON 字符串。 */
  export function parse_bsp(data: Uint8Array | ArrayBuffer): string;

  /** BSP 处理器：解析 BSP → 导出 GLB / 碰撞体 / 出生点 / 传送点 / PVS */
  export class BspProcessor {
    constructor(data: Uint8Array | ArrayBuffer);
    /** 元数据 JSON */
    metadata(): string;
    /** 导出 GLB 字节数组（消费内部 Bsp 实例） */
    export_glb(): Uint8Array;
    /** 自动从 BSP PAKFILE lump 提取模型并合并进地图 GLB（消费内部 Bsp 实例） */
    export_glb_with_pakfile_models(): Uint8Array;
    /** 带默认纹理包回退的 GLB 导出（缺失材质 → 低清纹理，消费内部 Bsp 实例） */
    export_glb_with_pakfile_models_with_defaults(defaultsJson: string): Uint8Array;
    /** 画质切换 manifest JSON（消费前调用） */
    export_mosaic_manifest(): string;
    /** 导出 PAKFILE 内嵌模型的「可视网格」三角形碰撞 JSON（零转化，与 GLB 显示逐位一致；消费前调用） */
    export_model_tri_colliders(): string;
    /** 导出 PAKFILE 内嵌模型的「自带物理碰撞体」(.phy) 凸包三角形 JSON（引擎实际碰撞；消费前调用） */
    export_model_phy_colliders(): string;
    /** 出生点 JSON */
    parse_spawn_points(): string;
    /** 传送点 JSON */
    parse_teleports(): string;
    /** PVS 数据 JSON */
    parse_pvs_data(): string;
    /** brush 平面列表 JSON（物理碰撞用） */
    export_brushes_planes(filter_json: string): string;
    /** 缺失材质纹理列表（VMT/VTF 缺失 → 占位色）JSON 字符串数组 */
    export_missing_textures(): string;
  }

  /** VTF → PNG 解码 */
  export function decode_vtf_to_png(data: Uint8Array): Uint8Array;

  /** PNG 字节 → mosaic v4 纹理字节码（压缩；画质切换 manifest 生成）。 */
  export function mosaic_encode(png: Uint8Array, name: string): string;

  /** mosaic v4 字节码 → PNG 字节（低清还原，最近邻放大 ×scale，默认 ×8）。 */
  export function mosaic_decode(code: string, scale: number): Uint8Array;

  /** 解压默认配置纹理包（textures.mtz，MTZ5 容器）→ textures.json 文本。 */
  export function decompress_mtz(bytes: Uint8Array): string;

  /**
   * 物理世界（共享自仓库根 src/，websurf-phys；game 同源）。
   * build_world 输入与 BspProcessor 的 export_brushes_planes /
   * export_model_tri_colliders / export_model_phy_colliders / parse_teleports /
   * parse_spawn_points 输出同构，无需中间转换。
   */
  export class PhysWorld {
    constructor();
    /** 加载世界数据（brush JSON + tri JSON + teleport JSON + spawn 位置/朝向） */
    build_world(
      brush_json: string,
      tri_json: string,
      teleport_json: string,
      spawn_x: number,
      spawn_y: number,
      spawn_z: number,
      spawn_yaw: number,
    ): void;
    /** 物理步进（权威）：移动/碰撞/传送/死亡。返回状态对象 */
    tick(dt: number, keys_mask: number, dx: number, dy: number): any;
    /** 预测微步（轻量预测，禁用传送/死亡副作用） */
    predict(dt: number, keys_mask: number, dx: number, dy: number): any;
    /** 重生到初始出生点 */
    respawn(): void;
    /** 传送到指定坐标 */
    teleport_to(x: number, y: number, z: number, yaw: number): void;
    /** 设置出生点列表（teleport_to_spawn 用） */
    set_spawn_points(json: string): void;
    /** 传送到出生点列表第 idx 个 */
    teleport_to_spawn(idx: number): void;
    /** 覆盖全状态（预测基线修正） */
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
    /** 只覆盖速度（每帧权威速度外推校准） */
    set_velocity(vx: number, vy: number, vz: number): void;
    /** 只覆盖朝向 */
    set_yaw_pitch(yaw: number, pitch: number): void;
    /** 设置死亡 Y 阈值 */
    set_death_y(y: number): void;
    /** 参数 JSON patch（snake_case 字段，见共享 crate player.rs PhysParams） */
    set_params(json: string): void;
    /** 碰撞箱尺寸 */
    set_hull(half_width: number, stand_height: number, duck_height: number): void;
    /** 自由视角开关 */
    set_noclip(enabled: boolean): void;
    /** 当前状态 {posX,posY,posZ,yaw,pitch,velX,velY,velZ,onGround,contactTicks,eyeHeight} */
    state(): any;
    /** 取最近一次物理事件（{kind:'teleport'|'death', ...}），无事件返回 null；一次性消费 */
    take_event(): any;
  }
}

declare module '*/pkg/websurf_wasm_bg.js' {
  export default function init(): Promise<unknown>;
}
