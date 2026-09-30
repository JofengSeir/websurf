/**
 * **按键反推**（Key Overlay 的推断层）：由运动学量猜出玩家此刻按了什么，不依赖原始输入流。
 *
 * ## 为什么是反推而不是读原始数据
 *
 * Source 演示录像里的 `dem_usercmd` **只记录录制者本人**的输入流（引擎从不广播其他玩家的按键），
 * 而本工程现有的录像全部由**观察者机器人**录制 —— 实测 `dem_usercmd` 0 条、`Clip.buttons` 为 null
 * （见 `apps/viewer/src/replay/democlip.ts` 的 `toClip`）。
 * 主流比赛 HUD 的 Key Overlay 用的是同一套办法：**看结果反推输入**。
 * 好处是它对**任何**玩家都成立 —— 包括观察者录像里的第三人。
 *
 * ## 反推得出什么、得不出什么
 *
 * **由运动学可推**：W / S / A / D（速度方向相对视角的分解）、JUMP（垂直速度的突变）。
 * **推不出**：鼠标按键、换弹、武器切换 —— 这些不改变速度矢量。要拿到得靠别的通道
 * （命中事件、弹匣计数），本模块**不假装能推**，对应位恒不置。
 *
 * ## 一条必须记住的性质
 *
 * **反推不是原始数据。** 它在绝大多数帧与真实输入一致，但边界情况（贴墙推进、被推动、
 * 站在斜坡上滑行）会产生**误判**。因此本模块的输出语义是"**看起来在按什么**"，
 * 不是"**确实按了什么**"；UI 上呈现时应当按这个口径说明（见 `apps/viewer/AGENTS.md` §7.3 #88）。
 */

/** 与 Source `IN_*` 掩码同位，便于将来拿到真实 `buttons` 时直接对接。 */
export const IN_JUMP = 1 << 1;
export const IN_DUCK = 1 << 2;
export const IN_FORWARD = 1 << 3;
export const IN_BACK = 1 << 4;
export const IN_MOVELEFT = 1 << 9;
export const IN_MOVERIGHT = 1 << 10;

/** 分速度低于此值（单位/秒）时不算"在往那个方向走" —— 抑制静止时的抖动。 */
const AXIS_DEADZONE = 30;

/** 垂直速度低于此值不算起跳（正值为向上）。 */
const JUMP_MIN_UP = 60;

/** 垂直方向一帧内至少要涨这么多速度才算蹬地（区别于被斜坡或传送抬升）。 */
const JUMP_MIN_DV = 40;

/**
 * 瞬移判据（单位/秒）：相邻两帧的速率超过它就不当作"移动"，本帧不反推。
 * CS:S 正常冲刺量级 250~3000 u/s；实测这份录像的相邻位移离群点达 ≈92 万 u/s，
 * 两者之间留足余量，不会误伤高速下滑。
 */
const TELEPORT_SPEED = 5000;

/**
 * 单帧反推。`i` 是采样下标。
 *
 * **速度由位置差分求得，不读 `clip.vel`** —— 实测 `.dem` 路径把 `vel` 置为 `null`
 * （`apps/viewer/src/replay/democlip.ts` 的 `toClip`）、`maxSpeed` 为 0，所以
 * "现成的速度字段"在录像模式下是空的；而位置与角度是齐的（那份录像 4 条轨道每帧都有）。
 * 差分用相邻两帧的时间差归一，最后一帧退回用前一帧的差分。
 *
 * `ang` 约定 **度**，分量序 `[pitch, yaw, roll]`（`ang[i*3+1]` 即 yaw），与
 * `apps/viewer/src/replay/visuals.ts` 里幽灵位姿所用的序一致。
 * 速度投影用 Source 的水平基：**yaw 方向为前、其右手 90° 为右**（X 前 / Y 右 / Z 上）。
 */
