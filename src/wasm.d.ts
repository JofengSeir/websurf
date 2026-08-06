/**
 * WASM 模块类型声明 — 当 pkg/ 不存在时供 tsc 类型检查使用
 * 实际运行时由 wasm-pack 生成（crates/wasm → pkg/websurf_wasm.js）
 */

declare module '*/pkg/websurf_wasm.js' {
  /** 初始化 WASM 模块（获取并实例化 .wasm 文件；可传 URL 或字节）。 */
  export default function init(
    module_or_path?: string | URL | Request | ArrayBuffer | Uint8Array,
  ): Promise<unknown>;

  /** 同步初始化（dist 内嵌模式：传入 { module: ArrayBuffer }）。 */
  export function initSync(module: { module: ArrayBuffer }): unknown;

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
    /** 导出 PAKFILE 内嵌模型的碰撞体 JSON（消费前调用；与 brush JSON 同构） */
    export_model_colliders(): string;
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
  }

  /** VTF → PNG 解码 */
  export function decode_vtf_to_png(data: Uint8Array): Uint8Array;
}

declare module '*/pkg/websurf_wasm_bg.js' {
  export default function init(): Promise<unknown>;
}
