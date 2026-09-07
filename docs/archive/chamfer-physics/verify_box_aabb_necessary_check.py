"""
verify_box_aabb_necessary_check.py
==================================
忠实镜像 src/phys/world.rs 的「盒-AABB 必要校验」修复（docs/chamfer-physics §9），
验证 P2 坡顶幻影碰撞的根治手段。

镜像关系（逐行对应 world.rs）：
- plane_offset        <-> world.rs::plane_offset (107)
- aabb_overlaps_at    <-> world.rs::aabb_overlaps_at (136-155，EPS=DIST_EPSILON/8)
- clip_planes_impl    逐平面进入分支的 AABB 否决 <-> world.rs clip_planes (196-218)
  —— 关键：门在**真实接触分数 f_true=d1/(d1-d2)** 处评估（world.rs:204-205）；
     命中平面取「最大进入分数」(最晚进入的平面)。另有 start_solid 门 (world.rs:220-233)。
- DIST_EPSILON = 0.03125；AABB 校验 EPS = DIST_EPSILON/8（仅吸收浮点误差；
  f_true 处合法接触盒表面恰贴平面，不需吸收 Minkowski 悬停间隙）

三种模式对照：
- 'nogate'  : 原始算法（无 AABB 校验）——用于暴露幻影
- 'perplane': 修复算法（逐进入平面 AABB 否决）——真实落地的修复
- 'whole'   : 整实体否决变体——对凸 brush 与 perplane 等价（§9.2 修正）

构造说明（2026-08-19 修正）：旧 S1 用「cap 平面 z≤200 但声明 AABB z-max=100」的不一致
构造——盒会继续深入半空间实体，门否决后盒仍真实重叠，属「误否决」而非纯幻影。现按
真实 P2 重建：坡形 brush（表面平面 + z=0 端盖 + 无 +y 顶面），盒在 brush AABB 之上
（y 分离）水平/斜向穿越端盖 → 端盖进入在命中处 y 轴与 AABB 分离 → 纯幻影，且几何一致
（端盖就在 AABB 边界 z=0）。引擎级最终裁决以 wasm 实跑为准（phys-p2-ground.mjs /
phys-p2-regression.mjs）。

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

    EPS 取 DIST_EPSILON/8：门在**真实接触分数**（盒表面恰贴平面）处评估，
    合法擦边接触的盒 AABB 与 brush AABB 各轴差 ≤ 0，EPS 仅吸收浮点误差。
    务必与 world.rs 一致。
    """
    EPS = DIST_EPSILON / 8.0
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
        # 稳态守卫：物体平行/远离某平面，直接跳过（world.rs:189）
        if d1 > 0.0 and (d2 >= DIST_EPSILON or d2 >= d1 or d1 - d2 < 1e-6):
            return (1.0, None)
        if d1 <= 0.0 and d2 <= 0.0:
            continue
        if d1 > d2:
            # 通过该平面进入凸体（取最大进入分数 => 最晚进入的平面为命中）
            f = (d1 - DIST_EPSILON) / (d1 - d2)
            # 【盒-AABB 必要校验】在**真实接触分数** f_true=d1/(d1-d2) 处
            # 判盒 AABB 与该实体 AABB 三轴重叠（world.rs:204-205）。分离即
            # 无限平面幻影，跳过该平面（保留更晚的真实接触）。
            f_true = d1 / (d1 - d2)
            if (not gate) or aabb_overlaps_at(bmin, bmax, start, end, mins, maxs, f_true):
                if f > enter_frac:
                    enter_frac = f
                    clip_plane = p
        else:
            f = (d1 + DIST_EPSILON) / (d1 - d2)
            if f < leave_frac:
                leave_frac = f
    if not start_out:
        # 【盒-AABB 必要校验·起点】平面判定「起点在体内」同为无限平面过逼近
        # （world.rs:220-233）：盒仅刺入某平面 EPS 量、AABB 却与实体分离时，
        # start_solid/all_solid 会把速度整速清零、把盒钉在幻影平面处。AABB 分离
        # 即真实不相交 → 否决（fraction=1，非 solid）。
        if gate and not aabb_overlaps_at(bmin, bmax, start, start, mins, maxs, 0.0):
            return (1.0, None)
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
        # 整实体否决变体：在命中平面处做整实体否决（对凸 brush 与 perplane 等价）
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


def aabb_brush(x0, x1, y0, y1, z0, z1):
    """轴对齐盒 brush，外向法线（inside = dot(n,p)-dist <= 0）。"""
    planes = [
        P(1, 0, 0, x1),    # +x 面: inside x<=x1
        P(-1, 0, 0, -x0),  # -x 面: inside x>=x0
        P(0, 1, 0, y1),    # +y 面: inside y<=y1
        P(0, -1, 0, -y0),  # -y 面: inside y>=y0
        P(0, 0, 1, z1),    # +z 面: inside z<=z1
        P(0, 0, -1, -z0),  # -z 面: inside z>=z0
    ]
    return {"planes": planes, "min": [x0, y0, z0], "max": [x1, y1, z1]}


