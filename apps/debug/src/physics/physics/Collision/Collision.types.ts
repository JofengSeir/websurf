/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/phys/NOTICE for modification details.

import type { Vec3 } from '../../math/vec3.js';

/** 平面：半空间 `dot(normal, p) − dist <= 0` 为内侧（消费点 `apps/debug/src/world/collider-adapter.ts`）。 */
export interface Plane {
  normal: Vec3; // 朝外的单位法线（内部满足 dot(n, p) − dist <= 0）
  dist: number; // 平面常数项 = dot(normal, 平面上一点)
  /**
   * 该平面在本 brush 的物理凸包上是否构成一张有面积的真实面。
   *
   * 由上游 `export_brushes_planes` 的 `plane_is_real_face` 给出，**只被渲染端读**：
   * 物理侧 `src/phys/world.rs` 的 `clip_planes` / `box_in_brush` 按平面逐条裁剪，不看它。
   *
   * 可选是因为触发器那条路（`rebuildTriggers`）的平面来自触发器数据、没有这个标志；
   * 此时消费端按「未知」处理，不因为缺字段就当成真面。
   */
  isRealFace?: boolean;
  /**
   * 该平面是否来自 BSP 原生 bevel side（`side.bevel != 0`，编译器为"盒子别卡在棱上"
   * 生成的辅助碰撞平面；VBSP 在 `MakeBrushWindings` 里跳过 bevel 侧的 winding 裁剪，
   * 故它不构成实体表面，只服务引擎盒体扩张后的凸包补角）。
   *
   * 同样**只被渲染端读**；可选性与 `isRealFace` 同理（触发器路径没有这个标志）。
   * 与 `isRealFace` 正交：bevel 平面大多不构成有面积的面，少数照实构成。
   */
  isBevel?: boolean;
}

/** 凸包 brush：一组平面 + 其 AABB 角点。 */
export interface Brush {
  planes: Plane[];
  min: Vec3; // AABB 下界（宽阶段粗筛用）
  /** AABB 上界（宽阶段粗筛用）。 */
  max: Vec3;
}

/** 梯子体积：brush 加一个朝向。 */
export interface LadderVolume extends Brush {
  /** 可攀爬面的朝向（远离墙面，水平）。 */
  facing: Vec3;
}

/** 三元组 `[x, y, z]`：与 Rust 侧 `[f32; 3]` 的 JSON 序列化形状一致；只在本文件的 `TriMesh` 字段上使用。 */
export type V3Tuple = [number, number, number];

/** 三角形网格碰撞体（模型网格按导出原样承载，不做坐标或拓扑转换）。 */
export interface TriMesh {
  /** 世界空间顶点（与 GLB 显示网格同源；消费点 `apps/debug/src/renderer/collider-debug.ts`）。 */
  vertices: V3Tuple[];
  /** 三角形索引 `[a, b, c]`，指向 `vertices`。 */
  indices: Array<[number, number, number]>;
  /** AABB 下界（宽阶段粗筛用）。 */
  min: V3Tuple;
  /** AABB 上界（宽阶段粗筛用）。 */
  max: V3Tuple;
  /** 只有 .phy 来源（模型自带碰撞体）的条目带该字段：引擎碰撞材质名（如 `no_decal`/`grass`）。 */
  surfaceprop?: string;
}

/** 射线检测结果。本仓无消费点：TS 侧只有类型声明，实际射线检测在 Rust 侧完成。 */
export interface TraceResult {
  fraction: number; // 移动完成比例：有命中时为 [0,1)，全程无阻挡时为 1
  /** 移动终点坐标。 */
  endPos: Vec3;
  normal: Vec3 | null; // 命中平面法线；无命中时为 null
  startSolid: boolean;
  allSolid: boolean;
}
