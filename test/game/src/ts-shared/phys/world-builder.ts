/**
 * 世界构建器（公共化 v1）— BspProcessor 字节级导出 → WorldBundle。
 *
 * 由 game/debug 两端 handleLoadBsp 的主线程解析管线收敛：
 * metadata → spawn/teleport/pvs 借用导出 → 碰撞体（brush + 模型三角形，
 * colliderSource 三档：auto/visual/phy；debug 三档、game 固定 auto 等价）
 * → mosaic manifest → 缺失纹理（debug 特有，collectMissingTextures 开关）
 * → 默认纹理包回退（内嵌 base64 / fetch textures.mtz，decompressMtz 注入）
 * → GLB 导出（含 PAKFILE 模型 + 默认纹理回退）→ 出生点解析（含 spawnList）。
 *
 * 抽象：
 * - colliderSource：'auto' | 'visual' | 'phy'（debug 面板三档；game 缺省 auto）
 * - onProgress：解析阶段提示回调（debug 刷状态区；game 可缺省）
 * - decompressMtz：默认纹理包解压函数注入（两端 pkg 的 decompress_mtz）
 * - 不共享：渲染场景构建（GLB 加载/贴图画质）、面板 UI、计时挑战等工程特有逻辑
 */

/** BspProcessor 结构性接口（两端 pkg/websurf_wasm.js 的 BspProcessor 满足）。 */
export interface BspProcessorLike {
  metadata(): string;
  parse_spawn_points(): string;
  parse_teleports(): string;
  parse_pvs_data(): string;
  export_brushes_planes(filterJson: string): string;
  export_model_tri_colliders(): string;
  export_model_phy_colliders(): string;
  export_mosaic_manifest(): string;
  export_missing_textures(): string;
  export_glb_with_pakfile_models_with_defaults(defaultsJson: string): Uint8Array;
  export_glb_with_pakfile_models(): Uint8Array;
}

export type ColliderSource = 'auto' | 'visual' | 'phy';

/** 场景元数据（两端公共字段；debug 面板展示的扩展字段可选透传）。 */
export interface WorldMetadata {
  mapName: string;
  numFaces: number;
  numVertices: number;
  numBrushes: number;
  numModels: number;
  // ── debug 特有（元数据面板展示；game 无则缺省）──
  magic?: string;
  numLeaves?: number;
  numNodes?: number;
  numEntities?: number;
  numStaticProps?: number;
  packedFiles?: number;
}

export interface WorldBundle {
  metadata: WorldMetadata;
  brushJson: string;
  triJson: string;
  teleportJson: string;
  spawnJson: string;
  pvsJson: string;
  /** GLB 字节（transfer 零拷贝用；buffer.slice 独立副本）。 */
  glbBytes: ArrayBuffer;
  /** 纹理画质 manifest（画质切换数据源；失败时缺省）。 */
  mosaicManifest?: string;
  /** 缺失材质纹理列表（collectMissingTextures 时收集；失败时缺省）。 */
  missingTextures?: string[];
  /** 初始出生点（Y-up 坐标 + cs-movement yaw）。 */
  spawn: { x: number; y: number; z: number; yawDeg: number };
  /** 全部出生点列表（spawn 下拉切换用；[[x,y,z,yaw], ...]）。 */
  spawnList: Array<[number, number, number, number]>;
}

export interface WorldBuilderOptions {
  /** 模型碰撞来源（debug 三档；game 固定 auto 等价，缺省 auto）。 */
  colliderSource?: ColliderSource;
  /** export_brushes_planes 过滤 JSON（缺省 = Rust ColliderFilter::default）。 */
  brushFilterJson?: string;
  /** 收集缺失纹理列表（export_missing_textures；debug 特有）。 */
  collectMissingTextures?: boolean;
  /** 默认纹理包解压函数（两端 pkg decompress_mtz 注入；缺省跳过 mtz 回退）。 */
  decompressMtz?: (bytes: Uint8Array) => string;
  /** 解析阶段提示回调（debug 刷状态区；回调后让出主线程）。 */
  onProgress?: (stage: string) => void;
}

