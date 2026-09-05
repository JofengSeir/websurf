/**
 * 合成示例录像（自测 / 演示用）。
 *
 * 走的是和真实文件完全相同的链路：生成 JSON 文本 → 包成 File → 交给 importer，
 * 所以它能验证「JSON 解析 → 帧数组定位 → 规则映射 → Clip → 播放」整条管线。
 * 数据用 viewer 原生约定，默认规则即可直接播放。
 */

const TICKRATE = 128;

export function buildSampleReplayText(frames = 3072): string {
  const cx = 0;
  const cz = 0;
  const y0 = 900;
  const radius = 900;
  const out: Array<{ pos: [number, number, number]; ang: [number, number]; vel: [number, number, number] }> = [];

  const samplePoint = (i: number): [number, number, number] => {
    const t = i / TICKRATE;
    const a = t * 0.85;
    const r = radius * (1 - 0.35 * Math.min(1, t / 18));
    return [
      cx + r * Math.cos(a),
      y0 - t * 52 + Math.sin(t * 2.2) * 26,
      cz + r * Math.sin(a),
    ];
  };

  for (let i = 0; i < frames; i++) {
    const p = samplePoint(i);
    const prev = samplePoint(Math.max(0, i - 1));
    const next = samplePoint(Math.min(frames - 1, i + 1));
    const vx = (next[0] - prev[0]) * (TICKRATE / 2);
    const vy = (next[1] - prev[1]) * (TICKRATE / 2);
    const vz = (next[2] - prev[2]) * (TICKRATE / 2);

    // viewer 前向 = (−sin yaw, 0, −cos yaw)；让镜头始终朝着运动方向
    const yawDeg = (Math.atan2(-vx, -vz) * 180) / Math.PI;
    const pitchDeg = (Math.atan2(vy, Math.hypot(vx, vz)) * 180) / Math.PI;

    out.push({
      pos: [round(p[0]), round(p[1]), round(p[2])],
      ang: [round(yawDeg), round(pitchDeg)],
      vel: [round(vx), round(vy), round(vz)],
    });
  }

  return JSON.stringify(
    { map: 'sample_spiral', tickrate: TICKRATE, frames: out },
    null,
    0,
  );
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

export const SAMPLE_FILE_NAME = 'sample-spiral.json';
