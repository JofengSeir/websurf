#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chamfer / bevel 在边缘的行为策略验证脚本
================================================

忠实镜像 WebSurf 导出层 `crates/wasm/src/lib.rs` 的两段逻辑：

  * BSP bevel 过滤  (lib.rs:1897-1904)
        if side.bevel != 0 { continue; }   // 剔除高悬 bevel 面

  * 运行时棱边 chamfer 生成 (lib.rs:2552-2690, AddEdgeBevels 简化版)
        - 对非平行/非共面平面对 (i<j)，找同时落在两平面上的顶点
          （容差 eps_plane = 0.1 HU）。共享顶点 >=2 即是一条真实棱。
        - chamfer 法线 n_ch = normalize(n_i + n_j)
        - 方向校验：凸包上"不属于该棱的其它顶点"必须全部落在 chamfer
          平面同侧，否则丢弃（避免挤压凸包 / 凹棱误生成）。

约定：BSP 坐标，平面法线朝内（内部顶点满足 dot(n,v)-dist >= 0）。
本脚本不依赖任何 Rust 工具链，纯标准库运行，仅验证"行为策略"。

运行：python3 verify_chamfer_strategy.py

⚠️ 说明（2026-08-19 wasm 实跑，见 chamfer-bevel-analysis.md §8）：
  本脚本验证的是导出层 chamfer 生成算法（lib.rs:2552-2690）与 BSP bevel 过滤
  （lib.rs:1897-1904）的"行为策略"，属算法/概念层，非引擎实跑。实测已否定
  "导出层 chamfer 是 P2 坡顶幻影碰撞根治手段"——P2 正确方向为 src/phys/world.rs
  轴向 bevel 或端盖容差，详见 §8。