const DEFAULT_BRUSH_FILTER = {
  include_ladder: true,
  include_solid: true,
  min_brush_volume: 0,
  skip_sky: true,
  skip_nodraw: false,
};

/** BSP 方位角 yaw（顺时针）→ cs-movement yaw（逆时针）。 */
function bspYawToCsYaw(bspYaw: number): number {
  return ((270 - bspYaw) % 360 + 360) % 360;
}

export async function buildWorldBundle(
  proc: BspProcessorLike,
  options: WorldBuilderOptions = {},
): Promise<WorldBundle> {
  const yieldUi = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const stage = async (s: string): Promise<void> => {
    if (options.onProgress) {
      options.onProgress(s);
      await yieldUi();
    }
  };

  await stage('WASM 解析中');
  const rawMeta = JSON.parse(proc.metadata()) as Record<string, unknown>;
  const metadata: WorldMetadata = {
    mapName: String(rawMeta.map_name ?? ''),
    numFaces: Number(rawMeta.num_faces ?? 0),
    numVertices: Number(rawMeta.num_vertices ?? 0),
    numBrushes: Number(rawMeta.num_brushes ?? 0),
    numModels: Number(rawMeta.num_models ?? 0),
    // debug 元数据面板扩展字段（game 的 metadata() 无则缺省）
    ...(rawMeta.magic !== undefined ? { magic: String(rawMeta.magic) } : {}),
    ...(rawMeta.num_leaves !== undefined ? { numLeaves: Number(rawMeta.num_leaves) } : {}),
    ...(rawMeta.num_nodes !== undefined ? { numNodes: Number(rawMeta.num_nodes) } : {}),
    ...(rawMeta.num_entities !== undefined ? { numEntities: Number(rawMeta.num_entities) } : {}),
    ...(rawMeta.num_static_props !== undefined ? { numStaticProps: Number(rawMeta.num_static_props) } : {}),
    ...(rawMeta.packed_files !== undefined ? { packedFiles: Number(rawMeta.packed_files) } : {}),
  };

  await stage('解析出生点/传送点/PVS');
  const spawnJson = proc.parse_spawn_points();
  const teleportJson = proc.parse_teleports();
  const pvsJson = proc.parse_pvs_data();

  await stage('导出碰撞体');
  const mapBrushJson = proc.export_brushes_planes(
    options.brushFilterJson ?? JSON.stringify(DEFAULT_BRUSH_FILTER),
  );
  // 模型碰撞体：按「碰撞来源」选项选择 ——
  //   visual → 可视网格原样三角形（零转化，与显示逐位一致）
  //   auto / phy → 模型自带物理碰撞体(.phy 凸包，引擎实际碰撞)；auto 在
  //                无 .phy/空结果时回退可视网格
  // 导出失败：回退可视网格；再失败 → '[]'（game 路径）
  const colliderSource = options.colliderSource ?? 'auto';
  let brushJson = mapBrushJson;
  let triJson: string | undefined;
  try {
    if (colliderSource === 'visual') {
      triJson = proc.export_model_tri_colliders();
    } else {
      triJson = proc.export_model_phy_colliders();
      if (colliderSource === 'auto' && (JSON.parse(triJson) as unknown[]).length === 0) {
        triJson = proc.export_model_tri_colliders();
      }
    }
    console.log(
      `[load-bsp] 模型三角形碰撞网格(${colliderSource}): ${JSON.parse(triJson).length} 个实例`,
    );
  } catch (e) {
    console.warn('[load-bsp] 模型碰撞导出失败，回退可视网格:', e);
    try {
      triJson = proc.export_model_tri_colliders();
    } catch {
      triJson = '[]';
    }
  }
  await stage('导出 GLB（含 PAKFILE 模型）');

  // 纹理画质 manifest + 缺失纹理必须在 export_glb*（消费 BSP）之前生成
  let mosaicManifest: string | undefined;
  try {
    mosaicManifest = proc.export_mosaic_manifest();
  } catch (e) {
    console.warn('[load-bsp] mosaic manifest 生成失败（画质切换不可用）:', e);
  }
  let missingTextures: string[] | undefined;
  if (options.collectMissingTextures) {
    try {
      missingTextures = JSON.parse(proc.export_missing_textures()) as string[];
    } catch (e) {
      console.warn('[load-bsp] 缺失纹理列表生成失败:', e);
    }
  }

  // 缺失纹理回退数据源：默认纹理包（与地图纹理处理同一时序节点加载；
  // GLB 导出时直接在 Rust 侧把缺失材质替换为低清纹理——渲染端零后期处理）
  let defaultsJson = '{}';
  if (options.decompressMtz) {
    try {
      const embeddedMtz = (globalThis as unknown as { __VBSP_TEXTURES_MTZ_B64__?: string })
        .__VBSP_TEXTURES_MTZ_B64__;
      if (embeddedMtz) {
        // single 打包（file://）：内嵌 base64
        const bin = atob(embeddedMtz);
        const mtzBytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) mtzBytes[i] = bin.charCodeAt(i);
        defaultsJson = options.decompressMtz(mtzBytes);
        console.log('[load-bsp] 默认纹理包已加载（内嵌，缺失纹理回退可用）');
      } else {
        const resp = await fetch('./textures.mtz');
        if (resp.ok) {
          const mtzBytes = new Uint8Array(await resp.arrayBuffer());
          defaultsJson = options.decompressMtz(mtzBytes);
          console.log('[load-bsp] 默认纹理包已加载（缺失纹理回退可用）');
        }
      }
    } catch (e) {
      console.warn('[load-bsp] 默认纹理包加载失败（缺失纹理保持占位色）:', e);
    }
  }
  let glbBytes: Uint8Array;
  try {
    glbBytes = proc.export_glb_with_pakfile_models_with_defaults(defaultsJson);
  } catch (e) {
    console.warn('[load-bsp] 带默认纹理回退的 GLB 导出失败，回退无回退导出:', e);
    glbBytes = proc.export_glb_with_pakfile_models();
  }
  const glbBuffer = glbBytes.buffer.slice(
    glbBytes.byteOffset,
    glbBytes.byteOffset + glbBytes.byteLength,
  );

  // 出生点解析（primary + 全部列表；yaw 已转 cs-movement 系）
  const spawnData = JSON.parse(spawnJson) as {
    spawn_points?: Array<{ classname: string; origin: number[]; angles: number[] }>;
    primary?: number;
  };
  const spawnPoints = spawnData.spawn_points ?? [];
  const primaryIdx = (spawnData.primary ?? 0) >= 0 ? (spawnData.primary ?? 0) : 0;
  const primary = spawnPoints[primaryIdx] ?? spawnPoints[0];
  const spawn = primary
    ? {
        x: primary.origin[0],
        y: primary.origin[1],
        z: primary.origin[2],
        yawDeg: bspYawToCsYaw(primary.angles[1]),
      }
    : { x: 0, y: 100, z: 0, yawDeg: 0 };
  const spawnList: Array<[number, number, number, number]> = spawnPoints.map((sp) => [
    sp.origin[0],
    sp.origin[1],
    sp.origin[2],
    bspYawToCsYaw(sp.angles[1]),
  ]);

  return {
    metadata,
    brushJson,
    triJson: triJson ?? '[]',
    teleportJson,
    spawnJson,
    pvsJson,
    glbBytes: glbBuffer,
    mosaicManifest,
    missingTextures,
    spawn,
    spawnList,
  };
}
