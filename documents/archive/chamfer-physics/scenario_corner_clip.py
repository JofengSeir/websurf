#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
场景测试：人物经过凸棱时的边角剐蹭（前者 / 原始未处理情形）
============================================================

背景
----
WebSurf 的物理碰撞里，人物是一个盒形（近似 AABB，可带朝向角 theta），
世界是 brush 构成的凸棱/凸角。原始（未做 chamfer/bevel 处理）的碰撞在
"人物中心到凸角的 clearance 略大于人物半宽 h"时，轴对齐(theta=0)本应安全，
但人物一旦旋转，盒角会伸得更远，于是仍被尖锐凸角剐蹭。这就是需要先复现的
"前者"bug 场景。

本脚本只测【前者】：用 2D 横截面仿真（凸角 + 旋转盒形人物沿直线 y=d 扫掠），
以 SAT(分离轴定理) 判定人物盒与世界凸角是否相交(剐蹭)，复现取向相关的剐蹭。

坐标约定：2D 平面 (x,y)，世界凸角占据第三象限 x<=0 且 y<=0，棱尖在原点 (0,0)，
凸角朝向 +x,+y。人物盒中心沿 x 从 -SWEEP_HALF 扫到 +SWEEP_HALF，y 固定为 clearance d。

结论判据（前者复现成功 = 原始模型确实存在取向相关剐蹭）：
  * 轴对齐 theta=0 时，最大会剐蹭的 clearance = h（半宽），符合直觉；
  * 旋转 theta=45° 时，最大会剐蹭的 clearance = h*sqrt(2)（半对角线）；
  * 故存在 band (h, h*sqrt(2))：在该 clearance 上 theta=0 安全、theta=45° 剐蹭
    —— 即"理论上可能不会被剐蹭、实际却剐蹭"的前者 bug。

【后者】chamfer/bevel 处理后"任意朝向角都不剐蹭"的验证，见文件末尾
test_after_chamfer() 占位函数，按需求先放着不动（未调用）。

运行：python3 scenario_corner_clip.py

⚠️ 与真实引擎的差异（2026-08-19 wasm 实跑，见 chamfer-bevel-analysis.md §8）：
  本脚本是"通用碰撞模型"的概念验证，并非 WebSurf 引擎实跑。真实引擎碰撞盒
  轴对齐、yaw 不旋转（player.rs:959-964），因此"45°→h√2 剐蹭带"在引擎中不存在；
  wasm 实跑 Test A 表明 ±chamfer × yaw 0/45 在 band d=19 全部 PASS，chamfer 对
  该场景无影响。本脚本的意义仅限于说明"取向相关剐蹭"在一般碰撞模型中的成因，
  不能用于断言引擎行为。

