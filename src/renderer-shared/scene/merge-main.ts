/**
 * 主世界合并（P2-2c 从 `render-session.ts` 的 `mergeMain()` 原样搬出）。
 *
 * 顺序即契约：动态实体打标 → `mergeIntoNewRoot`（含 rot-button / 动态实体 exclude）
 * → 逐顶点光照细分 + 平滑 → 材质二级合批 → 收动态实体组。任何一步挪位都会改变
 * 「顶点已被烘焙成世界坐标、模型身份丢失」的时机，见各段注释。
 *
 * 之所以是纯函数：`RenderSession` 只在该回调里持有这两份输入，合并产物（新根 + 组表）
 * 一次性回填，运行期没有别的写点。
 */
import * as THREE from 'three';
import { mergeIntoNewRoot, mergeOpaqueByMaterial, mergeStatsOf } from './scene-optimizer.js';
import { subdivideVertexLit } from './vlight-subdivide.js';
import { smoothVertexLighting } from '../shader/lightmap-shader.js';
import { collectDynamicEntityGroups, isDynamicEntityNode, markDynamicEntities } from './dynamic-entities.js';

export interface MergeMainOptions {
  /** 半透明/水面是否单独分块（`RenderSession.translucentSplit`）。 */
  translucentSplit: boolean;
  /** 运行期可整体变换的动态实体下标；空集/缺省表示开关关闭（整段打标与收组跳过）。 */
  dynamicEntityIndices: ReadonlySet<number> | null;
  /** 端标识，只用于日志（`RenderSession.app`）。 */
  app: string;
}

export interface MergeMainResult {
  root: THREE.Object3D;
  /** 动态实体组（key = 实体下标）；开关关闭时为 `null`（调用方保持原表不动）。 */
  dynGroups: Map<number, THREE.Group> | null;
}

