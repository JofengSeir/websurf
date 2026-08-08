/**
 * 世界适配层：碰撞体反腐败层
 * 将 WASM export_brushes_planes 输出的 JSON（WasmBrush[]）转换为
 * cs-movement 原生类型 Brush[] / LadderVolume[]，填入 World.solids / World.ladders。
 * 坐标约定：Rust 端已统一旋转为 Y-up（[x,y,z]→[y,z,x]，det=+1），TS 端不再二次重映射。
 * 法线约定（关键）：vbsp 平面用"法线朝内"（内部 dot(n,p)-dist>=0），cs-movement 用"法线朝外"
 *（内部 dot(n,p)-dist<=0）；Rust export_brushes_planes 已对每平面取负 normal/dist 翻转，TS 端不再处理。
 */

import type { Vec3 } from '../physics/math/vec3.js';
import type { Brush, LadderVolume, Plane } from '../physics/physics/Collision/Collision.types.js';
import { type WasmBrush, type WasmBrushPlane } from './types.js';

// ---------------------------------------------------------------------------
// 适应度函数 F2：法线朝外验证
// ---------------------------------------------------------------------------

/** 单 brush 法线朝外验证结果。 */
export interface BrushNormalCheck {
  /** brush 在 `solids` / `ladders` 数组中的索引（仅用于诊断）。 */
  brushIndex: number;
  /** 平面数。 */
  numPlanes: number;
  /** AABB 中心。 */
  center: Vec3;
  /** 朝外法线数（应为平面总数）。 */
  outwardCount: number;
  /** 朝内法线数（应为 0）。 */
  inwardCount: number;
  /** 朝内平面的索引列表（用于诊断）。 */
  inwardPlanes: number[];
  /** 是否通过验证（outwardCount === numPlanes）。 */
  passed: boolean;
}

/** 整批 brush 的法线朝外验证结果。 */
export interface NormalCheckReport {
  /** 总 brush 数。 */
  total: number;
  /** 通过验证的 brush 数。 */
  passed: number;
  /** 失败的 brush 数。 */
  failed: number;
  /** 每个 brush 的详细验证结果。 */
  brushes: BrushNormalCheck[];
}

// ---------------------------------------------------------------------------
// LadderVolume.facing 计算
// ---------------------------------------------------------------------------

/**
 * 计算梯子 brush 的 facing 方向（水平、指向墙外）。
 * 启发式：BSP ladder brush 是薄片体（一面贴墙背面、对面可攀爬），
 * 1. 计算所有平面水平度（sqrt(nx²+nz²)）；
 * 2. 选水平度最高者为"正面候选"；
 * 3. 取其法线水平分量并归一化。
 * 限制：无法区分正/背面（水平度相同）；方向错误会朝墙内跳，可后续改进。
 * @param planes brush 平面列表（法线已旋转为 Y-up）。
 * @returns 归一化的水平 facing 方向。
 */
function computeLadderFacing(planes: Plane[]): Vec3 {
  if (planes.length === 0) {
    return { x: 0, y: 0, z: 1 }; // 默认 +Z（任意安全方向）
  }

  let bestPlane = planes[0];
  let bestHoriz = -1;
  for (const p of planes) {
    // 水平度：法线在 XZ 平面的投影长度
    const horiz = Math.sqrt(p.normal.x * p.normal.x + p.normal.z * p.normal.z);
    if (horiz > bestHoriz) {
      bestHoriz = horiz;
      bestPlane = p;
    }
  }

  // 取水平分量并归一化（丢弃 Y 分量）
  let fx = bestPlane.normal.x;
  let fz = bestPlane.normal.z;
  const len = Math.sqrt(fx * fx + fz * fz);
  if (len > 1e-6) {
    fx /= len;
    fz /= len;
  } else {
    // 平面法线接近垂直（罕见），默认 +Z
    fx = 0;
    fz = 1;
  }
  return { x: fx, y: 0, z: fz };
}

// ---------------------------------------------------------------------------
// 主转换函数
// ---------------------------------------------------------------------------

/** `adaptBrushes` 的输出。 */
export interface AdaptedBrushes {
  /** SOLID brush 列表，填入 `World.solids`。 */
  solids: Brush[];
  /** LADDER brush 列表（带 facing），填入 `World.ladders`。 */
  ladders: LadderVolume[];
  /** 转换统计（用于诊断）。 */
  stats: AdaptBrushStats;
}

/** 转换统计。 */
export interface AdaptBrushStats {
  /** 输入 brush 总数。 */
  total: number;
  /** 转换为 solid 的数量。 */
  solids: number;
  /** 转换为 ladder 的数量。 */
  ladders: number;
  /** 跳过的 brush 数（平面数 < 4 或 AABB 无效）。 */
  skipped: number;
  /** 跳过原因明细。 */
  skipReasons: {
    emptyPlanes: number;
    tooFewPlanes: number;
    invalidAabb: number;
    notSolidNotLadder: number;
  };
}

/** 默认跳过阈值（planes < 4 视为退化 brush）。 */
const MIN_PLANES_PER_BRUSH = 4;

/** AABB 有效性的最小尺寸（HU，防止退化 brush）。 */
const MIN_AABB_SIZE = 0.001;

/**
 * 将 WASM 输出的 WasmBrush[] JSON 转换为 cs-movement 原生类型。
 * @param wasmJson export_brushes_planes 返回的 JSON 字符串。
 * @returns { solids, ladders, stats }，分别填入 World.solids 与 World.ladders。
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
    // 跳过既非 solid 又非 ladder 的 brush（不应出现，但防御性处理）
    if (!wb.is_solid && !wb.is_ladder) {
      stats.skipped++;
      stats.skipReasons.notSolidNotLadder++;
      continue;
    }

    // 平面数检查
    if (!wb.planes || wb.planes.length === 0) {
      stats.skipped++;
      stats.skipReasons.emptyPlanes++;
      continue;
    }
    if (wb.planes.length < MIN_PLANES_PER_BRUSH) {
      stats.skipped++;
      stats.skipReasons.tooFewPlanes++;
      continue;
    }

    // AABB 有效性检查
    const aabbValid =
      wb.max[0] - wb.min[0] > MIN_AABB_SIZE &&
      wb.max[1] - wb.min[1] > MIN_AABB_SIZE &&
      wb.max[2] - wb.min[2] > MIN_AABB_SIZE;
    if (!aabbValid) {
      stats.skipped++;
      stats.skipReasons.invalidAabb++;
      continue;
    }

    // 转换平面（直接映射，坐标已在 Rust 端旋转）
    const planes: Plane[] = wb.planes.map((wp: WasmBrushPlane) => ({
      normal: { x: wp.normal[0], y: wp.normal[1], z: wp.normal[2] },
      dist: wp.dist,
    }));

    // 转换 AABB
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
// 适应度函数 F2：法线朝外批量验证
// ---------------------------------------------------------------------------

/**
 * 验证一批 brush 的平面法线是否全部朝外（适应度函数 F2）。
 * 对每个 brush 检查 AABB 中心 c 满足 dot(n, c) - dist <= 0（中心在平面内侧 → 法线朝外）。
 * 假设 brush 为凸且中心在其内部；极端非凸 brush 可能误报。
 * @param brushes 待验证的 brush 列表（solids + ladders）。
 * @returns 验证报告，包含每个 brush 的详细结果。
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
        // 中心在平面内侧（含容差）→ 法线朝外
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
// 诊断辅助：打印转换统计
// ---------------------------------------------------------------------------

/**
 * 将转换统计格式化为可读字符串（用于 console.log）。
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
