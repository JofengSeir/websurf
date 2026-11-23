/**
 * 实体颜色解析（`entity-extras` 共用）。
 *
 * 口径与 `lasers.ts` 一致：Source 的 `rendercolor`（0-255 整数，sRGB 编码）乘
 * `renderamt/255` 之后按 sRGB → 线性写入顶点色/材质色，加法混合下亮度与起源
 * 「`rendercolor/255 × renderamt/255`」的近似口径对齐（`game/client/view_beams.cpp`
 * 的 `kRenderTransAdd`）。
 */

import * as THREE from 'three';

function clampUnit(value: number): number {
  return Math.min(255, Math.max(0, value)) / 255;
}

/**
 * 解析 `"r g b"` 颜色键 + `renderamt`，写入 `out`（线性空间）并返回它。
 *
 * 颜色键缺失或格式非法时退回 `fallbackRgb`（0-255）；`renderamt` 缺失按 255（满亮）。
 * 需要 alpha 的调用方自行把 `renderamt` 再乘进顶点 alpha。
 */
export function parseEntityColor(
  rawRgb: string | undefined,
  rawAmount: string | undefined,
  out: THREE.Color,
  fallbackRgb: readonly [number, number, number] = [255, 255, 255],
): THREE.Color {
  let r = fallbackRgb[0];
  let g = fallbackRgb[1];
  let b = fallbackRgb[2];
  if (rawRgb) {
    const parts = rawRgb.trim().split(/\s+/).map((v) => Number(v));
    if (parts.length === 3 && parts.every((v) => Number.isFinite(v))) {
      r = parts[0];
      g = parts[1];
      b = parts[2];
    }
  }
  let amount = 255;
  if (rawAmount) {
    const value = Number.parseFloat(rawAmount);
    if (Number.isFinite(value)) amount = value;
  }
  const k = clampUnit(amount);
  out.setRGB(clampUnit(r) * k, clampUnit(g) * k, clampUnit(b) * k, THREE.SRGBColorSpace);
  return out;
}
