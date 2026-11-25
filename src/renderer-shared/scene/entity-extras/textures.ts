/**
 * `entity-extras` 的程序化贴图（不依赖 PAK / mtz：实体 lump 里只有贴图**路径**，
 * 实际 `.spr`/`.vmt`/`.vtf` 不在本工程的资产管线里）。
 *
 * 两张贴图：
 * - `makeGlowTexture()`：径向光晕，给 `env_sprite` / `env_sprite_clientside` 用；
 * - `makeBeamTexture()`：横向亮度剖面恒定的光束带，给 `env_beam` 用。
 *
 * 两张都是 POT 画布 + `CanvasTexture`，默认开 mipmap（远处不闪）。
 */

import * as THREE from 'three';

/**
 * 径向光晕：白核 + 软尾。
 *
 * Source `sprites/glow*.vmt` / `halo.vmt` 的亮度剖面不在资产里，这里按「中心饱和、
 * 半径 45% 后快速衰减、边缘归零」的通用辉光近似；sprite 的最终颜色/尺寸由实体键
 * （`rendercolor` / `renderamt` / `scale`）决定，贴图只贡献形状。
 */
export function makeGlowTexture(size = 128): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  const image = ctx.createImageData(size, size);
  const half = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    const dy = (y - half) / half;
    for (let x = 0; x < size; x++) {
      const dx = (x - half) / half;
      const r2 = dx * dx + dy * dy;
      const edge = Math.max(0, 1 - r2);
      const falloff = r2 >= 1 ? 0 : (0.55 * Math.exp(-r2 * 7.5) + 0.45 * Math.exp(-r2 * 2.2)) * edge * edge;
      const alpha = Math.round(Math.min(1, falloff) * 255);
      const offset = (y * size + x) * 4;
      image.data[offset] = 255;
      image.data[offset + 1] = 255;
      image.data[offset + 2] = 255;
      image.data[offset + 3] = alpha;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * 光束横截面：U 向双层高斯+幂次柔边剖面、V 向恒定。
 *
 * `env_beam` 的 `sprites/physbeam.vmt` 同样不在资产里。加法混合下形状完全由
 * 「RGB × alpha」决定，所以这里给白色 RGB + 柔和光晕剖面（中心明亮、边缘柔和散开），
 * 颜色交给实体 `rendercolor × renderamt` 的顶点色。
 */
export function makeBeamTexture(width = 64, height = 8): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  const image = ctx.createImageData(width, height);
  for (let x = 0; x < width; x++) {
    const u = ((x + 0.5) / width) * 2 - 1;
    const profile = 0.55 * Math.exp(-u * u * 7.5) + 0.45 * Math.pow(Math.max(0, 1 - u * u), 2.2);
    const alpha = Math.round(Math.min(1, profile) * 255);
    for (let y = 0; y < height; y++) {
      const offset = (y * width + x) * 4;
      image.data[offset] = 255;
      image.data[offset + 1] = 255;
      image.data[offset + 2] = 255;
      image.data[offset + 3] = alpha;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}
