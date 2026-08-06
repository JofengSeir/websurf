/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

// Quake/Source 式碰撞：世界由凸 brush（平面列表）构成，玩家 AABB 通过对每个
// brush 平面做 Minkowski 扩张、再裁剪移动线段来追踪（同 Source engine trace /
// Quake 2 的 CM_ClipBoxToBrush）。纯模块——不 import Three.js，可在 node 下跑 Vitest。

import { type Vec3, vec3, clone, dot, sub, cross } from '../../math/vec3.js';
import { DIST_EPSILON } from './Collision.config.js';
import type { Brush, Plane, TraceResult, TriMesh } from './Collision.types.js';
import type { TriEntry } from './triangle-grid.js';

export type { Plane, Brush, LadderVolume, TraceResult, TriMesh } from './Collision.types.js';

// -- Brush construction -----------------------------------------------------

export function brushFromAABB(min: Vec3, max: Vec3): Brush {
  return {
    planes: [
      { normal: vec3(1, 0, 0), dist: max.x },
      { normal: vec3(-1, 0, 0), dist: -min.x },
      { normal: vec3(0, 1, 0), dist: max.y },
      { normal: vec3(0, -1, 0), dist: -min.y },
      { normal: vec3(0, 0, 1), dist: max.z },
      { normal: vec3(0, 0, -1), dist: -min.z },
    ],
    min: clone(min),
    max: clone(max),
  };
}

/**
 * 由中心、半尺寸和正交基（局部 x/y/z 轴）构造有向盒子 brush。像 Quake 编译器
 * 那样补上盒子 AABB 的轴对齐 bevel 平面，使旋转 brush 边缘附近的平面扩张追踪
 * 保持正确。
 */
export function brushFromOrientedBox(center: Vec3, halfExtents: Vec3, ax: Vec3, ay: Vec3, az: Vec3): Brush {
  const axes: Array<[Vec3, number]> = [
    [ax, halfExtents.x],
    [ay, halfExtents.y],
    [az, halfExtents.z],
  ];

  const planes: Plane[] = [];
  for (const [a, h] of axes) {
    const d = dot(a, center);
    planes.push({ normal: clone(a), dist: d + h });
    planes.push({ normal: vec3(-a.x, -a.y, -a.z), dist: -(d - h) });
  }

  // 8 个角点的 AABB。
  const min = vec3(Infinity, Infinity, Infinity);
  const max = vec3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < 8; i++) {
    const sx = i & 1 ? 1 : -1;
    const sy = i & 2 ? 1 : -1;
    const sz = i & 4 ? 1 : -1;
    const cx = center.x + sx * halfExtents.x * ax.x + sy * halfExtents.y * ay.x + sz * halfExtents.z * az.x;
    const cy = center.y + sx * halfExtents.x * ax.y + sy * halfExtents.y * ay.y + sz * halfExtents.z * az.y;
    const cz = center.z + sx * halfExtents.x * ax.z + sy * halfExtents.y * ay.z + sz * halfExtents.z * az.z;
    min.x = Math.min(min.x, cx); min.y = Math.min(min.y, cy); min.z = Math.min(min.z, cz);
    max.x = Math.max(max.x, cx); max.y = Math.max(max.y, cy); max.z = Math.max(max.z, cz);
  }

  // Bevel 平面 = AABB 自身各面。它们完全包含盒子、不改变实体，但 Minkowski
  // 扩张后可防止盒子追踪在旋转 brush 上挂到虚假角点。
  const bevels: Plane[] = [
    { normal: vec3(1, 0, 0), dist: max.x },
    { normal: vec3(-1, 0, 0), dist: -min.x },
    { normal: vec3(0, 1, 0), dist: max.y },
    { normal: vec3(0, -1, 0), dist: -min.y },
    { normal: vec3(0, 0, 1), dist: max.z },
    { normal: vec3(0, 0, -1), dist: -min.z },
  ];
  for (const b of bevels) {
    if (!planes.some((p) => dot(p.normal, b.normal) > 0.999)) planes.push(b);
  }

  return { planes, min, max };
}

// -- Tracing ----------------------------------------------------------------

