/**
 * brush 映射层：把 `BspProcessor::export_brushes_planes`（`apps/debug/crates/wasm/src/lib.rs`）
 * 产出的 `WasmBrush[]` JSON 映射成 cs-movement 形状的 `Brush[]` / `LadderVolume[]`
 *（类型定义在 `apps/debug/src/physics/physics/Collision/Collision.types.ts`）。
 *
 * ## 定位：主线程的本地副本，不参与物理
 * 物理侧另有一份同源解析：worker 里的 `PhysWorld::build_world`（`src/phys/mod.rs`）吃
 * **同一串** `brushJson`，在 Rust 内建 `World.solids` / `World.ladders` 并承担碰撞与梯子判定。
 * 本文件的产出只填 `RendererMain` 的本地数组 `solids` / `ladders` / `colliders`
 *（`apps/debug/src/renderer/renderer-main.ts` 的 `loadScene`），供
 * `apps/debug/src/renderer/collider-debug.ts` 画 brush 线框与命中、
 * `apps/debug/src/renderer/plane-inspector.ts` 做准星拾取。
 *
 * ## 输入约定（上游已做，本文件不做任何几何变换）
 * - 坐标已是 Y-up：上游按 `[x,y,z] → [y,z,x]` 循环置换顶点（行列式 +1）。
 * - 法线已翻成朝外：上游对每个平面取 `normal = -rotate_yup(n)`、`dist = -dist`，
 *   使内部满足 `dot(normal, p) - dist <= 0`，与 `Collision.types.ts` 的 `Plane` 同口径。
 * - `planes` = 该 brush 的原始面，加上上游运行时生成的棱边 chamfer 平面。
 * - `min` / `max` = 凸包顶点旋转到 Y-up 后的逐轴极值。
 *
 * ## 本文件的分支与不变量
 * - 顺序固定：既非 solid 又非 ladder → 平面数组为空 → 平面数 < `MIN_PLANES_PER_BRUSH`
 *   → AABB 三轴尺寸不都大于 `MIN_AABB_SIZE`，任一命中即计入 `stats.skipped` 并跳过该 brush。
 * - ladder 优先：`is_ladder` 与 `is_solid` 同时为真时只进 `ladders`，
 *   与上游 `build_world` 的 `if is_ladder … else if is_solid` 分支顺序一致。
 * - 输出顺序与输入顺序一致；`stats.total` 取输入数组长度，
 *   `stats.solids + stats.ladders + stats.skipped` 恒等于它。
 * - 本文件只读输入、只写自己的输出数组，不改入参、无全局状态。
 *
 * ## 失败语义
 * `JSON.parse` 的异常不兜；`WasmBrush` 结构缺字段时在该字段的读取处抛错。
 * 本文件不抛自有错误、不打印日志。
 *
 * ## 本工作区内零调用点的导出
 * `verifyOutwardNormals` / `formatAdaptStats` 与 `AdaptedBrushes.stats` 全仓无消费点
 *（`loadScene` 只取 `solids` / `ladders`）。
 */

import type { Vec3 } from '../physics/math/vec3.js';
import type { Brush, LadderVolume, Plane } from '../physics/physics/Collision/Collision.types.js';
import { type WasmBrush, type WasmBrushPlane } from './types.js';

// ---------------------------------------------------------------------------
// 法线朝外校验：结果类型
// ---------------------------------------------------------------------------

/** 单个 brush 的法线朝外校验结果（由 `verifyOutwardNormals` 逐 brush 产出）。 */
export interface BrushNormalCheck {
  /** brush 在**入参数组**中的下标（入参通常是 solids 与 ladders 的合并顺序）。 */
  brushIndex: number;
  /** 该 brush 的平面数。 */
  numPlanes: number;
  /** AABB 中心（判定用的参考点，按 `min` / `max` 逐轴取中值，不是几何重心）。 */
  center: Vec3;
  /** 判为朝外的平面数。 */
  outwardCount: number;
  /** 判为朝内的平面数；与 `outwardCount` 之和恒为 `numPlanes`。 */
  inwardCount: number;
  /** 判为朝内的平面在 `brush.planes` 中的下标（按扫描顺序）。 */
  inwardPlanes: number[];
  /** `outwardCount === numPlanes`。平面数为 0 时循环不执行、两侧都是 0，故判为通过。 */
  passed: boolean;
}

/** 整批 brush 的法线朝外校验结果。 */
export interface NormalCheckReport {
  /** 入参 brush 总数（= `brushes.length`）。 */
  total: number;
  /** `passed` 为真的 brush 数。 */
  passed: number;
  /** `passed` 为假的 brush 数；与 `passed` 之和恒为 `total`。 */
  failed: number;
  /** 逐 brush 结果，顺序与入参一致。 */
  brushes: BrushNormalCheck[];
}

// ---------------------------------------------------------------------------
// ladder 面朝向
// ---------------------------------------------------------------------------

