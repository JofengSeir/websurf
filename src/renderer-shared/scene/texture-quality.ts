/**
 * 贴图画质切换（mosaic 低清 / 原图还原）的共享核。
 *
 * 2026-10-04 由 game 与 debug 各自的 `applyTextureQuality` + `replaceMapWithMosaic`
 * 同源副本合并；两处此前的分叉（诊断日志、`needsRender` 置位、wasm 就绪等待、遍历根）
 * 全部保留在应用侧包装层：遍历根由入参给定，`ensureWasm` 钩子只有 debug 传，
 * 切换统计经返回值交应用侧自行打印。
 *
 * 依赖注入：`decode` 由应用侧传入——mosaic 解码函数出自各应用自己的 `pkg/websurf_wasm.js`
 * 构建产物，共享层不持有；`ensureWasm` 供 wasm 尚未保证 `initSync` 的应用传入
 * （debug 的 `ensureMainWasm`），不传则直接解码（game 现状：解码失败走告警并保留原贴图）。
 *
 * 语义（与合并前逐语句一致）：
 * - `original`：把此前切 mini 时缓存的原始 image 还原回 texture；没有缓存的贴图不动。
 * - `mini`：按 manifest（小写贴图名 → mosaic 字节码）逐张贴图替换为低清位图；
 *   替换前必须 `dispose()`——three r152+ 对同一 texture 的 image 替换走增量
 *   glTexSubImage2D，新 image 尺寸与原 GPU 纹理不符会 GL_INVALID_VALUE、上传失败
 *   （纹理保持旧内容 = 「没生效」）；dispose 后下次渲染按新尺寸重建 GPU 纹理。
 * - 还原 / 替换的簿记记在调用方传入的 `origTextureImages`（`Map<texture, 原image>`），
 *   状态归属应用实例。
 */

import * as THREE from 'three';

/** 应用侧注入的依赖：mosaic 解码函数（各应用自己的 wasm 产物）与可选的 wasm 就绪等待。 */
export interface MosaicDeps {
  /** mosaic 字节码 → PNG 字节（与 `pkg/websurf_wasm.js` 导出的 `mosaic_decode` 同签名）。 */
  decode: (code: string, scale: number) => Uint8Array;
  /** 可选：解码前等待 wasm 就绪（debug 传 `ensureMainWasm`；不传则直接解码）。 */
  ensureWasm?: () => Promise<unknown>;
}

/** 一次切换的统计：供应用侧打印诊断（game 忽略，debug 全量打印）。 */
export interface TextureQualityResult {
  /** 遍历根子树收集到的、材质 `map` 槽位上的去重贴图数。 */
  mapCount: number;
  /** mini 模式下在 manifest 里命中 mosaic 字节码的贴图数。 */
  matched: number;
  /** mini 模式下未命中的贴图名；展示截断由应用侧决定。 */
  noMatch: string[];
}

/**
 * 切换遍历根子树的贴图画质。`sceneRoot` 由应用侧给定（game 传整个场景、debug 传
 * `bspModelScene`）；manifest 为空（无 mosaic 清单）时由调用方提前返回，本函数
 * 假定入参就绪。
 */
export async function applyTextureQuality(
  sceneRoot: THREE.Object3D,
  manifest: Record<string, string>,
  quality: 'original' | 'mini',
  origTextureImages: Map<THREE.Texture, unknown>,
  deps: MosaicDeps,
): Promise<TextureQualityResult> {
  const maps = new Set<THREE.Texture>();
  sceneRoot.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    const list = Array.isArray(mat) ? mat : [mat];
    for (const m of list) {
      const map = (m as unknown as { map?: THREE.Texture | null }).map;
      if (map) maps.add(map);
    }
  });

  const result: TextureQualityResult = { mapCount: maps.size, matched: 0, noMatch: [] };
  const jobs: Promise<void>[] = [];
  for (const map of maps) {
    if (quality === 'original') {
      const orig = origTextureImages.get(map);
      if (orig !== undefined) {
        map.dispose(); // 低清 512 与原始图幅不同 ⇒ 强制重建 GPU 纹理
        map.image = orig;
        map.needsUpdate = true;
        origTextureImages.delete(map);
      }
      continue;
    }
    const code = manifest[(map.name ?? '').toLowerCase()];
    if (!code) {
      result.noMatch.push(map.name ?? '(无名)');
      continue;
    }
    result.matched++;
    if (!origTextureImages.has(map)) origTextureImages.set(map, map.image);
    jobs.push(replaceMapWithMosaic(map, code, deps));
  }
  await Promise.all(jobs);
  return result;
}

/** 单个贴图：mosaic 字节码 → 低清 PNG → ImageBitmap 替换 image。失败只告警，保留原贴图。 */
async function replaceMapWithMosaic(
  map: THREE.Texture,
  code: string,
  deps: MosaicDeps,
): Promise<void> {
  try {
    await deps.ensureWasm?.();
    const png = deps.decode(code, 8);
    const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
    map.dispose();
    map.image = bitmap;
    map.needsUpdate = true;
  } catch (e) {
    console.warn('[renderer] mosaic 贴图替换失败:', e);
  }
}