export function guessKeys(
  i: number,
  pos: Float32Array | null,
  ang: Float32Array | null,
  t: Float64Array | null,
): number {
  if (!pos || i < 0 || i * 3 + 2 >= pos.length) return 0;
  const j = i > 0 ? i - 1 : i;
  if (j === i && i + 1 >= (t?.length ?? 0)) return 0;
  const k = j === i ? i + 1 : i;
  const dt = t && t.length > k ? Math.abs(t[k] - t[j]) : 0;
  if (!(dt > 1e-6)) return 0;
  const scale = 1 / dt;
  const vx = ((pos[k * 3] ?? 0) - (pos[j * 3] ?? 0)) * scale;
  const vy = ((pos[k * 3 + 1] ?? 0) - (pos[j * 3 + 1] ?? 0)) * scale;
  const vz = ((pos[k * 3 + 2] ?? 0) - (pos[j * 3 + 2] ?? 0)) * scale;

  // **传送过滤**：`.dem` 的位置采样里有少量离群点（重生、换图、观察者跳转），
  // 实测相邻两帧位移中位数 60 单位、而最大值 27,580（≈92 万 u/s）。
  // 这类样本不是"移动"，若照常投影会点亮一堆假按键。
  // 判据取**水平速率**的绝对上限：CS:S 里正常冲刺量级是 250~3000 u/s，
  // 超过 5000 的相邻差一律视为瞬移，本帧不输出按键。
  const speedNow = Math.hypot(vx, vy);
  if (speedNow > TELEPORT_SPEED || Math.abs(vz) > TELEPORT_SPEED) return 0;

  let keys = 0;

  // **起跳按「边沿」判，不按「状态」判**：跳跃是一次按键触发一次腾空，而腾空**过程**会持续
  // 很多帧。若按 `vz > 阈值` 逐帧置位，得到的会是「一半时间都在按跳」（实测 51.9%，显然错）。
  // 这里只在该帧**由非上升转为上升**时置位 —— 与真人按一下跳的手感一致。
  const prevVz = ((): number => {
    const p = i > 0 ? i - 1 : i;
    const q = p === i ? i + 1 : i;
    const d = t && t.length > q ? Math.abs(t[q] - t[p]) : 0;
    if (!(d > 1e-6)) return 0;
    return (((pos[q * 3 + 2] ?? 0) - (pos[p * 3 + 2] ?? 0)) / d);
  })();
  if (vz > JUMP_MIN_UP && vz - prevVz > JUMP_MIN_DV) keys |= IN_JUMP;

  const yawDeg = ang && i * 3 + 1 < ang.length ? (ang[i * 3 + 1] ?? 0) : 0;
  const yaw = (yawDeg * Math.PI) / 180;
  const fx = Math.cos(yaw);
  const fy = Math.sin(yaw);
  // 右向量 = 前向量顺时针 90°（Source 的 Y 轴指向右手侧）
  const rx = -fy;
  const ry = fx;

  const forward = vx * fx + vy * fy; // 沿视线方向的分量
  const right = vx * rx + vy * ry; // 沿视线右手方向的分量

  // 死区取**当前水平速率的一个比例**（不是固定值）：慢走与冲刺都能正确判向，
  // 而静止时的差分噪声不会被当成输入。
  const speed = Math.hypot(vx, vy);
  const dead = Math.max(AXIS_DEADZONE, speed * 0.45);
  if (forward > dead) keys |= IN_FORWARD;
  else if (forward < -dead) keys |= IN_BACK;
  if (right > dead) keys |= IN_MOVERIGHT;
  else if (right < -dead) keys |= IN_MOVELEFT;

  return keys;
}

/** 位掩码 → 显示用的键名数组（顺序固定，便于 UI 稳定排布）。 */
export function keyNames(mask: number): string[] {
  const out: string[] = [];
  if (mask & IN_FORWARD) out.push('W');
  if (mask & IN_MOVELEFT) out.push('A');
  if (mask & IN_BACK) out.push('S');
  if (mask & IN_MOVERIGHT) out.push('D');
  if (mask & IN_JUMP) out.push('JUMP');
  if (mask & IN_DUCK) out.push('DUCK');
  return out;
}