/**
 * 求 ladder brush 的可攀爬面朝向（水平，y 分量恒为 0）。
 *
 * 逐平面算水平度 `sqrt(nx² + nz²)`，取**严格最大**者（并列时取先遇到的那个），
 * 再把该面法线的 x / z 分量归一化；`planes` 为空、或选中面法线的水平分量
 * `<= 1e-6` 时统一回退 `(0, 0, 1)`。
 *
 * 方向取决于选中面的法线符号：算法只按水平度选面，不区分同一薄片体的正反面。
 * 同一算法在 Rust 侧另有一份实现（`src/phys/mod.rs` 的 `compute_ladder_facing`），
 * 其结果写进 `world::LadderVolume.facing` 并被 `src/phys/player.rs` 的梯子逻辑读取；
 * 本文件算出的 `facing` 在本工程内无读取点。
 *
 * @param planes brush 平面列表（法线朝外、Y-up）。
 * @returns 单位化的水平朝向。
 */
function computeLadderFacing(planes: Plane[]): Vec3 {
  if (planes.length === 0) {
    return { x: 0, y: 0, z: 1 }; // 无平面：回退 +Z
  }

  let bestPlane = planes[0];
  let bestHoriz = -1;
  for (const p of planes) {
    // 水平度 = 法线在 XZ 平面的投影长度
    const horiz = Math.sqrt(p.normal.x * p.normal.x + p.normal.z * p.normal.z);
    if (horiz > bestHoriz) {
      bestHoriz = horiz;
      bestPlane = p;
    }
  }

  // 取水平分量归一化，丢弃 Y 分量
  let fx = bestPlane.normal.x;
  let fz = bestPlane.normal.z;
  const len = Math.sqrt(fx * fx + fz * fz);
  if (len > 1e-6) {
    fx /= len;
    fz /= len;
  } else {
    // 选中面接近水平（法线接近竖直）：回退 +Z
    fx = 0;
    fz = 1;
  }
  return { x: fx, y: 0, z: fz };
}

// ---------------------------------------------------------------------------
// 主转换函数
// ---------------------------------------------------------------------------

/** `adaptBrushes` 的产出：两张 brush 表加转换统计。 */
export interface AdaptedBrushes {
  /** SOLID brush 表（`is_ladder` 为假的那些）。 */
  solids: Brush[];
  /** LADDER brush 表（`is_ladder` 为真，附 `computeLadderFacing` 算出的 `facing`）。 */
  ladders: LadderVolume[];
  /** 转换统计；本工作区内无消费点。 */
  stats: AdaptBrushStats;
}

/** 转换统计：总量、两类产出量与四类跳过原因的计数。 */
export interface AdaptBrushStats {
  /** 输入 `WasmBrush[]` 的长度。 */
  total: number;
  /** 写入 `solids` 的数量。 */
  solids: number;
  /** 写入 `ladders` 的数量。 */
  ladders: number;
  /** 被跳过的总数 = `skipReasons` 四项之和。 */
  skipped: number;
  /** 跳过原因明细，按闸门顺序；每个 brush 至多计入一项（命中即 `continue`）。 */
  skipReasons: {
    /** `is_solid` 与 `is_ladder` 同时为假。 */
    notSolidNotLadder: number;
    /** `planes` 缺失或长度为 0。 */
    emptyPlanes: number;
    /** `planes.length < MIN_PLANES_PER_BRUSH`。 */
    tooFewPlanes: number;
    /** AABB 至少有一轴 `max - min <= MIN_AABB_SIZE`。 */
    invalidAabb: number;
  };
}

/** 平面数下限：低于它的 brush 视为退化，跳过（阈值与上游 `export_brushes_planes` 的
 * `bsp_planes.len() < 4` 相同，但闸门位置不同——上游在收集 brush_sides 之后、
 * 本文件在该 JSON 的平面数组上）。 */
const MIN_PLANES_PER_BRUSH = 4;

/** AABB 有效性下限（HU）：三轴都要求 `max - min` 严格大于它。 */
const MIN_AABB_SIZE = 0.001;

/**
 * 把 `export_brushes_planes` 的 `WasmBrush[]` JSON 映射成 cs-movement 形状的 brush。
 *
 * 逐 brush 走文件头列出的四道闸门；通过后把平面逐项映射成 `Plane`（只取 `normal` 与 `dist`，
 * 上游 `WasmBrushPlane` 无其他字段），AABB 逐轴拷进 `Vec3`，
 * 再按 `is_ladder` 分流（ladder 分支额外算 `facing`）。
 *
 * @param wasmJson `BspProcessor::export_brushes_planes(filterJson)` 返回的 JSON 文本。
 * @returns `{ solids, ladders, stats }`；三个字段都新建，不复用入参对象。
 */