def ramp_brush(th, z_end, y_bot, x_half=4000.0):
    """真实 P2 坡形 brush（镜像 phys-p2-regression.mjs rampDown）：
    表面平面 n=(0,cos,sin) dist=0 + 无 +y 顶面（实体在表面下方）+ z=0 端盖。
    AABB y∈[y_bot,0]、z∈[0,z_end]。端盖平面在 AABB 边界 z=0（几何一致）。
    """
    cos = math.cos(th)
    sin = math.sin(th)
    planes = [
        P(0, cos, sin, 0.0),       # 表面: inside 0.5y+0.866z<=0
        P(0, -1, 0, y_bot),        # 底面: inside y>=-y_bot
        P(1, 0, 0, x_half),        # +x
        P(-1, 0, 0, x_half),       # -x
        P(0, 0, -1, 0.0),          # z=0 端盖: inside z>=0
        P(0, 0, 1, z_end),         # +z: inside z<=z_end
    ]
    return {"planes": planes, "min": [-x_half, -y_bot, 0.0], "max": [x_half, 0.0, z_end]}


# --------------------------------------------------------------------------
# 场景 1：纯幻影（P2 真实机制：盒在 brush AABB 之上水平穿越 z=0 端盖，命中处
# y 轴与 AABB 分离）—— 应被否决
# --------------------------------------------------------------------------
def scenario_1_phantom():
    th = math.pi / 3
    b = ramp_brush(th, 1500.0, 3000.0)
    start = [-25.0, 0.05, -100.0]
    end = [-25.0, 0.05, 200.0]   # 沿 +z 水平穿越 z=0 端盖，y=0.05 恒定
    frac_nogate, n_nogate = clip_box_to_brush(b, start, end, BOX_MINS, BOX_MAXS, "nogate")
    frac_fix, n_fix = clip_box_to_brush(b, start, end, BOX_MINS, BOX_MAXS, "perplane")
    frac_whole, n_whole = clip_box_to_brush(b, start, end, BOX_MINS, BOX_MAXS, "whole")
    print("[S1] P2 纯幻影（y 分离端盖，几何一致）：")
    print(f"      nogate  : frac={frac_nogate:.4f} normal={n_nogate}  (应为 frac<1 且 normal=[0,0,-1] => 幻影)")
    print(f"      perplane: frac={frac_fix:.4f} normal={n_fix}  (应为 frac==1.0 => 幻影被否决)")
    print(f"      whole   : frac={frac_whole:.4f} normal={n_whole}  (应为 frac==1.0)")
    ok = (
        frac_nogate < 1.0 - 1e-9 and abs(n_nogate[2] + 1) < 1e-9
        and frac_fix >= 1.0 - 1e-9
        and frac_whole >= 1.0 - 1e-9
    )
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
# 场景 3：共存 brush（幻影端盖 + 合法表面接触）—— 验证 perplane 在既有幻影又有
# 合法接触的 brush 上不误杀合法接触，且与 whole 等价（§9.2 修正）。
#   盒从 (y=250,z=-100) 斜降向 (y=-550,z=300)：
#   - 先穿越 z=0 端盖（t≈0.21，此时盒 y≈82 仍高于 AABB y-top=0 => 轴分离 => 幻影）
#   - 后进入表面平面（t≈0.457，盒 y≈-116 已落入 AABB y 范围 => AABB 重叠 => 合法）
#   三种模式都应保留表面接触、丢弃幻影端盖（凸 brush 上 perplane≡whole）。
# --------------------------------------------------------------------------
def scenario_3_perplane_vs_whole():
    th = math.pi / 3
    b = ramp_brush(th, 1500.0, 3000.0)
    start = [-25.0, 250.0, -100.0]
    end = [-25.0, -550.0, 300.0]
    frac_per, n_per = clip_box_to_brush(b, start, end, BOX_MINS, BOX_MAXS, "perplane")
    frac_whole, n_whole = clip_box_to_brush(b, start, end, BOX_MINS, BOX_MAXS, "whole")
    frac_nogate, n_nogate = clip_box_to_brush(b, start, end, BOX_MINS, BOX_MAXS, "nogate")
    exp = 0.4565  # 表面平面进入分数（d1=24.5,d2=-29.1, f=(24.5-EPS)/(24.5+29.1)）
    print("[S3] 共存 brush（幻影端盖 + 合法表面）：")
    print(f"      nogate  : frac={frac_nogate:.4f} normal={n_nogate}  (应为 frac~0.4565 normal≈[0,0.5,0.866])")
    print(f"      perplane: frac={frac_per:.4f} normal={n_per}  (应为同 nogate => 合法表面保留)")
    print(f"      whole   : frac={frac_whole:.4f} normal={n_whole}  (应为同 perplane => 凸 brush 等价)")
    def surf_ok(fr, n):
        return abs(fr - exp) < 0.01 and abs(n[1] - 0.5) < 1e-6 and abs(n[2] - 0.866) < 1e-3
    ok = surf_ok(frac_nogate, n_nogate) and surf_ok(frac_per, n_per) and surf_ok(frac_whole, n_whole)
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