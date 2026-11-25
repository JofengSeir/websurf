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
 * 3. `export_brushes_planes()` 导出地图 brush 凸包（过滤条件见下）；可选同时/改用
 *    `export_brushes_planes_bin()` 出 WSBW 二进制块（见 `colliderEncoding`）；
 * 4. 模型碰撞体：按 `colliderSource` 选 `export_model_tri_colliders()` 或
 *    `export_model_phy_colliders()`，失败逐级回退；二进制档走 `export_model_colliders_bin()`；
 * 5. （可选）`export_missing_textures()`——**必须在第 7 步（GLB 导出）之前**：
 *    它要读 BSP 的 face/材质数据，GLB 导出会消费这些数据；
 * 6. 默认纹理包（可选）：内嵌 base64 或 `fetch` `./textures.mtz`，交给调用方注入的解压函数；
 * 7. `export_glb_with_pakfile_models_with_defaults_and_lights()` 出 GLB，失败回退
 *    `export_glb_with_pakfile_models()`；
 * 8. `take_mosaic_manifest()` 取画质 manifest——**唯一必须在 GLB 之后取的数据**：
 *    第 7 步解码 VTF 时已顺手产出 mosaic，take 直接复用；反过来说，在 GLB 之前调
 *    `export_mosaic_manifest()` 会把模型材质/贴图二次解析一遍（载图耗时大头），
 *    且 GLB 导出之后也无法再取到同一份数据；
 * 9. 出生点 JSON 就地解析成 `spawn` / `spawnList`（yaw 经 `bspYawToCsYaw` 换算）。
 *
 * ## 抽象（调用方注入什么，就只做多少事）
 * - `colliderSource`：`'auto' | 'visual' | 'phy'`。`'visual'` 用可视网格三角形（与显示逐位一致）；
 *   `'phy'` 用模型自带 `.phy` 凸包；`'auto'` 先试 `.phy`，结果为空数组时再回退可视网格。
 *   缺省 `'auto'`；只有 `apps/debug` 会传入面板值，`apps/game` 不传。
 * - `colliderEncoding`：`'json' | 'bin' | 'both'`，缺省 `'json'`。`'bin'` 只出 WSBW 二进制块
 *   （game 的物理不需要 JSON 文本）；`'both'` 两份都出（debug 的线框 overlay 仍要 JSON 里的
 *   `is_real_face` / `is_bevel`）。当前 wasm 没有 `*_bin` 导出时自动退回 JSON。
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
import { loadDefaultsJson } from '../materials/defaults.js';
import { installVmtFallback } from '../materials/vmt-fallback.js';

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
  /** WSBW 二进制 brush 块（T-D135；与 `export_brushes_planes` 同一份提取，只是不序列化 JSON）。 */
  export_brushes_planes_bin?(filterJson: string): Uint8Array;
  /** WSBW 二进制模型碰撞块，按 `source`（`auto` / `visual` / `phy`）在 Rust 侧选源+回退。 */
  export_model_colliders_bin?(source: string): Uint8Array;
  /** 单独出 `.phy` / 可视网格二进制块（当前 TS 管线不用，留给调试/对照）。 */
  export_model_phy_colliders_bin?(): Uint8Array;
  export_model_tri_colliders_bin?(): Uint8Array;
  /** `.phy` 凸体的生成补面（VBSP `AddBrushBevels` 移植）；**只有 debug 的 pkg 导出**。 */
  export_model_phy_bevels?(): string;
  /**
   * 取 `export_glb*` **顺带产出**的 mosaic manifest（画质切换数据源，JSON 文本）。
   * 必须在 GLB 导出**之后**调用；尚未导出过 GLB 时返回 `"{}"`。
   * 老产物没有该方法时调用点按 `try/catch` 降级为缺省 `undefined`（不影响 GLB 与其余字段）。
   */
  take_mosaic_manifest(): string;
  export_missing_textures(): string;
  /**
   * Source 实体 I/O 无损数据（`render_bundle::EntityIoData` 的 JSON）。
   * **可选**：只有重建过 wasm 的三端 pkg 才有这个方法；老产物没有时整条 I/O 链降级为不启用，
   * 不影响 GLB / 碰撞 / 传送等既有导出。
   * 必须在 `export_glb*` 之前调用（那几个导出会消费 BSP 数据）。
   */
  export_entity_io?(): string;
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
  /** WSBW 二进制 brush 块（独立 `ArrayBuffer`，主线程建完世界后可直接 transfer）。
   *  只有 `colliderEncoding` 含 `bin` 且 wasm 提供该导出时存在。 */
  brushBin?: ArrayBuffer;
  /** WSBW 二进制模型碰撞块（同上）。
   *  **成对约束**：`brushBin` 与 `triBin` 要么都在、要么都不在；任一块导出失败时
   *  两块一起作废并强制输出 JSON 两件套，调用方只需判断 `brushBin && triBin`。 */
  triBin?: ArrayBuffer;
  /**
   * `.phy` 凸体块的**生成补面** JSON（`export_model_phy_bevels` 的输出；只服务 debug 的
   * 第六路线框显示）。该导出只有 debug 的 `pkg` 提供，其余工程为 `'[]'`。
   */
  phyBevelsJson: string;
  teleportJson: string;
  spawnJson: string;
  pvsJson: string;
  /** GLB 字节（transfer 零拷贝用；buffer.slice 独立副本）。 */
  glbBytes: ArrayBuffer;
  /** 纹理画质 manifest（画质切换数据源；失败时缺省）。 */
  mosaicManifest?: string;
  /** 缺失材质纹理列表（collectMissingTextures 时收集；失败时缺省）。 */
  missingTextures?: string[];
  /**
   * Source 实体 I/O 原文 + 全部 `model="*N"` 实体体积（`export_entity_io()` 的 JSON 文本）。
   * `proc` 没有该方法（wasm 未重建）或导出抛错时保持 `undefined`，三端据此跳过实体运行期。
   * 与 `teleportJson` 并存但互不影响：后者仍服务旧的 Rust 物理传送判定。
   */
  entityIoJson?: string;
  /** 初始出生点（Y-up 坐标 + cs-movement yaw）。 */
  spawn: { x: number; y: number; z: number; yawDeg: number };
  /** 全部出生点列表（spawn 下拉切换用；[[x,y,z,yaw], ...]）。 */
  spawnList: Array<[number, number, number, number]>;
}