"""

import math

EPS_PLANE = 0.1  # HU，顶点在某平面上的判定容差（与 lib.rs 一致）


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def norm(a):
    l = math.sqrt(dot(a, a))
    if l < 1e-9:
        return None
    return [a[0] / l, a[1] / l, a[2] / l]


def collect_collision_planes(brush_sides, all_planes):
    """镜像 lib.rs:1897-1904 —— 剔除 side.bevel != 0 的面。

    brush_sides: list[{"plane": int, "bevel": int, ...}]
    all_planes:  list[(normal, dist)]
    返回参与碰撞的真实面列表。
    """
    used = []
    for side in brush_sides:
        if side.get("bevel", 0) != 0:   # 高悬 bevel 面直接跳过
            continue
        used.append(all_planes[side["plane"]])
    return used


def generate_chamfer_planes(planes, verts, eps=EPS_PLANE):
    """镜像 lib.rs:2552-2690 —— 运行时棱边 chamfer 生成 + 方向校验。

    planes: list[(normal, dist)]   真实面（已剔除 bevel）
    verts:  list[[x,y,z]]           brush 凸包顶点
    返回通过方向校验的 chamfer 平面列表 [(normal, dist)]
    """
    chamfers = []
    n = len(planes)
    # 预计算每个顶点落在哪些平面上
    vert_planes = []
    for v in verts:
        on = []
        for pi, (nrm, dist) in enumerate(planes):
            if abs(dot(nrm, v) - dist) < eps:
                on.append(pi)
        vert_planes.append(on)

    for i in range(n):
        ni = planes[i][0]
        for j in range(i + 1, n):
            nj = planes[j][0]
            ndot = dot(ni, nj)
            if abs(ndot) > 0.999:
                continue  # 共面/平行 → 无真实棱
            # 同时落在面 i、j 上的顶点
            shared = [vi for vi, on in enumerate(vert_planes)
                      if (i in on) and (j in on)]
            if len(shared) < 2:
                continue  # 仅共享 0/1 顶点（角点），非棱
            nch = norm([ni[0] + nj[0], ni[1] + nj[1], ni[2] + nj[2]])
            if nch is None:
                continue
            anchor = verts[shared[0]]
            dist = dot(nch, anchor)
            # 方向校验：非棱顶点必须全部落在 chamfer 同侧
            first_side = None
            valid = True
            for vi0, v in enumerate(verts):
                if vi0 in shared:
                    continue
                d = dot(nch, v) - dist
                if first_side is None:
                    first_side = 1.0 if d > 0.0 else -1.0
                elif d * first_side < -0.001:
                    valid = False
                    break
            if not valid:
                continue  # 凹棱 / 跨侧 → 丢弃
            radj = first_side if first_side is not None else 1.0
            nch_final = nch if radj > 0.0 else [-nch[0], -nch[1], -nch[2]]
            dist_final = dot(nch_final, anchor)
            chamfers.append((nch_final, dist_final))
    return chamfers


def key(n):
    return tuple(round(x, 4) for x in n)


def run():
    results = []
    print("=" * 64)
    print(" chamfer / bevel 边缘行为策略验证")
    print("=" * 64)

    # ------------------------------------------------------------------
    # 用例 1：单位立方体（完全凸）—— 12 条棱都应生成 chamfer
    # ------------------------------------------------------------------
    cube_verts = [[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    # 向内法线（BSP 约定）
    cube_planes = [
        ((-1, 0, 0), -1),   # +x 面
        ((1, 0, 0), -1),    # -x 面
        ((0, -1, 0), -1),   # +y 面
        ((0, 1, 0), -1),    # -y 面
        ((0, 0, -1), -1),   # +z 面
        ((0, 0, 1), -1),    # -z 面
    ]
    ch = generate_chamfer_planes(cube_planes, cube_verts)
    uniq = len({key(n) for n, _ in ch})
    ok = (len(ch) == 12 and uniq == 12)
    results.append(("用例1 凸立方体：12 条凸棱均生成 chamfer", ok,
                     f"生成 {len(ch)} 个（唯一方向 {uniq}），期望 12"))

    # ------------------------------------------------------------------
    # 用例 2：两平行面（无真实棱）—— 不应生成任何 chamfer
    # ------------------------------------------------------------------
    parallel_planes = [((0, -1, 0), -1), ((0, 1, 0), -1)]  # +y / -y
    par_verts = [[-1, 0, -1], [1, 0, -1], [-1, 0, 1], [1, 0, 1]]
    ch = generate_chamfer_planes(parallel_planes, par_verts)
    ok = (len(ch) == 0)
    results.append(("用例2 平行面：无共享棱，不生成 chamfer", ok,
                     f"生成 {len(ch)} 个，期望 0"))

    # ------------------------------------------------------------------
    # 用例 3：BSP bevel 过滤 —— 标记 bevel 的面被剔除
    # ------------------------------------------------------------------
    pool = [((0, -1, 0), -1), ((0, 1, 0), -1), ((1, 0, 0), -1)]
    sides = [
        {"plane": 0, "bevel": 0},   # 真实面
        {"plane": 1, "bevel": 1},   # 高悬 bevel 面 → 应剔除
        {"plane": 2, "bevel": 0},   # 真实面
    ]
    kept = collect_collision_planes(sides, pool)
    ok = (len(kept) == 2 and kept[0] == pool[0] and kept[1] == pool[2])
    results.append(("用例3 BSP bevel 过滤：bevel 面被剔除", ok,
                     f"保留 {len(kept)} 个面（期望 2，且为真实面）"))

    # ------------------------------------------------------------------
    # 用例 4：非凸顶点集（棱两侧都有凸包顶点）—— 方向校验剔除 chamfer
    # 构造：两平面交于 z 轴（x=0,y=0），但顶点同时含凹侧(-1,-1,0)
    #       与凸侧(1,1,0)，跨侧 → 应丢弃。
    # ------------------------------------------------------------------
    mixed_planes = [((0, -1, 0), 0), ((-1, 0, 0), 0)]
    mixed_verts = [
        [0, 0, -1],   # 棱上顶点
        [0, 0, 1],    # 棱上顶点
        [-1, -1, 0],  # 凹侧（两平面之外）
        [1, 1, 0],    # 凸侧（两平面之内）
    ]
    ch = generate_chamfer_planes(mixed_planes, mixed_verts)
    ok = (len(ch) == 0)
    results.append(("用例4 非凸顶点集：跨侧棱被方向校验剔除", ok,
                     f"生成 {len(ch)} 个，期望 0"))

    # ------------------------------------------------------------------
    # 用例 5（对照用例4）：仅凸侧顶点 —— 同一棱应生成 chamfer
    # ------------------------------------------------------------------
    convex_planes = [((0, -1, 0), 0), ((-1, 0, 0), 0)]
    convex_verts = [
        [0, 0, -1],   # 棱上顶点
        [0, 0, 1],    # 棱上顶点
        [1, 1, 0],    # 仅凸侧顶点
    ]
    ch = generate_chamfer_planes(convex_planes, convex_verts)
    ok = (len(ch) == 1)
    if ch:
        n = ch[0][0]
        unit = abs(math.sqrt(dot(n, n)) - 1.0) < 1e-6
        ok = ok and unit
        extra = f"法线={tuple(round(v,4) for v in n)}（单位向量={unit}）"
    else:
        extra = ""
    results.append(("用例5 凸棱（仅凸侧顶点）：生成 1 个 chamfer", ok,
                     f"生成 {len(ch)} 个，期望 1 {extra}"))

    # ------------------------------------------------------------------
    # 汇总
    # ------------------------------------------------------------------
    print()
    passed = 0
    for name, ok, detail in results:
        tag = "PASS" if ok else "FAIL"
        print(f"  [{tag}] {name}")
        print(f"         {detail}")
        passed += 1 if ok else 0
    print()
    print(f"  通过 {passed}/{len(results)}")
    print("=" * 64)
    return passed == len(results)


if __name__ == "__main__":
    import sys
    ok = run()
    sys.exit(0 if ok else 1)
