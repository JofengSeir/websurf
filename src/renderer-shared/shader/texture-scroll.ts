/**
 * Source `TextureScroll` proxy 的每帧推进（UV 周期/秒）。
 *
 * 语义（`game/client/texturescrollmaterialproxy.cpp`）：
 * `sOffset = curtime * cos(angle°) * rate`、`tOffset = curtime * sin(angle°) * rate`；
 * `rate` 的单位是**每秒 UV 周期数**（0.25 ⇒ 4 秒滚完一张），`angle` 缺省 0° ⇒ 只滚 +U。
 *
 * 导出侧（`src/wasm-core/bsp_to_gltf_core/materials.rs` 的 `parse_texture_scroll`）已把
 * `[u, v]` 写进 GLB 材质 extras `vbsp_texture_scroll`，GLTFLoader 把它放进 `material.userData`。
 * 这里在装配完成后收集「贴图实例 + 速率」，由 `RenderSession.frame()` 每帧推进。
 *
 * 为什么按**贴图实例**去重：glTF 里同一张 `Texture` 会被多个材质共用，而 UV offset 是贴图对象
 * 上的状态（不是材质上的），共用贴图只能共用一个 offset，重复推进会滚成 N 倍速。
 *
 * 典型用例：`project_tendies/tendies_endsmoke`（boreas 光柱旁的两片烟幕，rate 0.25、angle 0）。
 */
import * as THREE from 'three';

export interface TextureScrollEntry {
  /** 被共享的贴图实例（同一贴图只推进一次）。 */
  map: THREE.Texture;
  /** 每秒滚动的 UV 周期数，`[u, v]`。 */
  rate: [number, number];
}

interface ScrollExtras {
  vbsp_texture_scroll?: [number, number];
}

function readScrollRate(material: THREE.Material): [number, number] | null {
  const raw = (material.userData as ScrollExtras | undefined)?.vbsp_texture_scroll;
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [u, v] = raw;
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  if (u === 0 && v === 0) return null;
  return [u, v];
}

/**
 * 收集场景里所有声明了 `TextureScroll` 的贴图。
 *
 * 只认 `map`（漫反射贴图）：Source 的 proxy 也只滚 `$basetexture`。
 * 顺带把 `wrapS/wrapT` 设成 `RepeatWrapping` —— 贴图来自 GLB，默认是 ClampToEdge，
 * 不改成 Repeat 的话 offset 一越过 1 就采样到边缘像素（画面变成一条拉伸的边）。
 */
export function collectTextureScrolls(root: THREE.Object3D): TextureScrollEntry[] {
  const seen = new Set<THREE.Texture>();
  const out: TextureScrollEntry[] = [];
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const rate = readScrollRate(material);
      if (!rate) continue;
      const map = (material as THREE.MeshBasicMaterial).map;
      if (!map || seen.has(map)) continue;
      seen.add(map);
      map.wrapS = THREE.RepeatWrapping;
      map.wrapT = THREE.RepeatWrapping;
      map.needsUpdate = true;
      out.push({ map, rate });
    }
  });
  return out;
}

/**
 * 推进所有滚动贴图的 offset。
 *
 * `dt` 用秒；`% 1` 保持 offset 在 `[0,1)`，避免长时间运行后浮点精度掉到亚纹素。
 */
export function updateTextureScrolls(entries: readonly TextureScrollEntry[], dt: number): void {
  if (dt <= 0) return;
  for (const entry of entries) {
    const { map, rate } = entry;
    map.offset.x = (map.offset.x + rate[0] * dt) % 1;
    map.offset.y = (map.offset.y + rate[1] * dt) % 1;
  }
}