/** 构建选项；四项全部可省，缺省行为见文件头「抽象」。 */
export interface WorldBuilderOptions {
  /** 模型碰撞来源（debug 三档；game 固定 auto 等价，缺省 auto）。 */
  colliderSource?: ColliderSource;
  /** 碰撞数据编码（见文件头「抽象」；缺省 `json` = 保持既有行为）。 */
  colliderEncoding?: 'json' | 'bin' | 'both';
  /** export_brushes_planes 过滤 JSON（缺省 = Rust ColliderFilter::default）。 */
  brushFilterJson?: string;
  /** 收集缺失纹理列表（export_missing_textures；debug 特有）。 */
  collectMissingTextures?: boolean;
  /** 默认纹理包解压函数（两端 pkg decompress_mtz 注入；缺省跳过 mtz 回退）。 */
  decompressMtz?: (bytes: Uint8Array) => string;
  /** 解析阶段提示回调（debug 刷状态区；回调后让出主线程）。 */
  onProgress?: (stage: string) => void;
}

/** 缺省 brush 过滤条件；五个键与 Rust 侧 `ColliderFilter::default()` 逐字段同值。
 *  `skip_sky: false`：碰撞只看 brush 的 contents，纹理不参与；本图的 ramp 坡面碰撞
 *  就是 `CONTENTS_PLAYERCLIP` + `TOOLS/TOOLSSKYBOX` 纹理，按纹理跳过会让玩家穿坡。 */
