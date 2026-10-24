/**
 * ViewerScene：viewer 端的**薄壳**——只保留 viewer 特有功能（自由飞行、回放轨道挂载、
 * 拾取/量测用的 `worldBox`），渲染装配与每帧绘制全部委托共享 `RenderSession`。
 *
 * 2026-10-23：三端渲染收口的 viewer 落点。此前本文件自持 renderer/scene/camera、装配核、
 * 可见性、近平面、天空层、画质与 env 注册——与 game/debug 各写一遍；现在这些步骤只在
 * `src/renderer-shared/scene/render-session.ts` 里存在一份。本文件只保留：
 *   - viewer 的换图生命周期与 `mountGlb` 入参形状（本地 BSP / 深链）；
 *   - `scene`/`camera`/`renderer` 的只读访问（回放轨道、HUD、拾取用）；
 *   - `worldBox` / `hasModel`（初始视角与量测）；
 *   - `__vbspTextureQuality` 的 viewer 诊断行（算法仍在共享层）。
 */
import * as THREE from 'three';
import type { MapFogParams } from '../../../../src/renderer-shared/environment/render-sky-pass.js';
import type { SkyCameraParams } from '../../../../src/renderer-shared/environment/miniature-sky.js';
import {
  RenderSession,
  type RenderSceneResult,
} from '../../../../src/renderer-shared/scene/render-session.js';
import { readRenderPrefs } from '../../../../src/renderer-shared/config/render-prefs.js';
import type { LightingMode } from '../../../../src/renderer-shared/shader/lightmap-shader.js';
import { mosaic_decode } from './bsp.js';
import { BG_COLOR } from './constants.js';

/** viewer 端换图时那份天空/雾/PVS/画质清单（与 `core/bsp.ts` 的装载结果同形）。 */
export interface ViewerMapSky {
  fogParams?: MapFogParams | null;
  skyCamera?: SkyCameraParams | null;
  pvsJson?: string;
  mosaicManifest?: Record<string, string> | null;
}

export class ViewerScene {
  /** 三端唯一的渲染会话：renderer/scene/camera/装配/可见性/天空/画质都在里面。 */
  private readonly session: RenderSession;

  constructor(canvas: HTMLCanvasElement) {
    this.session = new RenderSession({
      canvas,
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      dpr: window.devicePixelRatio,
      app: 'viewer',
      backgroundColor: BG_COLOR,
      mosaic: { decode: mosaic_decode },
      viewportSource: 'full-window',
    });
    (globalThis as unknown as { __vbspTextureQuality?: (q: 'original' | 'mini') => Promise<void> }).__vbspTextureQuality =
      (q) => this.applyTextureQuality(q);
    // 诊断：水面反射/材质定位需要遍历真实场景（只读；不参与渲染逻辑）
    (globalThis as unknown as { __vbspViewerScene?: THREE.Scene }).__vbspViewerScene = this.session.scene;
  }

  /** three 渲染器（回放/HUD 读 `domElement` 用；只读）。 */
  get renderer(): THREE.WebGLRenderer {
    return this.session.renderer;
  }

  /** 主场景（回放轨道与端特有叠加层挂这里；只读）。 */
  get scene(): THREE.Scene {
    return this.session.scene;
  }

  /** 主相机（自由飞行每帧写位姿；只读）。 */
  get camera(): THREE.PerspectiveCamera {
    return this.session.camera;
  }

  hasModel(): boolean {
    return this.session.hasModel();
  }

  /** 当前地图的世界包围盒（由共享会话现算；无地图时为 null）。 */
  worldBox(): THREE.Box3 | null {
    return this.session.worldBox();
  }

  resize(canvas: HTMLCanvasElement): void {
    this.session.resize(canvas.clientWidth, canvas.clientHeight);
  }

  /** 每帧绘制：可见性 → 近平面 → 天空/主世界（共享会话唯一实现）。 */
  render(): void {
    this.session.frame();
  }

  add(obj: THREE.Object3D): void {
    this.session.scene.add(obj);
  }

  remove(obj: THREE.Object3D): void {
    this.session.scene.remove(obj);
  }

  /** 挂载 GLB（替换旧地图）：装配/环境/天空/可见性/画质全部由共享会话完成。 */
  async mountGlb(
    glbBytes: ArrayBuffer,
    skyboxTexture?: import('three').CubeTexture | null,
    sky?: ViewerMapSky,
  ): Promise<void> {
    const result: RenderSceneResult = await this.session.loadScene({
      glb: glbBytes,
      pvsJson: sky?.pvsJson ?? null,
      skyCamera: sky?.skyCamera ?? null,
      fogParams: sky?.fogParams ?? null,
      skyboxTexture: skyboxTexture ?? null,
      mosaicManifest: sky?.mosaicManifest ?? null,
      quality: readRenderPrefs().textureQuality,
    });
    const cull = Number.isFinite(result.defaultCull) ? result.defaultCull.toFixed(1) : '全加载';
    console.info(
      `[viewer][render-session] 装载完成：maxDim=${result.maxDim.toFixed(1)} ` +
        `diagonal=${result.diagonal.toFixed(1)} 剔除=${cull} ` +
        `merge=${result.merge ? result.merge.meshes + '→' + result.merge.chunks : '未合并'}`,
    );
  }

  /** 面板/深链改剔除距离（0 = 自动）。 */
  setCullDistance(dist: number): void {
    this.session.setCullDistance(dist);
  }

  /** 面板/深链改 FOV。 */
  setFov(fov: number): void {
    this.session.setFov(fov);
  }

  setLightingMode(mode: LightingMode): void {
    this.session.setLightingMode(mode);
  }

  getLightingMode(): LightingMode {
    return this.session.getLightingMode();
  }

  /** 贴图画质：算法在共享会话，本方法只补 viewer 的诊断行。 */
  async applyTextureQuality(quality: 'original' | 'mini'): Promise<void> {
    const stats = await this.session.applyTextureQuality(quality);
    console.log(`[renderer] 画质切换 → ${quality}，modelRoot=${this.session.hasModel()}`);
    if (!stats) return;
    console.log(`[renderer] 场景贴图 ${stats.mapCount} 个`);
    console.log(`[renderer] mini 匹配 ${stats.matched}/${stats.mapCount}；未匹配:`, stats.noMatch.slice(0, 12));
  }
}