/** Minkowski 扩张：盒子 mins/maxs 使平面 dist 增加的量。 */
function planeOffset(n: Vec3, mins: Vec3, maxs: Vec3): number {
  return (
    (n.x > 0 ? mins.x : maxs.x) * n.x +
    (n.y > 0 ? mins.y : maxs.y) * n.y +
    (n.z > 0 ? mins.z : maxs.z) * n.z
  );
}

/**
 * 对一组平面做 Minkowski 扩张的扫掠盒裁剪（clipBoxToBrush 的核心循环）。
 * 约定：实体 = 各半空间交集 `dot(n, p) - dist <= 0`（法线朝外），
 * 平面列表需构成闭合/半闭合凸体；对三角形碰撞，平面来自三角形面 + 三条边。
 */
function clipPlanes(
  planes: Plane[],
  start: Vec3,
  end: Vec3,
  mins: Vec3,
  maxs: Vec3,
  result: TraceResult,
): void {
  let enterFrac = -1;
  let leaveFrac = 1;
  let clipPlane: Plane | null = null;
  let startOut = false;
  let getOut = false;

  for (const p of planes) {
    const dist = p.dist - planeOffset(p.normal, mins, maxs);
    const d1 = dot(p.normal, start) - dist;
    const d2 = dot(p.normal, end) - dist;

    if (d2 > 0) getOut = true;
    if (d1 > 0) startOut = true;
    // 起点在平面前且未明显接近则跳过。最后一项是关键稳健性守卫：物体恰好停在
    // epsilon 距离、速度与平面平行时，d2 会因端点点积的纯浮点噪声比 d1 小几个 ulp。
    // 若不跳过，每次碰撞都会记为一个极小的"命中"——把物体钉住（重力持续泵速度）
    // 并重置 clip 平面列表，使折角处理永不生效。
    if (d1 > 0 && (d2 >= DIST_EPSILON || d2 >= d1 || d1 - d2 < 1e-6)) return;
    if (d1 <= 0 && d2 <= 0) continue;

    if (d1 > d2) {
      // 通过该平面进入凸体。
      const f = (d1 - DIST_EPSILON) / (d1 - d2);
      if (f > enterFrac) {
        enterFrac = f;
        clipPlane = p;
      }
    } else {
      // 通过该平面离开凸体。
      const f = (d1 + DIST_EPSILON) / (d1 - d2);
      if (f < leaveFrac) leaveFrac = f;
    }
  }

  if (!startOut) {
    result.startSolid = true;
    if (!getOut) result.allSolid = true;
    return;
  }

  if (enterFrac < leaveFrac && enterFrac > -1 && enterFrac < result.fraction) {
    result.fraction = enterFrac < 0 ? 0 : enterFrac;
    result.normal = clipPlane!.normal;
  }
}

function clipBoxToBrush(
  brush: Brush,
  start: Vec3,
  end: Vec3,
  mins: Vec3,
  maxs: Vec3,
  result: TraceResult,
): void {
  clipPlanes(brush.planes, start, end, mins, maxs, result);
}

/**
 * 扫掠盒 vs 单个三角形（模型可视网格原样碰撞）。
 *
 * 不做任何 brush 转化：把三角形面 + 三条边表示为 5 个平面（面 ± 法线 + 3 条边），
 * 经 Minkowski 扩张后走与 brush 相同的平面裁剪。顶点顺序任意（双面碰撞），
 * 边平面方向用「质心在校准侧」自动校正，退化三角形（零面积）直接跳过。
 */
