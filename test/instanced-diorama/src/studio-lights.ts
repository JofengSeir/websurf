/**
 * 影棚级光照 —— 物理正确光照模式（three r155+ 默认物理单位强度）。
 *
 * - 强平行光（主光）：PCFSoftShadowMap 软阴影 + 较高阴影分辨率（4096 起），
 *   阴影相机视锥紧贴沙盘 → 阴影锐利但边缘微柔
 * - 半球光：模拟天光（冷色天空 / 暖色地面）
 * - 低强度暖/冷补光：填充主光背面的暗部
 */
import * as THREE from 'three';

export interface StudioLights {
  key: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  fill: THREE.DirectionalLight;
}

/** 沙盘尺寸常量（diorama 与阴影相机共用，保证阴影覆盖紧贴场景）。 */
export const TABLE_HALF_X = 100;
export const TABLE_HALF_Z = 65;

/** 创建影棚灯光组；`shadowSize` 为阴影贴图分辨率（2048/4096/8192）。 */
export function createStudioLights(shadowSize: number): StudioLights {
  // 主光：强平行光，暖色（影棚主灯），只此一盏投射阴影
  const key = new THREE.DirectionalLight(0xfff0dc, 3.2);
  key.position.set(TABLE_HALF_X * 0.7, 140, TABLE_HALF_Z * 0.8);
  key.castShadow = true;
  key.shadow.mapSize.set(shadowSize, shadowSize);
  // 阴影相机视锥：覆盖沙盘即可（紧贴 → 阴影贴图分辨率全部用在场景上 → 锐利阴影）
  const s = Math.max(TABLE_HALF_X, TABLE_HALF_Z) * 1.35;
  key.shadow.camera.near = 20;
  key.shadow.camera.far = 320;
  key.shadow.camera.left = -s;
  key.shadow.camera.right = s;
  key.shadow.camera.top = s;
  key.shadow.camera.bottom = -s;
  key.shadow.bias = -0.0004; // 消阴影痤疮
  key.shadow.normalBias = 0.03; // 消表面接缝渗色
  key.shadow.radius = 4; // PCFSoft 下的柔和度
  key.shadow.blurSamples = 16;

  // 天光：半球光（上冷下暖）
  const hemi = new THREE.HemisphereLight(0xbdd2ff, 0x46382c, 0.85);

  // 补光：低强度冷色逆光（打亮暗部轮廓）
  const fill = new THREE.DirectionalLight(0x9db8ff, 0.55);
  fill.position.set(-TABLE_HALF_X * 0.6, 60, -TABLE_HALF_Z * 0.9);

  return { key, hemi, fill };
}

/** 重建阴影贴图分辨率（改配置后调用）。 */
export function setShadowSize(lights: StudioLights, shadowSize: number): void {
  lights.key.shadow.mapSize.set(shadowSize, shadowSize);
  lights.key.shadow.map?.dispose();
  lights.key.shadow.map = null;
}