const DEFAULT_BRUSH_FILTER = {
  include_ladder: true,
  include_solid: true,
  min_brush_volume: 0,
  skip_sky: false,
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
  /** 切出独立 `ArrayBuffer`（copy，byteOffset=0），供 `postMessage` transfer。
   *  wasm 导出的 view 可能指向共享线性内存；transfer 原 view 会连带 detach 整块内存。 */
  const toTransferable = (bytes: Uint8Array): ArrayBuffer => {
    const copy = new Uint8Array(bytes);
    return copy.buffer as ArrayBuffer;
  };
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
  // 实体 I/O 必须在 export_glb* 之前取（同一条「GLB 消费 BSP」理由）。
  // 老 wasm 产物没有这个方法 ⇒ 不启用新运行期，其余字段照常产出。
  let entityIoJson: string | undefined;
  if (typeof proc.export_entity_io === 'function') {
    try {
      entityIoJson = proc.export_entity_io();
    } catch (e) {
      console.warn('[load-bsp] 实体 I/O 导出失败，本图不启用 Source 实体运行期:', e);
    }
  }

  await stage('导出碰撞体');
  const filterJson = options.brushFilterJson ?? JSON.stringify(DEFAULT_BRUSH_FILTER);
  // 碰撞数据编码（T-D135，语义见文件头「抽象」）：
  //   json —— 两块 JSON 文本（缺省，既有行为）；
  //   bin  —— 只出 WSBW 二进制块（apps/game：省掉 JSON 字符串化与 Worker 侧解析）；
  //   both —— 两份都出（apps/debug：物理走二进制，线框 overlay 仍读 JSON 的 plane 调试标记）。
  // 老 wasm 没有 *_bin 导出时整体退回 json，绝不返回「只有一半」的世界数据。
  const encoding = options.colliderEncoding ?? 'json';
  const binCapable =
    typeof proc.export_brushes_planes_bin === 'function' &&
    typeof proc.export_model_colliders_bin === 'function';
  if (encoding !== 'json' && !binCapable) {
    console.warn('[load-bsp] 当前 wasm 没有 WSBW 二进制导出，碰撞数据退回 JSON');
  }
  const useBin = encoding !== 'json' && binCapable;
  const emitJson = encoding !== 'bin' || !useBin;

  // colliderSource 选源规则（JSON / 二进制两档共用同一判据）：
  //   visual → 可视网格三角形；phy → 模型自带 .phy 凸包；
  //   auto → 先 phy，再按实例把 .phy 缺失的模型补成可视网格。
  const colliderSource = options.colliderSource ?? 'auto';

  // 两块二进制先各试一次。**成对**是硬约束：没有任何消费者接受「一块二进制 + 一块 JSON」，
  // 缺一块就把整对作废并强制走 JSON 两件套，否则 game 会落到 world-json 却带着 '[]'。
  let brushBin: ArrayBuffer | undefined;
  let triBin: ArrayBuffer | undefined;
  if (useBin) {
    try {
      brushBin = toTransferable(proc.export_brushes_planes_bin!(filterJson));
    } catch (e) {
      console.warn('[load-bsp] brush 二进制导出失败，退回 JSON:', e);
    }
    try {
      triBin = toTransferable(proc.export_model_colliders_bin!(colliderSource));
    } catch (e) {
      console.warn('[load-bsp] 模型碰撞二进制导出失败，退回 JSON:', e);
    }
    if (!brushBin || !triBin) {
      console.warn('[load-bsp] WSBW 二进制块不完整，退回 JSON 两件套');
      brushBin = undefined;
      triBin = undefined;
    }
  }
  const useJson = emitJson || !brushBin || !triBin;

  let brushJson = '[]';
  if (useJson) {
    brushJson = proc.export_brushes_planes(filterJson);
  }

  // JSON 三角碰撞档：按 colliderSource 选源，任何一步抛错都落到下面的 catch：
  // 先重试 visual，再失败才给 '[]'。二进制档的选源+逐模型回退由 Rust 侧一条路完成。
  let triJson = '[]';
  // 已知的实例数：auto 分支上面已得，其余分支留空（日志不再为了一行数字整表 JSON.parse）
  let triCount: number | undefined;
  if (useJson) {
    try {
      if (colliderSource === 'visual') {
        triJson = proc.export_model_tri_colliders();
      } else if (colliderSource === 'auto') {
        // **逐模型**回退：`.phy` 优先，缺失/解析失败的模型改用可视网格三角形。
        // 整表为空才回退不够用——`.phy` 缺失只影响个别模型，而其余模型已产出条目 ⇒ 那些模型
        // 静默无碰撞（实测 surf_666 5 个、ze_cursed_bear 3 个模型命中这条）。
        const phyArr = JSON.parse(proc.export_model_phy_colliders()) as Array<{ name: string }>;
        const have = new Set(phyArr.map((e) => e.name));
        const visArr = JSON.parse(proc.export_model_tri_colliders()) as Array<{ name: string }>;
        const fallback = visArr.filter((e) => !have.has(e.name));
        triJson = JSON.stringify(phyArr.concat(fallback));
        triCount = phyArr.length + fallback.length;
        console.log(
          `[load-bsp] 模型碰撞(auto)：.phy ${phyArr.length} 实例 + 可视回退 ${fallback.length} 实例（${new Set(fallback.map((e) => e.name)).size} 模型）`,
        );
      } else {
        triJson = proc.export_model_phy_colliders();
      }
      const triDesc = triCount === undefined
        ? `${(triJson.length / 1048576).toFixed(1)} MB`
        : `${triCount} 个实例`;
      console.log(`[load-bsp] 模型三角形碰撞网格(${colliderSource}): ${triDesc}`);
    } catch (e) {
      console.warn('[load-bsp] 模型碰撞导出失败，回退可视网格:', e);
      try {
        triJson = proc.export_model_tri_colliders();
      } catch {
        triJson = '[]';
      }
    }
  }
  if (triBin) {
    console.log(
      `[load-bsp] 模型碰撞二进制(${colliderSource}): ${(triBin.byteLength / 1048576).toFixed(1)} MB`,
    );
  }

  // `.phy` 凸体的**生成补面**（VBSP `AddBrushBevels` 的移植，只服务 debug 的第六路线框）。
  // 该导出只有 debug 的 `pkg` 提供，其余工程 `typeof` 判定为 undefined ⇒ 保持 '[]'。
  // 必须在 `export_glb*` **之前**取：那些导出会消费 BSP 数据（与上面两组同一条理由）。
  let phyBevelsJson = '[]';
  if (typeof proc.export_model_phy_bevels === 'function') {
    try {
      phyBevelsJson = proc.export_model_phy_bevels();
    } catch (e) {
      console.warn('[load-bsp] .phy 补面导出失败（第六路线框不可用）:', e);
    }
  }

  await stage('导出 GLB（含 PAKFILE 模型）');
  // 缺失纹理必须在 export_glb* 之前取：导出会消费 BSP 的 face/材质数据。
  // （mosaic manifest 相反，必须在 GLB 之后 take，见下方）
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
  // （2026-10-04 起两路取值抽到 src/ts-shared/materials/defaults.ts，viewer 的 GLB 导出共用。）
  let defaultsJson = '{}';
  if (options.decompressMtz) {
    defaultsJson = await loadDefaultsJson(options.decompressMtz);
  }
  // 回退 VMT 文本表（游戏本体自带材质的原文）：必须在导出前装入；取不到只降级为「缺 VMT」
  await installVmtFallback(proc);
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

  // mosaic manifest 是**唯一必须在 GLB 之后取**的数据：export_glb* 解码 VTF 时已顺手产出，
  // take_mosaic_manifest() 直接复用那份结果；若仍在 GLB 之前 export_mosaic_manifest()，
  // 会把模型材质/贴图二次解析一遍（载图耗时大头），且导出 GLB 之后无法再取到同一份数据。
  // 老产物没有 take_mosaic_manifest 时由 catch 降级为缺省 undefined（画质切换不可用）。
  let mosaicManifest: string | undefined;
  try {
    mosaicManifest = proc.take_mosaic_manifest();
  } catch (e) {
    console.warn('[load-bsp] mosaic manifest take 失败（画质切换不可用）:', e);
  }

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
    triJson,
    brushBin,
    triBin,
    phyBevelsJson,
    teleportJson,
    spawnJson,
    pvsJson,
    glbBytes: glbBuffer,
    mosaicManifest,
    missingTextures,
    entityIoJson,
    spawn,
    spawnList,
  };
}