function clipBoxToTriangle(
  mesh: TriMesh,
  a: number,
  b: number,
  c: number,
  start: Vec3,
  end: Vec3,
  mins: Vec3,
  maxs: Vec3,
  result: TraceResult,
): void {
  // 顶点是紧凑数组 `[x, y, z]`（Rust serde 序列化格式）；子向量运算需 Vec3 对象
  const v0 = mesh.vertices[a];
  const v1 = mesh.vertices[b];
  const v2 = mesh.vertices[c];
  const va = vec3(v0[0], v0[1], v0[2]);
  const vb = vec3(v1[0], v1[1], v1[2]);
  const vc = vec3(v2[0], v2[1], v2[2]);

  const e1 = vec3();
  const e2 = vec3();
  sub(e1, vb, va);
  sub(e2, vc, va);
  const rawN = cross(vec3(), e1, e2);
  const nLen = Math.sqrt(dot(rawN, rawN));
  if (nLen < 1e-8) return; // 退化三角形
  const n = vec3(rawN.x / nLen, rawN.y / nLen, rawN.z / nLen);
  const d = dot(n, va);

  // 质心（用于边平面方向校准）
  const centroid = vec3((va.x + vb.x + vc.x) / 3, (va.y + vb.y + vc.y) / 3, (va.z + vb.z + vc.z) / 3);

  // 面平面：双面（±n，厚度 0；Minkowski 展开后自然分开）
  const planes: Plane[] = [
    { normal: n, dist: d },
    { normal: vec3(-n.x, -n.y, -n.z), dist: -d },
  ];

  // 三条边的侧平面：法线 = normalize(cross(edge, n))，经质心校准朝外
  for (const [pa, pb] of [
    [va, vb],
    [vb, vc],
    [vc, va],
  ] as const) {
    const e = vec3();
    sub(e, pb, pa);
    const raw = cross(vec3(), e, n);
    const len = Math.sqrt(dot(raw, raw));
    if (len < 1e-8) continue; // 与面法线平行的退化边
    let en = vec3(raw.x / len, raw.y / len, raw.z / len);
    let ed = dot(en, pa);
    // 质心必须在"内侧"（负侧）；否则翻转该边平面（顶点顺序无关）
    if (dot(en, centroid) - ed > 0) {
      en = vec3(-en.x, -en.y, -en.z);
      ed = -ed;
    }
    planes.push({ normal: en, dist: ed });
  }

  if (planes.length < 5) return;
  clipPlanes(planes, start, end, mins, maxs, result);
}

/** 扫掠盒 vs 空间索引候选三角形（模型碰撞；候选来自 TriangleGrid.query）。 */
export function traceBoxTriEntries(
  start: Vec3,
  end: Vec3,
  mins: Vec3,
  maxs: Vec3,
  entries: TriEntry[],
): TraceResult {
  const result: TraceResult = {
    fraction: 1,
    endPos: clone(end),
    normal: null,
    startSolid: false,
    allSolid: false,
  };

  const pad = 1;
  const sMinX = Math.min(start.x, end.x) + mins.x - pad;
  const sMinY = Math.min(start.y, end.y) + mins.y - pad;
  const sMinZ = Math.min(start.z, end.z) + mins.z - pad;
  const sMaxX = Math.max(start.x, end.x) + maxs.x + pad;
  const sMaxY = Math.max(start.y, end.y) + maxs.y + pad;
  const sMaxZ = Math.max(start.z, end.z) + maxs.z + pad;

  for (const e of entries) {
    if (
      e.minX > sMaxX || e.maxX < sMinX ||
      e.minY > sMaxY || e.maxY < sMinY ||
      e.minZ > sMaxZ || e.maxZ < sMinZ
    ) {
      continue;
    }
    clipBoxToTriangle(e.mesh, e.a, e.b, e.c, start, end, mins, maxs, result);
  }

  if (result.fraction < 1) {
    result.endPos.x = start.x + (end.x - start.x) * result.fraction;
    result.endPos.y = start.y + (end.y - start.y) * result.fraction;
    result.endPos.z = start.z + (end.z - start.z) * result.fraction;
  }
  return result;
}

