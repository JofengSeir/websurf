/**
 * Clip 人工变换微调（rule.transform 的执行处）。
 *
 * viewer 的播放基准 = 帧自身坐标：本模块只在 rule.transform 存在且非恒等时才就地改写 Clip
 * （平移 + 绕 Y 旋转），随后重算 bbox。生产路径上的唯一调用点是
 * `apps/viewer/src/replay/shavit-replay.ts` 的 clipFromShavitReplay。
 */

import { wrapDeg } from './helpers.js';
import type { Clip, RuleTransform } from './types.js';

/** 帧数阈值：导入结果的 count ≥ 该值时，面板在摘要里追加「帧数较多，改映射/变换重新导入耗时较长」（`apps/viewer/src/replay/panel.ts` 的 runImport）。 */
export const LARGE_CLIP_FRAMES = 100_000;

/**
 * 就地应用人工变换微调；tf 缺省或全零（恒等）时直接返回。
 * - 平移：offset（缺省 [0,0,0]）加到每帧 pos 的三个分量上。
 * - 绕 Y 旋转 θ 度（θ = yawDeg，缺省 0；θ = 0 时跳过旋转段）：pos 的 (x, z) 走
 *   (x·cosθ + z·sinθ, −x·sinθ + z·cosθ)，vel 的 X/Z 分量走同一旋转，朝向只改 yaw
 *   （ang[i*3] = wrapDeg(ang[i*3] + θ)），pitch 与 roll 不动。该旋转使 yaw = φ 的朝向变为 φ + θ，
 *   与「yaw 直接加 θ」自洽；yaw 约定 0 = 面朝 −Z，相机 rotation 用 YXZ
 *   （见 `apps/viewer/src/core/fly.ts` 的 writeCamera）。
 * - 末尾按全部 pos 重算 clip.bbox；count = 0 时 min/max 全取 0。
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