export function mergeMainRoots(root: THREE.Scene, opts: MergeMainOptions): MergeMainResult {
  const dynamicSet = opts.dynamicEntityIndices;
  // 不透明块细分粒度：512 的一半（半透明/水面块不受影响，见 MergeOptions.opaqueTargetCells 注释）。
  // 实测开阔路段 344~503 draw ⇒ 主遍 3~4.4ms，不透明桶砍半是能进 320fps 预算的杠杆。
  // 再往细分（160）反而更差：同机位 route1 t=7000 311fps / t=12000 309fps（256 是 314 / 316），
  // 因为单块三角形变多、视锥裁剪变粗 ⇒ 顶点着色与填充反而上涨。256 是这里的最优点。
  // T-P1-5a：开关打开时先给动态实体打标（必须在合并前，合并会把顶点烘焙成世界坐标、
  // 丢掉模型身份）；下面的 exclude 把它们留在新根，合并结束后再按实体收进独立组。
  // 开关关闭时 `dynamicOn` 恒 false：exclude 保持旧实现，mark/collect 整段不执行。
  let dynGroups: Map<number, THREE.Group> | null = null;
  const dynamicOn = dynamicSet !== null && dynamicSet.size > 0;
  if (dynamicOn && dynamicSet) {
    const marked = markDynamicEntities(root, dynamicSet);
    if (marked > 0) {
      console.info(
        `[optimizeScene] 动态实体: ${marked} 个 mesh 脱静态合并（${dynamicSet.size} 个实体）`,
      );
    }
  }
  // `exclude`：`momentary_rot_button`（符文盘）这类要单独挂 pivot 转的实体不并进块，
  // 否则顶点被烘焙到世界空间后找不回模型边界（见 `rot-buttons.ts`）；
  // 动态 brush 实体同理（T-P1-5a，见 `dynamic-entities.ts`）。
  const optRoot = mergeIntoNewRoot(root, {
    translucentSplit: opts.translucentSplit,
    // 视距 18000 时主遍是「可见块数 × 单 draw 提交」的瓶颈（实测 5µs/draw、GPU 只忙 24%）。
    // 不透明桶再压一档（256→128）换 draw 数：`OPT_CELL_MIN = 128 HU` 会把 cell 边长夹住，
    // 所以 128 与更小的取值等价，这里写 128 表示「已到最粗」。半透明/水面桶不受影响，
    // 几何与材质不变 ⇒ cand_c 同机位截图与改前逐像素一致（diff 0 px）。
    opaqueTargetCells: 128,
    exclude: dynamicOn
      ? (m) => Boolean((m.userData as { vbspRot?: unknown }).vbspRot) || isDynamicEntityNode(m)
      : (m) => Boolean((m.userData as { vbspRot?: unknown }).vbspRot),
  });
  // 逐顶点烘焙的 prop 曲面（`s1_ramp1_b` / `s1_window01_1` 这类）在 merged chunk 上仍带
  // `_vbsp_vlight`；vhv 的条带采样不连续，Gouraud 会把跳变画成硬边（见 shader 侧
  // `smoothVertexLighting` 的说明）。放在合并之后：`applyLightmapToMeshes` 在建场景时
  // 早于这些 prop 挂载，扫不到它们。
  // 先按网格尺度均匀细分：地板/坡道这类只有 2~3 列顶点的面，靠改原顶点的值去不掉
  // 「逐行线性插值」的条带（见 vlight-subdivide.ts 的说明）；细分把插值带压到视觉以下，
  // 再做拓扑平滑收敛中点值。顺序不能反：细分后平滑才有足够的顶点可用。
  let smoothed = 0;
  let subdivided = 0;
  optRoot.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!mesh.geometry.getAttribute('_vbsp_vlight')) return;
    subdivided += subdivideVertexLit(mesh.geometry);
    smoothed += smoothVertexLighting(mesh.geometry);
  });
  if (smoothed > 0) console.info(`[optimizeScene] 逐顶点光照去接缝: 细分 ${subdivided} 层, 改写 ${smoothed} 个空间格子`);
  // 二级合批：把「同材质、不同 chunk/不同槽」的重复提交按材质并成 1 个 draw。
  // 依据（2026-11-16 实测）：终点机位可见不透明 154 mesh / 259 材质槽，但只有 55 种材质 ——
  // 主遍 306 draw / 2.30ms 的大头就是这种「同材质被切碎」。合并后仍保留 `_vbsp_face` 属性与
  // 来源区间表，PVS 三角级过滤由 `cluster-filter.ts` 的增量路径继续负责（见该文件注释）。
  // A/B：装载期 `__vbspOpaqueMatMergeOff = true` 关闭；`__vbspOpaqueMatMergeCell = HU` 开空间二级分桶。
  // 必须在这一步（vlight 平滑之后、装配返回之前）做：可见性索引与深度代理都在之后建立，
  // 会自动看到合并后的网格。
  const matStats = mergeOpaqueByMaterial(optRoot);
  if (matStats) {
    console.info(
      `[optimizeScene] 材质二级合批: ${matStats.meshes} mesh / ${matStats.slots} 槽 / ${matStats.materials} 材质` +
        ` → ${matStats.drawCallsAfter} draw（合并 ${matStats.mergedMeshes} 个，移除 ${matStats.removedMeshes} 个，` +
        `${matStats.tris} 三角，${matStats.ms.toFixed(1)}ms${matStats.failed > 0 ? `，失败 ${matStats.failed}` : ''}）`,
    );
  }
  const stats = mergeStatsOf(optRoot);
  if (stats) {
    console.log(
      `[optimizeScene] 分块合并: ${stats.meshes} mesh → ${stats.chunks} 块（${opts.app}）` +
        ` | draw call 估算 ${stats.drawCallEst}`,
    );
  }
  // T-P1-5a：合并结束后按实体收组（必须在 `mergeWaterSurfaces` 之前完成——装配侧紧接着
  // 会按父节点归并水面，提前成组能让每个实体成为独立 parent，避免跨实体水面被并掉）。
  if (dynamicOn) {
    dynGroups = collectDynamicEntityGroups(optRoot);
    if (dynGroups.size > 0) {
      console.info(`[optimizeScene] 动态实体: ${dynGroups.size} 组独立挂载（运行期可整体变换）`);
    }
  }
  return { root: optRoot, dynGroups };
}