"""

import math

# ---- 场景参数 ----------------------------------------------------------
H = 16.0             # 人物盒半宽 (HU)，类比玩家碰撞半径
B = 1000.0           # 世界凸角象限延展（足够大，视作无限）
SWEEP_HALF = 140.0   # 人物中心 x 扫掠半程
SWEEP_STEP = 0.5     # 扫掠步长
D_SCAN_MAX = 40.0    # clearance 扫描上限
D_SCAN_STEP = 0.5    # clearance 扫描步长
TOL = 1.0            # 阈值判定容差 (HU)


# ---- 几何 --------------------------------------------------------------
def player_box(cx, cy, h, theta):
    """返回旋转后人物盒的 4 个角点（中心 (cx,cy)，半宽 h，绕 z 旋转 theta）。"""
    c, s = math.cos(theta), math.sin(theta)
    corners = []
    for sx, sy in ((-1, -1), (-1, 1), (1, -1), (1, 1)):
        lx, ly = sx * h, sy * h
        wx = cx + c * lx - s * ly
        wy = cy + s * lx + c * ly
        corners.append((wx, wy))
    return corners


def solid_corner():
    """世界凸角（第三象限 x<=0 且 y<=0）的凸多边形近似。"""
    return [(0.0, 0.0), (0.0, -B), (-B, -B), (-B, 0.0)]


def _axes(poly):
    ax = []
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        ex, ey = x2 - x1, y2 - y1
        nx, ny = -ey, ex
        L = math.hypot(nx, ny)
        if L > 1e-9:
            ax.append((nx / L, ny / L))
    return ax


def _project(poly, axis):
    dots = [p[0] * axis[0] + p[1] * axis[1] for p in poly]
    return min(dots), max(dots)


def sat_intersect(a, b):
    """SAT：两个凸多边形是否相交（剐蹭）。"""
    for axis in _axes(a) + _axes(b):
        amin, amax = _project(a, axis)
        bmin, bmax = _project(b, axis)
        if amax < bmin or bmax < amin:
            return False
    return True


def path_clips(theta, h, d):
    """人物中心沿 y=d 直线扫掠时，路径上是否存在任意位置发生剐蹭。"""
    cx = -SWEEP_HALF
    while cx <= SWEEP_HALF:
        if sat_intersect(player_box(cx, d, h, theta), solid_corner()):
            return True
        cx += SWEEP_STEP
    return False


def max_clip_clearance(theta, h):
    """扫描得到"仍会剐蹭"的最大 clearance（即危险区半径）。"""
    best = 0.0
    d = 0.0
    while d <= D_SCAN_MAX:
        if path_clips(theta, h, d):
            best = d
        d += D_SCAN_STEP
    return best


# ---- 前者场景测试 ------------------------------------------------------
def test_original_corner_clip():
    print("=" * 64)
    print(" 前者场景：原始(未做 chamfer)凸角剐蹭复现")
    print("=" * 64)
    print(f" 人物半宽 h = {H} HU | 旋转 tolerance = {TOL} HU")
    print("-" * 64)

    # 不同朝向下的最大会剐蹭 clearance
    rows = []
    for deg in range(0, 91, 15):
        theta = math.radians(deg)
        d_max = max_clip_clearance(theta, H)
        rows.append((deg, d_max))

    print(" 朝向角 | 最大会剐蹭 clearance (HU) | 理论")
    print(" -------|--------------------------|------")
    for deg, d_max in rows:
        theo = H if deg == 0 else (H * math.sqrt(2) if deg == 45 else "")
        print(f"  {deg:>3}°  |  {d_max:>22.3f}        | {theo}")

    t0 = dict(rows)[0]
    t45 = dict(rows)[45]
    h_diag = H * math.sqrt(2)

    print("-" * 64)
    # 判据 1：轴对齐阈值 = h
    ok1 = abs(t0 - H) <= TOL
    # 判据 2：45° 阈值 = h*sqrt(2)
    ok2 = abs(t45 - h_diag) <= TOL
    # 判据 3：取向相关 band 存在 —— 取 d = h+3，0°安全、45°剐蹭
    d_band = H + 3.0
    clip_0 = path_clips(0.0, H, d_band)
    clip_45 = path_clips(math.radians(45), H, d_band)
    ok3 = (not clip_0) and clip_45
    bug_reproduced = ok1 and ok2 and ok3

    print(f" 判据1 轴对齐阈值≈h(={H}): d_max(0°)={t0:.3f} -> {'OK' if ok1 else 'FAIL'}")
    print(f" 判据2 45°阈值≈h√2(={h_diag:.3f}): d_max(45°)={t45:.3f} -> {'OK' if ok2 else 'FAIL'}")
    print(f" 判据3 band(d={d_band})内 0°安全/45°剐蹭: "
          f"clip(0°)={clip_0}, clip(45°)={clip_45} -> {'OK' if ok3 else 'FAIL'}")
    print("-" * 64)
    print(f" 前者 bug 复现: {'SUCCESS（原始模型存在取向相关剐蹭）' if bug_reproduced else 'NOT REPRODUCED'}")
    print("=" * 64)
    return bug_reproduced


# =========================================================================
# 【后者】chamfer/bevel 处理后"任意朝向角都不剐蹭"验证 —— 先放着不动
# -------------------------------------------------------------------------
# 设计（待实现，本次不调用）：
#   * 在世界凸角上按导出层算法(lib.rs:2552-2690)注入 chamfer 平面，
#     生成带外凸小切角的碰撞多边形（法线朝内、棱外侧切一刀）。
#   * 对 theta ∈ [0°,180°] 全采样，在同一 band clearance 上
#     assert 所有朝向 path_clips 均为 False。
#   * 预期：chamfer 把凸角"削"掉一小块，危险区半径从 h√2 降回接近 h，
#     任意朝向不再剐蹭。
# 当前仅留占位，确认前者已复现后再补。
# =========================================================================
def test_after_chamfer():
    raise NotImplementedError("后者(chamfer 处理后)验证暂未实现，先放着不动")


if __name__ == "__main__":
    import sys
    ok = test_original_corner_clip()
    # test_after_chamfer()  # TODO: 后者，按需求暂不执行
    sys.exit(0 if ok else 1)
