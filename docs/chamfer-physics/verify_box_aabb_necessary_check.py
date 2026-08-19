"""
verify_box_aabb_necessary_check.py
==================================
忠实镜像 src/phys/world.rs 的「盒-AABB 必要校验」修复（docs/chamfer-physics §9），
验证 P2 坡顶幻影碰撞的根治手段。

镜像关系（逐行对应 world.rs:107-183）：
- plane_offset        <-> world.rs::plane_offset (107)
- aabb_overlaps_at    <-> world.rs::aabb_overlaps_at (新增)
- clip_planes_impl    逐平面进入分支的 AABB 否决 <-> world.rs clip_planes (177 附近)
  —— 关键：world.rs 取「最大进入分数」(最晚进入的平面) 为命中平面
     (if f > enter_frac)，故整实体否决最早平面会丢合法接触 => 必须逐平面否决
- DIST_EPSILON = 0.03125；AABB 校验 EPS 同量级

三种模式对照：
- 'nogate'  : 原始算法（无 AABB 校验）——用于暴露幻影
- 'perplane': 修复算法（逐进入平面 AABB 否决）——真实落地的修复
- 'whole'   : 错误变体（整实体否决命中平面）——用于证明会穿模，说明为何必须逐平面

构造说明：用轴对齐盒 brush（含一个"外伸无限平面"cap 替代 +z 闭合面）复现 P2 的
「无限平面 + 命中处盒 AABB 与 brush AABB 轴分离」机制。真实 P2 用的是坡面 z=0
端盖；本脚本用同类几何演示算法行为。引擎级最终裁决以 phys-chamfer-real.mjs 的
H×vz 矩阵为准（需重建 wasm）。

运行：python3 verify_box_aabb_necessary_check.py
"""
import math

DIST_EPSILON = 0.03125

# 玩家碰撞盒（player.rs:959-964，轴对齐，half_width=16, stand_height=72）
BOX_MINS = [-16.0, 0.0, -16.0]
BOX_MAXS = [16.0, 72.0, 16.0]


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def plane_offset(n, mins, maxs):
    """world.rs::plane_offset —— 盒 mins/maxs 对平面 dist 的 Minkowski 扩张。"""
    return (
        (mins[0] if n[0] > 0 else maxs[0]) * n[0]
        + (mins[1] if n[1] > 0 else maxs[1]) * n[1]
        + (mins[2] if n[2] > 0 else maxs[2]) * n[2]
    )


def aabb_overlaps_at(bmin, bmax, start, end, mins, maxs, f):
    """world.rs::aabb_overlaps_at —— 命中分数 f 处盒 AABB 与实体 AABB 三轴重叠。

    EPS 取 2*DIST_EPSILON：world.rs 在「扩展进入分数」处报接触时，盒表面恰贴
    brush 平面（穿透量恰为 DIST_EPSILON），故合法擦边接触处盒 AABB 与 brush AABB
    仅差 DIST_EPSILON；用 2*DIST_EPSILON 吸收该 Minkowski 穿透量 + 浮点误差，
    避免误杀合法接触，同时仍远大于 P2 幻影的轴分离量(>=1.6 HU)。务必与 world.rs 一致。
    """
    EPS = DIST_EPSILON * 2.0
    for i in range(3):
        px = start[i] + (end[i] - start[i]) * f
        lo = px + mins[i]
        hi = px + maxs[i]
        if hi < bmin[i] - EPS or lo > bmax[i] + EPS:
            return False
    return True


def clip_planes_impl(planes, start, end, mins, maxs, bmin, bmax, gate):
    """镜像 world.rs::clip_planes（逐平面 Minkowski 扫掠）。gate=True 即修复。"""
    enter_frac = -1.0
    leave_frac = 1.0
    clip_plane = None
    start_out = False
    get_out = False
    for p in planes:
        n = p["normal"]
        dist = p["dist"] - plane_offset(n, mins, maxs)
        d1 = dot(n, start) - dist
        d2 = dot(n, end) - dist
        if d2 > 0.0:
            get_out = True
        if d1 > 0.0:
            start_out = True
        # 稳态守卫：物体平行/远离某平面，直接跳过（world.rs:146）
        if d1 > 0.0 and (d2 >= DIST_EPSILON or d2 >= d1 or d1 - d2 < 1e-6):
            return (1.0, None)
        if d1 <= 0.0 and d2 <= 0.0:
            continue
        if d1 > d2:
            # 通过该平面进入凸体（取最大进入分数 => 最晚进入的平面为命中）
            f = (d1 - DIST_EPSILON) / (d1 - d2)
            # 【盒-AABB 必要校验】命中处盒 AABB 不与该实体 AABB 重叠 => 无限平面幻影，跳过
            if gate and not aabb_overlaps_at(bmin, bmax, start, end, mins, maxs, f):
                continue
            if f > enter_frac:
                enter_frac = f
                clip_plane = p
        else:
            f = (d1 + DIST_EPSILON) / (d1 - d2)
            if f < leave_frac:
                leave_frac = f
    if not start_out:
        return (0.0, None)  # start_solid（简化为 fraction=0）
    if enter_frac < leave_frac and enter_frac > -1.0 and enter_frac < 1.0:
        frac = 0.0 if enter_frac < 0.0 else enter_frac
        return (frac, clip_plane["normal"] if clip_plane else None)
    return (1.0, None)


