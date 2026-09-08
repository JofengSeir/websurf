/**
 * Clip 人工变换微调（rule.transform 的后端）。
 *
 * t4 起 JSON 解析通道已移除，本模块只剩「变换调整」的后处理：
 * viewer 的播放基准 = 帧自身坐标；平移/旋转只能由用户显式设置（恒等变换直接跳过）。
 */

import { wrapDeg } from './helpers.js';
import type { Clip, RuleTransform } from './types.js';

/** 超过该帧数的导入按「大文件」处理（提示合并/精度说明）。 */
export const LARGE_CLIP_FRAMES = 100_000;

/**
 * 人工变换微调（rule.transform）：作用于解码输出之后，恒等变换直接跳过。
 *
 * 绕 Y 旋转 θ（度）：pos/vel 用标准 Y 旋转 (x,z)→(x·cosθ+z·sinθ, −x·sinθ+z·cosθ)，
 * 该旋转把朝向 yaw φ 的方向变为 φ+θ——与「yaw 直接加 θ」自洽
 * （viewer 约定：yaw 0 面朝 −Z，逆时针为正）。bbox 全量重算。
 *
 * .replay 原生路径不走规则脚本，
 * 但「调整工具」的平移/旋转微调对原生轨道同样生效。
 */
export function applyClipTransform(clip: Clip, tf: RuleTransform | undefined): void {
  if (!tf) return;
  const [ox, oy, oz] = tf.offset ?? [0, 0, 0];
  const yawDeg = tf.yawDeg ?? 0;
  if (ox === 0 && oy === 0 && oz === 0 && yawDeg === 0) return;

  const th = (yawDeg * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const rot = yawDeg !== 0;
  const { pos, ang, vel, count } = clip;

  for (let i = 0; i < count; i++) {
    let x = pos[i * 3];
    const y = pos[i * 3 + 1];
    let z = pos[i * 3 + 2];
    if (rot) {
      const nx = x * c + z * s;
      z = -x * s + z * c;
      x = nx;
      ang[i * 3] = wrapDeg(ang[i * 3] + yawDeg);
    }
    pos[i * 3] = x + ox;
    pos[i * 3 + 1] = y + oy;
    pos[i * 3 + 2] = z + oz;

    if (rot && vel) {
      const vx = vel[i * 3];
      const vz = vel[i * 3 + 2];
      vel[i * 3] = vx * c + vz * s;
      vel[i * 3 + 2] = -vx * s + vz * c;
    }
  }

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i * 3 + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (count === 0) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }
  clip.bbox = { min, max };
}
