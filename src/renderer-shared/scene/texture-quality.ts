/**
 * 贴图画质切换（mosaic 低清 / 原图还原）的共享核。
 *
 * 2026-10-04 由 game 与 debug 各自的 `applyTextureQuality` + `replaceMapWithMosaic` 同源副本合并；
 * 两处此前的分叉（诊断日志、`needsRender` 置位、wasm 就绪等待、遍历根）全部保留在应用侧包装层：
 * `ensureWasm` 钩子只有 debug 传，切换统计经返回值交应用侧自行打印。
 *
 * 2026-10-11（T-460 WP6）：**遍历根也收进本模块**。此前三端各传一个根——debug `bspModelScene`、
 * game 整个 `scene`、viewer `modelRoot` ⇒ 天空区组只有 game 会跟着切（它在 `scene` 里），另两端
 * 的天空贴图在 `mini` 档下仍留原图（T-172）。`applySceneTextureQuality` 固定遍历**主根 + 天空组**，
 * 是应用侧应当使用的入口；`applyTextureQuality` 保留为**单根**低层入口，两者共用同一份收集与切换。
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

/** 三端统一的遍历根（T-460 WP6）：主根 + 天空组；天空组为 null 时只遍历主根。 */
export interface SceneTextureRoots {
  /** 主根（地图模型根）；null = 无地图（调用方通常已提前返回）。 */
  mainRoot: THREE.Object3D | null;
  /** 天空区组（`assembleScene` 的 `skyGroup`）；null/缺省 = 本图无 3D 天空盒。 */
  skyRoot?: THREE.Object3D | null;
}

/** `applySceneTextureQuality` 的入参。 */
export interface SceneTextureQualityInput extends SceneTextureRoots {
  manifest: Record<string, string>;
  quality: 'original' | 'mini';
  origImages: Map<THREE.Texture, unknown>;
  deps: MosaicDeps;
}

/** 收集若干根子树里材质 `map` 槽位上的去重贴图（收集口径的唯一实现）。 */
function collectMaps(roots: readonly THREE.Object3D[]): Set<THREE.Texture> {
  const maps = new Set<THREE.Texture>();
  for (const root of roots) {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      const list = Array.isArray(mat) ? mat : [mat];
      for (const m of list) {
        const map = (m as unknown as { map?: THREE.Texture | null }).map;
        if (map) maps.add(map);
      }
    });
  }
  return maps;
}

/** 对给定贴图集合执行一次切换（切换语义的唯一实现）。 */
async function switchMaps(
  maps: Set<THREE.Texture>,
  manifest: Record<string, string>,
  quality: 'original' | 'mini',
  origTextureImages: Map<THREE.Texture, unknown>,
  deps: MosaicDeps,
): Promise<TextureQualityResult> {
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

/**
 * 三端统一入口（T-460 WP6）：遍历**主根 + 天空组**后切换贴图。
 *
 * `manifest` 为空（无 mosaic 清单）或主根为 null 时由调用方提前返回，本函数假定入参就绪。
 * 打一行三端同格式的诊断（`maps/matched/noMatch` 用于「三端命中数相同」的比对）。
 */
export async function applySceneTextureQuality(input: SceneTextureQualityInput): Promise<TextureQualityResult> {
  const roots = [input.mainRoot, input.skyRoot].filter((r): r is THREE.Object3D => r !== null && r !== undefined);
  const result = await switchMaps(collectMaps(roots), input.manifest, input.quality, input.origImages, input.deps);
  console.log(
    `[texture-quality] 遍历根=主根${input.skyRoot ? '+天空组' : ''} quality=${input.quality} maps=${result.mapCount} matched=${result.matched} noMatch=${result.noMatch.length}`,
  );
  return result;
}

/**
 * 单根低层入口：切换遍历 `sceneRoot` 子树的贴图画质（`applySceneTextureQuality` 内部也走它）。
 *
 * `sceneRoot` 由应用侧给定；manifest 为空时由调用方提前返回，本函数假定入参就绪。
 */
export async function applyTextureQuality(
  sceneRoot: THREE.Object3D,
  manifest: Record<string, string>,
  quality: 'original' | 'mini',
  origTextureImages: Map<THREE.Texture, unknown>,
  deps: MosaicDeps,
): Promise<TextureQualityResult> {
  return switchMaps(collectMaps([sceneRoot]), manifest, quality, origTextureImages, deps);
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