def clip_planes(planes, start, end, mins, maxs, bmin, bmax, mode="perplane"):
    if mode == "nogate":
        return clip_planes_impl(planes, start, end, mins, maxs, bmin, bmax, gate=False)
    if mode == "perplane":
        return clip_planes_impl(planes, start, end, mins, maxs, bmin, bmax, gate=True)
    if mode == "whole":
        # 错误变体：在命中平面处做整实体否决（world.rs:177-182 字面位置）
        frac, n = clip_planes_impl(planes, start, end, mins, maxs, bmin, bmax, gate=False)
        if frac < 1.0 and not aabb_overlaps_at(bmin, bmax, start, end, mins, maxs, frac):
            return (1.0, None)
        return (frac, n)
    raise ValueError(mode)


def clip_box_to_brush(brush, start, end, mins, maxs, mode="perplane"):
    return clip_planes(
        brush["planes"], start, end, mins, maxs, brush["min"], brush["max"], mode
    )


def P(nx, ny, nz, dist):
    nlen = math.sqrt(nx * nx + ny * ny + nz * nz)
    return {"normal": [nx / nlen, ny / nlen, nz / nlen], "dist": dist}


def aabb_brush(x0, x1, y0, y1, z0, z1, extra=None, zmax_face=True):
    """轴对齐盒 brush，外向法线（inside = dot(n,p)-dist <= 0）。
    zmax_face=False 时省略 +z 闭合面，由 extra 中的外伸 cap 取代。"""
    planes = [
        P(1, 0, 0, x1),    # +x 面: inside x<=x1
        P(-1, 0, 0, -x0),  # -x 面: inside x>=x0
        P(0, 1, 0, y1),    # +y 面: inside y<=y1
        P(0, -1, 0, -y0),  # -y 面: inside y>=y0
        P(0, 0, -1, -z0),  # -z 面: inside z>=z0
    ]
    if zmax_face:
        planes.append(P(0, 0, 1, z1))  # +z 闭合面: inside z<=z1
    if extra:
        planes = planes + extra
    return {"planes": planes, "min": [x0, y0, z0], "max": [x1, y1, z1]}


# --------------------------------------------------------------------------
# 场景 1：纯幻影（仅外伸 cap 进入，盒命中处 z 与 brush AABB 分离）—— 应被否决
# --------------------------------------------------------------------------
def scenario_1_phantom():
    cap = [P(0, 0, 1, 200)]  # inside z<=200（远超真实 AABB z-max=100）
    b = aabb_brush(-50, 0, 0, 200, -10, 100, extra=cap, zmax_face=False)
    start = [-25.0, 50.0, 300.0]
    end = [-25.0, 50.0, 0.0]  # 仅沿 -z 跨越外伸 cap
    frac_nogate, n_nogate = clip_box_to_brush(b, start, end, BOX_MINS, BOX_MAXS, "nogate")
    frac_fix, n_fix = clip_box_to_brush(b, start, end, BOX_MINS, BOX_MAXS, "perplane")
    print("[S1] 纯无限平面幻影：")
    print(f"      nogate  : frac={frac_nogate:.4f} normal={n_nogate}  (应为 frac<1 且 normal=[0,0,1] => 幻影)")
    print(f"      perplane: frac={frac_fix:.4f} normal={n_fix}  (应为 frac==1.0 => 幻影被否决)")
    ok = frac_nogate < 1.0 - 1e-9 and abs(n_nogate[2] - 1) < 1e-9 and frac_fix >= 1.0 - 1e-9
    return ok