export function adaptBrushes(wasmJson: string): AdaptedBrushes {
  const data: WasmBrush[] = JSON.parse(wasmJson);

  const solids: Brush[] = [];
  const ladders: LadderVolume[] = [];
  const stats: AdaptBrushStats = {
    total: data.length,
    solids: 0,
    ladders: 0,
    skipped: 0,
    skipReasons: {
      emptyPlanes: 0,
      tooFewPlanes: 0,
      invalidAabb: 0,
      notSolidNotLadder: 0,
    },
  };

  for (const wb of data) {
    // 闸门一：两个标志都为假
    if (!wb.is_solid && !wb.is_ladder) {
      stats.skipped++;
      stats.skipReasons.notSolidNotLadder++;
      continue;
    }

    // 闸门二：平面数组缺失或为空
    if (!wb.planes || wb.planes.length === 0) {
      stats.skipped++;
      stats.skipReasons.emptyPlanes++;
      continue;
    }
    // 闸门三：平面数低于下限
    if (wb.planes.length < MIN_PLANES_PER_BRUSH) {
      stats.skipped++;
      stats.skipReasons.tooFewPlanes++;
      continue;
    }

    // 闸门四：AABB 三轴都必须严格大于 MIN_AABB_SIZE
    const aabbValid =
      wb.max[0] - wb.min[0] > MIN_AABB_SIZE &&
      wb.max[1] - wb.min[1] > MIN_AABB_SIZE &&
      wb.max[2] - wb.min[2] > MIN_AABB_SIZE;
    if (!aabbValid) {
      stats.skipped++;
      stats.skipReasons.invalidAabb++;
      continue;
    }

    // 平面逐项直映（坐标与法线方向已在 Rust 端处理完）
    const planes: Plane[] = wb.planes.map((wp: WasmBrushPlane) => ({
      normal: { x: wp.normal[0], y: wp.normal[1], z: wp.normal[2] },
      dist: wp.dist,
    }));

    // AABB 逐轴直映
    const min: Vec3 = { x: wb.min[0], y: wb.min[1], z: wb.min[2] };
    const max: Vec3 = { x: wb.max[0], y: wb.max[1], z: wb.max[2] };

    if (wb.is_ladder) {
      const facing = computeLadderFacing(planes);
      ladders.push({ planes, min, max, facing });
      stats.ladders++;
    } else {
      solids.push({ planes, min, max });
      stats.solids++;
    }
  }

  return { solids, ladders, stats };
}

// ---------------------------------------------------------------------------
// 法线朝外批量校验
// ---------------------------------------------------------------------------

/**
 * 校验一批 brush 的平面法线是否全部朝外。
 *
 * 逐 brush 取 AABB 中心 `c`，对每个平面算 `d = dot(n, c) - dist`：
 * `d <= 1e-3` 计朝外，否则计朝内并记录平面下标；`passed` 要求朝外数等于平面总数。
 * 判定把 AABB 中心当内部点，故对中心落在凸包外的退化 brush 会给出朝内的结论。
 *
 * @param brushes 待校验的 brush 列表（可传 `solids` 与 `ladders` 的合并数组）。
 * @returns 报告；`total` / `passed` / `failed` 与 `brushes` 逐项对应。
 */
export function verifyOutwardNormals(brushes: Brush[]): NormalCheckReport {
  const report: NormalCheckReport = {
    total: brushes.length,
    passed: 0,
    failed: 0,
    brushes: [],
  };

  for (let i = 0; i < brushes.length; i++) {
    const brush = brushes[i];
    const center: Vec3 = {
      x: (brush.min.x + brush.max.x) * 0.5,
      y: (brush.min.y + brush.max.y) * 0.5,
      z: (brush.min.z + brush.max.z) * 0.5,
    };

    let outward = 0;
    let inward = 0;
    const inwardPlanes: number[] = [];

    for (let j = 0; j < brush.planes.length; j++) {
      const p = brush.planes[j];
      const d = p.normal.x * center.x + p.normal.y * center.y + p.normal.z * center.z - p.dist;
      if (d <= 1e-3) {
        // 中心在平面内侧（含 1e-3 容差）→ 法线朝外
        outward++;
      } else {
        inward++;
        inwardPlanes.push(j);
      }
    }

    const passed = outward === brush.planes.length;
    report.brushes.push({
      brushIndex: i,
      numPlanes: brush.planes.length,
      center,
      outwardCount: outward,
      inwardCount: inward,
      inwardPlanes,
      passed,
    });
    if (passed) {
      report.passed++;
    } else {
      report.failed++;
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// 统计格式化
// ---------------------------------------------------------------------------

/**
 * 把转换统计拼成单行文本（供调用方自行 `console.log`，本文件不打印）。
 * 字段顺序固定：`total` / `solids` / `ladders` / `skipped`，
 * 括注内按 `empty` / `fewPlanes` / `badAabb` / `notSolidLadder` 排列。
 */
export function formatAdaptStats(stats: AdaptBrushStats): string {
  const r = stats.skipReasons;
  return (
    `[AdaptBrushes] total=${stats.total} solids=${stats.solids} ` +
    `ladders=${stats.ladders} skipped=${stats.skipped} ` +
    `(empty=${r.emptyPlanes} fewPlanes=${r.tooFewPlanes} ` +
    `badAabb=${r.invalidAabb} notSolidLadder=${r.notSolidNotLadder})`
  );
}
