/**
 * 世界构建器：把 `BspProcessorLike` 的一串字节级导出收敛成一份可跨线程传递的 `WorldBundle`。
 *
 * ## 定位
 * 两个工程加载地图时的**唯一**主线程解析管线（`apps/debug/src/app.ts` 与
 * `apps/game/src/app.ts` 的 `handleLoadBsp` 都只调本函数，不再各自拼导出顺序）。
 * 本文件不读文件、不建场景、不碰 Three.js：字节由调用方读好后传入，`BspProcessorLike`
 * 由调用方构造，产出交给调用方自行分发（场景消息、物理世界、Worker）。
 *
 * ## 步骤顺序（顺序即正确性）
 * 1. `metadata()` → 归一成 `WorldMetadata`；
 * 2. 借用型导出：`parse_spawn_points()` / `parse_teleports()` / `parse_pvs_data()`；
 * 3. `export_brushes_planes()` 导出地图 brush 凸包（过滤条件见下）；
 * 4. 模型碰撞体：按 `colliderSource` 选 `export_model_tri_colliders()` 或
 *    `export_model_phy_colliders()`，失败逐级回退；
 * 5. `export_mosaic_manifest()` 与（可选）`export_missing_textures()`——**必须在第 7 步之前**，
 *    因为 `export_glb*` 会消费掉 BSP 数据；
 * 6. 默认纹理包（可选）：内嵌 base64 或 `fetch` `./textures.mtz`，交给调用方注入的解压函数；
 * 7. `export_glb_with_pakfile_models_with_defaults_and_lights()` 出 GLB，失败回退
 *    `export_glb_with_pakfile_models()`；
 * 8. 出生点 JSON 就地解析成 `spawn` / `spawnList`（yaw 经 `bspYawToCsYaw` 换算）。
 *
 * ## 抽象（调用方注入什么，就只做多少事）
 * - `colliderSource`：`'auto' | 'visual' | 'phy'`。`'visual'` 用可视网格三角形（与显示逐位一致）；
 *   `'phy'` 用模型自带 `.phy` 凸包；`'auto'` 先试 `.phy`，结果为空数组时再回退可视网格。
 *   缺省 `'auto'`；只有 `apps/debug` 会传入面板值，`apps/game` 不传。
 * - `collectMissingTextures`：为真时才调 `export_missing_textures()`；只有 debug 传。
 * - `decompressMtz`：缺省时整段跳过默认纹理包回退，`defaultsJson` 保持 `'{}'`。
 * - `onProgress`：每个阶段回调一次，回调后 `setTimeout(0)` 让出主线程（解析是同步长任务）。
 *
 * ## 容错：除 metadata 与外层导出外，每一步都各自降级
 * - 模型碰撞体导出抛错 → 记一条 `console.warn` 后改用可视网格；再失败则 `triJson = '[]'`。
 * - manifest / 缺失纹理 / 纹理包错误只 `console.warn`，对应字段留 `undefined`
 *   （GLB 与其余字段照常产出）。
 * - `spawn_points` 为空（或缺字段）时 `spawn` 退化为 `{x:0, y:100, z:0, yawDeg:0}`。
 */

import { bspYawToCsYaw } from './angles.js';
import { base64ToBytes, fetchWasmBytes } from '../wasm/loader.js';

/**
 * 本函数用到的 `BspProcessor` 结构面（各工程 `pkg` 的 `BspProcessor` 都满足）。
 *
 * 只声明被消费的方法，且全部按同步调用书写（返回值是 JSON 文本或 GLB 字节）；
 * 版本差异由各工程自己的 `pkg` 适配层承担，本文件不做运行时探测。
 */
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
  export_glb_with_pakfile_models_with_defaults_and_lights(defaultsJson: string): Uint8Array;
  export_glb_with_pakfile_models(): Uint8Array;
}

/** 模型碰撞体的来源档位；语义见文件头「抽象」一节。 */
export type ColliderSource = 'auto' | 'visual' | 'phy';