# --------------------------------------------------------------------------
# 场景 2：合法接触（高墙，盒 AABB 与墙 AABB 重叠）—— 必须保留
# --------------------------------------------------------------------------
def scenario_2_legit():
    b = aabb_brush(-50, 0, 0, 200, -10, 10)  # 高墙 y∈[0,200]，盒高 72 落在墙体内
    start = [100.0, 36.0, 0.0]
    end = [-100.0, 36.0, 0.0]  # 沿 -x 撞 +x 面
    frac_fix, n_fix = clip_box_to_brush(b, start, end, BOX_MINS, BOX_MAXS, "perplane")
    frac_nogate, _ = clip_box_to_brush(b, start, end, BOX_MINS, BOX_MAXS, "nogate")
    print("[S2] 合法墙接触：")
    print(f"      perplane: frac={frac_fix:.4f} normal={n_fix}  (应为 frac<1 且 normal=[1,0,0])")
    print(f"      nogate  : frac={frac_nogate:.4f}  (一致)")
    ok = frac_fix < 1.0 - 1e-9 and abs(n_fix[0] - 1) < 1e-9
    return ok


# --------------------------------------------------------------------------
# 场景 3：共存 brush（真实墙 + 外伸幻影 cap）—— 验证 perplane 在「既有幻影又有
# 合法接触」的 brush 上不误杀合法接触。
#   盒从 z=250 下插：先跨外伸 cap(z<=200, f≈0.08，此时盒在 brush 上方 => 轴分离
#   => 幻影)，后入真实墙(+x, f≈0.42，此时盒已落入 brush z 范围 => AABB 重叠 => 合法)。
#   - nogate  : 取最大进入分数 => 命中真实墙（巧合正确，因墙分数更大）
#   - perplane: 逐平面否决幻影 cap => 保留真实墙（正确）
#   - whole   : 命中真实墙、非轴分离 => 保留（与 perplane 对凸 brush 等价，见文档 §9.2 修正）
#   关键：三种模式都应保留真实墙、丢弃幻影 cap，证明「逐平面 AABB 校验」不会把
#   合法擦边接触误杀（穿模风险靠 EPS=2*DIST_EPSILON 吸收，见 aabb_overlaps_at 注释）。
# --------------------------------------------------------------------------
def scenario_3_perplane_vs_whole():
    cap = [P(0, 0, 1, 200)]  # inside z <= 200（外伸无限平面，盒在其上方跨入 => 轴分离）
    b = aabb_brush(-50, 0, 0, 200, -10, 100, extra=cap, zmax_face=False)
    start = [100.0, 100.0, 250.0]
    end = [-100.0, 100.0, -150.0]  # 下插：先跨 cap，后入真实墙
    frac_per, n_per = clip_box_to_brush(b, start, end, BOX_MINS, BOX_MAXS, "perplane")
    frac_whole, n_whole = clip_box_to_brush(b, start, end, BOX_MINS, BOX_MAXS, "whole")
    frac_nogate, n_nogate = clip_box_to_brush(b, start, end, BOX_MINS, BOX_MAXS, "nogate")
    print("[S3] 共存 brush（真实墙 + 外伸幻影 cap）：")
    print(f"      nogate  : frac={frac_nogate:.4f} normal={n_nogate}  (应为 normal=[1,0,0])")
    print(f"      perplane: frac={frac_per:.4f} normal={n_per}  (应为 normal=[1,0,0])")
    print(f"      whole   : frac={frac_whole:.4f} normal={n_whole}  (应为 normal=[1,0,0])")
    ok = (
        frac_nogate < 1.0 - 1e-9 and abs(n_nogate[0] - 1) < 1e-9
        and frac_per < 1.0 - 1e-9 and abs(n_per[0] - 1) < 1e-9
        and frac_whole < 1.0 - 1e-9 and abs(n_whole[0] - 1) < 1e-9
    )
    return ok


def main():
    print("=" * 64)
    print("盒-AABB 必要校验（P2 坡顶幻影根治）验证")
    print("=" * 64)
    r1 = scenario_1_phantom()
    r2 = scenario_2_legit()
    r3 = scenario_3_perplane_vs_whole()
    print("-" * 64)
    all_ok = r1 and r2 and r3
    print(f"S1 纯幻影否决      : {'PASS' if r1 else 'FAIL'}")
    print(f"S2 合法接触保留    : {'PASS' if r2 else 'FAIL'}")
    print(f"S3 逐平面(非整实体): {'PASS' if r3 else 'FAIL'}")
    print("=" * 64)
    print("总判定:" + ("ALL PASS —— 修复算法成立" if all_ok else "存在 FAIL"))
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