/** 扫掠盒 vs 三角形网格集合（模型碰撞；宽阶段 = mesh AABB + 三角形 AABB）。 */
export function traceBoxTriangles(
  start: Vec3,
  end: Vec3,
  mins: Vec3,
  maxs: Vec3,
  meshes: TriMesh[],
): TraceResult {
  const result: TraceResult = {
    fraction: 1,
    endPos: clone(end),
    normal: null,
    startSolid: false,
    allSolid: false,
  };

  const pad = 1;
  const sMinX = Math.min(start.x, end.x) + mins.x - pad;
  const sMinY = Math.min(start.y, end.y) + mins.y - pad;
  const sMinZ = Math.min(start.z, end.z) + mins.z - pad;
  const sMaxX = Math.max(start.x, end.x) + maxs.x + pad;
  const sMaxY = Math.max(start.y, end.y) + maxs.y + pad;
  const sMaxZ = Math.max(start.z, end.z) + maxs.z + pad;

  for (const mesh of meshes) {
    if (
      mesh.min[0] > sMaxX || mesh.max[0] < sMinX ||
      mesh.min[1] > sMaxY || mesh.max[1] < sMinY ||
      mesh.min[2] > sMaxZ || mesh.max[2] < sMinZ
    ) {
      continue;
    }
    for (const [a, b, c] of mesh.indices) {
      // 三角形自身 AABB 粗筛（顶点为紧凑数组）
      const va = mesh.vertices[a];
      const vb = mesh.vertices[b];
      const vc = mesh.vertices[c];
      const tMinX = Math.min(va[0], vb[0], vc[0]);
      const tMaxX = Math.max(va[0], vb[0], vc[0]);
      const tMinY = Math.min(va[1], vb[1], vc[1]);
      const tMaxY = Math.max(va[1], vb[1], vc[1]);
      const tMinZ = Math.min(va[2], vb[2], vc[2]);
      const tMaxZ = Math.max(va[2], vb[2], vc[2]);
      if (
        tMinX > sMaxX || tMaxX < sMinX ||
        tMinY > sMaxY || tMaxY < sMinY ||
        tMinZ > sMaxZ || tMaxZ < sMinZ
      ) {
        continue;
      }
      clipBoxToTriangle(mesh, a, b, c, start, end, mins, maxs, result);
    }
  }

  if (result.fraction < 1) {
    result.endPos.x = start.x + (end.x - start.x) * result.fraction;
    result.endPos.y = start.y + (end.y - start.y) * result.fraction;
    result.endPos.z = start.z + (end.z - start.z) * result.fraction;
  }
  return result;
}

export function traceBox(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, brushes: Brush[]): TraceResult {
  const result: TraceResult = {
    fraction: 1,
    endPos: clone(end),
    normal: null,
    startSolid: false,
    allSolid: false,
  };

  // 宽阶段：整个移动过程的扫描 AABB。
  const pad = 1;
  const sMinX = Math.min(start.x, end.x) + mins.x - pad;
  const sMinY = Math.min(start.y, end.y) + mins.y - pad;
  const sMinZ = Math.min(start.z, end.z) + mins.z - pad;
  const sMaxX = Math.max(start.x, end.x) + maxs.x + pad;
  const sMaxY = Math.max(start.y, end.y) + maxs.y + pad;
  const sMaxZ = Math.max(start.z, end.z) + maxs.z + pad;

  for (const brush of brushes) {
    if (
      brush.min.x > sMaxX || brush.max.x < sMinX ||
      brush.min.y > sMaxY || brush.max.y < sMinY ||
      brush.min.z > sMaxZ || brush.max.z < sMinZ
    ) {
      continue;
    }
    clipBoxToBrush(brush, start, end, mins, maxs, result);
  }

  // 注意：startSolid 不钉住追踪——起点在某 brush 内仍会对其它 brush 裁剪
  // （Quake 2 语义）。脱离重叠起点是移动者的职责（PlayerController.checkStuck），
  // 否则会在此处钉住玩家、重力持续泵速度。
  if (result.fraction < 1) {
    result.endPos.x = start.x + (end.x - start.x) * result.fraction;
    result.endPos.y = start.y + (end.y - start.y) * result.fraction;
    result.endPos.z = start.z + (end.z - start.z) * result.fraction;
  }
  return result;
}

/** `origin` 处的盒子是否与（凸）体相交。 */
export function boxInBrush(origin: Vec3, mins: Vec3, maxs: Vec3, brush: Brush): boolean {
  for (const p of brush.planes) {
    const dist = p.dist - planeOffset(p.normal, mins, maxs);
    if (dot(p.normal, origin) - dist > 0) return false;
  }
  return true;
}
