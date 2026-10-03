/**
 * 场景子树的显存释放（三应用共用的单一实现）。
 *
 * 2026-10-04 由三份同源分叉合并：debug 版释放 11 个材质贴图槽位（覆盖最全，取为共享基准）、
 * viewer 版释放 map + lightMap 两个槽位、game 版只释放 map。共享版取并集（即 debug 的
 * 11 槽位）——`dispose` 幂等，多释放只影响换图后旧资源的回收，不改任何渲染输出；
 * game 与 viewer 由此补上 lightMap 图集等槽位的释放（原先每次换图在显存里多留一份旧图集）。
 *
 * 调用约束：只对即将丢弃的子树调用（三应用都只对 `userData.isBspModel` 的 BSP 模型子树
 * 调用）；不要对仍被其他场景引用的资源所在子树调用。
 */

import * as THREE from 'three';

/** 逐 Mesh 释放几何、材质及其引用的贴图（槽位清单见文件头）；重复 dispose 幂等。 */
export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      if (!mat) continue;
      // 释放材质引用的各张贴图（列表覆盖 map/lightMap/emissive 等常用槽位；重复 dispose 幂等）
      for (const key of [
        'map',
        'lightMap',
        'emissiveMap',
        'normalMap',
        'roughnessMap',
        'metalnessMap',
        'aoMap',
        'alphaMap',
        'bumpMap',
        'specularMap',
        'envMap',
      ]) {
        const tex = (mat as unknown as Record<string, unknown>)[key] as
          | THREE.Texture
          | undefined;
        if (tex?.isTexture) tex.dispose();
      }
      mat.dispose();
    }
  });
}