/**
 * 场景元数据。前五个字段是 `metadata()` 的必读项，读不到时分别退化为 `''` 与 `0`；
 * 其余为可选透传字段，只有 debug 侧的 `metadata()` 会给出（用 `!== undefined` 判定后展开，
 * 故 game 侧产出的对象里这些键**不存在**而不是 `undefined`）。
 */
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

/**
 * 一次解析的全部产出。
 *
 * JSON 文本字段（`brushJson` / `triJson` / `teleportJson` / `spawnJson` / `pvsJson`）原样保留，
 * 由调用方按需自行 `JSON.parse`——本函数只在内部解析出生点与模型碰撞体的实例数。
 */
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

/** 构建选项；四项全部可省，缺省行为见文件头「抽象」。 */
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

/** 缺省 brush 过滤条件；五个键与 Rust 侧 `ColliderFilter::default()` 逐字段同值。 */
const DEFAULT_BRUSH_FILTER = {
  include_ladder: true,
  include_solid: true,
  min_brush_volume: 0,
  skip_sky: true,
  skip_nodraw: false,
};

/**
 * 执行完整解析管线。
 *
 * 顺序与各步的降级行为见文件头；本函数自身不抛错（除 `metadata()` 的 JSON 解析失败）——
 * 每一步的子导出失败都被就地收敛成缺省值，故调用方拿到的一定是完整的 `WorldBundle`。
 *
 * @param proc 已构造好的 `BspProcessor`（本函数不负责其生命周期）。
 * @param options 见 `WorldBuilderOptions`。
 * @returns 解析结果；`spawn` 在无出生点时退化为 `{x:0, y:100, z:0, yawDeg:0}`。
 */
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
  // 模型碰撞体：按 colliderSource 选源，并在失败时逐级回退。
  //   visual → 可视网格三角形；phy → 模型自带 .phy 凸包；auto → 先 phy，空结果再退 visual。
  //   任何一步抛错都落到下面的 catch：先重试 visual，再失败才给 '[]'。
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

  // manifest 与缺失纹理都必须在 export_glb* 之前取：那些导出会消费 BSP 数据。
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

  // 默认纹理包：注入 decompressMtz 才走这段；两路取字节（内嵌 base64 或 fetch），
  // 解出的 JSON 交给 Rust 侧在导出 GLB 时替换缺失材质——渲染端不做后期处理。
  let defaultsJson = '{}';
  if (options.decompressMtz) {
    try {
      const embeddedMtz = (globalThis as unknown as { __VBSP_TEXTURES_MTZ_B64__?: string })
        .__VBSP_TEXTURES_MTZ_B64__;
      if (embeddedMtz) {
        // single 打包（file://）：内嵌 base64
        const mtzBytes = base64ToBytes(embeddedMtz);
        defaultsJson = options.decompressMtz(mtzBytes);
        console.log('[load-bsp] 默认纹理包已加载（内嵌，缺失纹理回退可用）');
      } else {
        const mtzBytes = await fetchWasmBytes('./textures.mtz');
        defaultsJson = options.decompressMtz(mtzBytes);
        console.log('[load-bsp] 默认纹理包已加载（缺失纹理回退可用）');
      }
    } catch (e) {
      console.warn('[load-bsp] 默认纹理包加载失败（缺失纹理保持占位色）:', e);
    }
  }
  let glbBytes: Uint8Array;
  try {
    glbBytes = proc.export_glb_with_pakfile_models_with_defaults_and_lights(defaultsJson);
  } catch (e) {
    console.warn('[load-bsp] 带默认纹理回退的 GLB 导出失败，回退无回退导出:', e);
    glbBytes = proc.export_glb_with_pakfile_models();
  }
  // 独立副本：wasm 线性内存会增长/复用，直接 transfer 原视图会连带 detach 整块内存。
  const glbBuffer = glbBytes.buffer.slice(
    glbBytes.byteOffset,
    glbBytes.byteOffset + glbBytes.byteLength,
  );

  // 出生点解析：primary 越界或为负时退到索引 0，再退到列表首项，最终退到固定占位点。
  // yaw 取 `angles[1]`（BSP 原始 Source yaw）经 `bspYawToCsYaw` 换算。
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
