/**
 * 载图期「整帧预热」流水线（T-P2-2c 从 `render-session.ts` 机械搬出，逻辑零改动）。
 *
 * 这里只保留实现：调用点仍是 `RenderSession.prewarmPasses()`，宿主通过 `PrewarmHost`
 * 传进来（渲染器/场景/相机/控制器都是会话的同一份实例，不复制状态）。
 * 下面的缩进保留搬出前的层级（方法体从 4 空格起），便于与旧版逐行对照。
 */
import * as THREE from 'three';
import { renderWaterFramePasses } from '../shader/water.js';
import type { NearPlaneController } from '../camera/near-plane.js';
import type { VisibilityController } from './visibility-controller.js';
import type { FrameBudgetController } from './frame-budget.js';
import type { RenderFrameContext } from './render-context.js';

/** 预热需要的会话能力子集（结构类型，`RenderSession` 直接满足）。 */
export interface PrewarmHost {
  readonly app: string;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** 当前图根（会话里是私有字段，走访问器以免结构类型撞私有成员）。 */
  getRoot(): THREE.Object3D | null;
  /** PVS 覆盖开关（同上：私有字段 + 需要写回）。 */
  getPvsOverride(): boolean | null;
  setPvsOverride(v: boolean | null): void;
  /** 自动视距开关（同上）。 */
  getPvsAutoCull(): boolean | null;
  setPvsAutoCull(v: boolean | null): void;
  readonly nearPlane: NearPlaneController;
  readonly visibility: VisibilityController;
  readonly frameCtx: RenderFrameContext;
  readonly budget: FrameBudgetController;
  updateVisibility(): unknown;
  frame(opts?: { updateVisibility?: boolean; updateNearPlane?: boolean }): unknown;
}

/**
 * 载图期「整帧预热」：临时放开可见性/视锥剔除/PVS/视距，让整张图在真实 pass 下画一遍，
 * 把 主遍 / 水面折射 / 水面镜像 / 天空 / 泛光 各形态的 program 都编译并链接好。
 *
 * 为什么需要：冷启动实测（.tmp/flight-195645.json）首飞途中才编译 31~35 个 program
 * （806×458 RGBA8 + NoColorSpace 的折射 RT 24 个、screen 11 个），最长一帧 159~200ms，
 * 玩家看到的就是一次明显卡死；同页热跑 max 只有 18~22ms。
 *
 * 为什么不是 renderer.compile()：three r165 的 cacheKey 里 RT 的 format/type **不进 key**，
 * 只带 outputColorSpace(sRGB/LinearSRGB)、fog、灯数、对象 flags、注入 key；而 compile()
 * 会把 render target 置 null 再编，所以「按假 RT compile」既编不出 LinearRT 变体，也编不到
 * 水面/泛光自己的材质（实测冷跑仍 +31、max 171.88ms）。只有真跑一帧、真进各 pass 的 RT
 * 状态才拿得到正确变体。
 *
 * 为什么还要强制 PVS/视距：光放开 visible 不够 —— chunk 几何被 applyClusterIndex 按相机
 * 所在房间裁成 drawRange，场外/别处的块 drawRange=0，一帧只覆盖出生点附近的材质（实测
 * 393 个材质只画了 148 个）。这里改走「PVS 关 + 视距 ∞ + 全量 index」，一帧覆盖整张图。
 *
 * 代价：一次性约 300~800ms 载图时间（取决于对象数/待编译数），运行期零新增编译。
 * 开关：__vbspPrewarmPassesEnabled = false；诊断：__vbspPrewarmPasses。
 *
 * 幂等：第二次起 program 全命中缓存（实测 10 连调 `[+14, 0×9]`），只是再画一遍整帧。
 * 粒子/激光（`setupSceneExtras`）自 a77eee9 起在 loadScene 内、早于本方法装配；但它们的
 * `visible` 会在 `frame()` 的 extras update 里被按相机重新裁剪，所以预热期间临时旁路剔除
 * （`__vbspParticleCullOff`）；否则折射/镜面 RT 画不到它们，
 * LinearSRGB 变体留到首飞现编。
 */
export function runPrewarmPasses(h: PrewarmHost): void {
    const g = globalThis as {
      __vbspPrewarmPasses?: unknown;
      __vbspPrewarmPassesEnabled?: boolean;
    };
    if (g.__vbspPrewarmPassesEnabled === false) return;
    // 预热是「载图后的假帧」：再清一次采样窗口（async 载图期间旧图末尾的帧可能已经采过），
    // 防止预热帧与载图长帧污染新图的预算评估（审查 P1-3）。
    h.budget.reset();
    // 临时放开「不可见 / 视锥剔除」，让整帧 pass 覆盖到全部对象；结束后按逆序还原。
    // ⚠️ 不能放开**灯**：`LightManager` 的 8 槽点光源池在生产态恒为 `visible=false`
    // （`updatePointLights` 无调用点），three r165 的 program cacheKey 里带 `numPointLights`，
    // 把灯临时点亮预热会编出 pt=8 的变体（实测载图后 progs 68→102，但首飞仍 +34 个 pt=0 变体）。
    const restore: Array<() => void> = [];
    h.scene.traverse((obj) => {
      if ((obj as THREE.Object3D & { isLight?: boolean }).isLight === true) return;
      if (obj.visible === false) {
        restore.push(() => {
          obj.visible = false;
        });
        obj.visible = true;
      }
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.frustumCulled !== false) {
        restore.push(() => {
          mesh.frustumCulled = true;
        });
        mesh.frustumCulled = false;
      }
    });
    const prevTarget = h.renderer.getRenderTarget();
    // 近平面探测的块级三角形网格也是懒建的（整图建一遍实测 ~58ms）。首飞第一帧正好是第一次
    // 探测（`tick` 每 2 帧一次、物理就绪后才开），这笔开销会整段落在那一帧上（实测 near 段
    // 57.66ms / 整帧 64.91ms，且 program 数没变 ⇒ 与着色器无关）。载图期先建好；幂等。
    const nearGrids = h.nearPlane.prewarmGrids(h.getRoot());
    // 临时关 PVS、剔除距离放到无穷、关水面「视锥高度门控」：预热帧要把整张图都画一遍。
    // 还原时刻意写字段而不是调 setCullDistance()：后者会按当前 PVS 档重算 auto 距离，
    // 覆盖掉存档里的面板视距；这里要的是**逐字段原样**。
    const savedPvsOverride = h.getPvsOverride();
    const savedEnablePvs = h.visibility.enablePvs;
    const savedAutoCull = h.visibility.autoCullDistance;
    const savedCull = h.visibility.cullDistance;
    const savedAutoFlag = h.getPvsAutoCull();
    const gw = globalThis as {
      __vbspWaterFrustumGate?: boolean;
      __vbspWaterRefrCadence?: number;
      __vbspWaterMirrorCadence?: number;
      __vbspBudgetOn?: boolean;
    };
    const savedWaterGate = gw.__vbspWaterFrustumGate;
    // 水面折射默认隔帧（`water.ts` `refrCadence` 默认 2），镜面在预算升到 2 级时每 3 帧一次；
    // 帧预算控制器还可能已经升过级。预热帧要把「每种 pass 形态」都真跑一遍，否则那个形态的
    // program 要等首飞第一次轮到它才编：实测预热帧被 cadence 跳过镜面 ⇒ 冷跑首飞补编 7 个
    // 1024² 镜面 RT 变体、单帧 28ms。这里临时强制全帧率 + 冻结预算档，finally 还原。
    // ⚠️ 只强制 cadence 不够：`frame()` 内两计数同步 +1、平票时 water.ts 恒选折射，镜面 RT
    // 仍不会渲 —— 由下面的 `frameCtx.waterForcePass = 'mirror'` 在 frame() 之后补一趟，见 try 内注释。
    const savedRefrCadence = gw.__vbspWaterRefrCadence;
    const savedMirrorCadence = gw.__vbspWaterMirrorCadence;
    const savedBudgetOn = gw.__vbspBudgetOn;
    // 预热帧内旁路粒子/光效的「距离 + 视锥」剔除（`particles.ts` `cullByCamera` 的
    // `__vbspParticleCullOff` 分支）：`frame()` 先跑 extras update，会按出生点相机把视锥外/
    // 超距的光效重新置 `visible=false`，覆盖上面 traverse 的放开 ⇒ 它们的材质进不了水面
    // 折射/镜面 RT，LinearSRGB 变体只能等首飞现编。finally 原样还原。
    const gc = globalThis as { __vbspParticleCullOff?: boolean };
    const savedParticleCullOff = gc.__vbspParticleCullOff;
    h.setPvsOverride(false);
    h.setPvsAutoCull(false); // 与 enablePvs 一致 ⇒ updateVisibility() 的自动距离分支不覆盖 ∞
    h.visibility.enablePvs = false;
    h.visibility.autoCullDistance = Number.POSITIVE_INFINITY;
    h.visibility.cullDistance = Number.POSITIVE_INFINITY;
    gw.__vbspWaterFrustumGate = false;
    gw.__vbspWaterRefrCadence = 1;
    gw.__vbspWaterMirrorCadence = 1;
    gw.__vbspBudgetOn = false;
    gc.__vbspParticleCullOff = true;
    const t0 = performance.now();
    let ok = true;
    // 预热序号：既用于诊断，也用于相机挪动幅度——两趟预热不能挪到同一个坐标，
    // 否则第二趟会被 `cameraChangedSinceRt` 判成「没动」而整趟跳过水面折射/镜像
    // （实测第二趟 draws 只有 645 = 仅主遍，programs 只 +7；折射变体一个都没编）。
    const callNo = ((g as { __vbspPrewarmCalls?: number }).__vbspPrewarmCalls ?? 0) + 1;
    (g as { __vbspPrewarmCalls?: number }).__vbspPrewarmCalls = callNo;
    // 诊断：这一帧到底画了多少 draw、编了多少 program、场景里有几个子节点。
    // autoReset=false + reset() 才能让 info.render.calls 累计整帧（含折射/镜像/泛光各 pass）。
    const info = h.renderer.info;
    const prevAutoReset = info.autoReset;
    const progsBefore = info.programs?.length ?? 0;
    // 水面 pass 计数（water.ts 的 `__vbspWaterRefrRenders` / `__vbspWaterMirrorRenders`）：
    // 预热帧到底跑没跑折射/镜面直接看这两个增量，不用靠猜。
    const waterCounters = globalThis as {
      __vbspWaterRefrRenders?: number;
      __vbspWaterMirrorRenders?: number;
    };
    const refrBefore = waterCounters.__vbspWaterRefrRenders ?? 0;
    const mirrorBefore = waterCounters.__vbspWaterMirrorRenders ?? 0;
    info.autoReset = false;
    info.reset();
    let draws = 0;
    // 水面折射/镜像 pass 有「相机没动就跳过」的门控（`water.ts` `cameraChangedSinceRt`）。
    // 预热常在相机静止时调用（载图后立刻预热、或挂完粒子再预热一次），不挪一下相机这趟 pass
    // 根本不跑 ⇒ 折射 RT 的 LinearSRGB 变体编不出来（实测首飞补编 7 个、单帧 ~60ms）。
    // 这里只把相机挪 1 HU 并在 finally 还原：预热帧的画面坐标无关紧要，不写回玩家相机。
    const savedCamPos = h.camera.position.clone();
    const savedCamWorld = h.camera.matrixWorld.clone();
    h.camera.position.set(
      savedCamPos.x + 1 + callNo,
      savedCamPos.y,
      savedCamPos.z,
    );
    h.camera.updateMatrixWorld(true);
    try {
      // 全量 index（restoreClusterIndex）+ 全部块可见，再跑一帧真实 pass。
      h.updateVisibility();
      h.frame({ updateVisibility: false, updateNearPlane: false });
      // 补一趟镜面 RT（见 water.ts `__vbspWaterForcePass`）：单次 frame() 在折射/镜面都到期时
      // 恒选折射，镜面 RT 会拖到首飞第一个移动帧才渲。此刻粒子/光效还处于上面的 cullOff
      // 状态，随整场景 pass 一起进 program 缓存。失败只告警，不影响载图。
      try {
        // T-P2-1：走上下文而不是写 `__vbspWaterForcePass` 全局（逃生舱仍保留给外部脚本）。
        h.frameCtx.waterForcePass = 'mirror';
        renderWaterFramePasses(h.renderer, h.scene, h.camera, h.frameCtx);
      } catch (err) {
        console.warn(`[${h.app}][prewarm] 镜面 RT 预热失败（不影响运行，首飞会补编）:`, err);
      } finally {
        // 无论成败都必须清掉：否则后续每帧都会被强制只跑镜面 pass。
        h.frameCtx.waterForcePass = undefined;
      }
    } catch (err) {
      ok = false;
      console.warn(`[${h.app}][prewarm] 预热帧失败（不影响运行，着色器将按需编译）:`, err);
    } finally {
      draws = info.render.calls;
      info.autoReset = prevAutoReset;
      info.reset();
      h.renderer.setRenderTarget(prevTarget);
      // 相机还原（含 matrixWorld，避免析构帧仍用挪过的位姿）：只影响下一帧画面，
      // 下一帧的 `frame()` 会自己重算矩阵。
      h.camera.position.copy(savedCamPos);
      h.camera.matrixWorld.copy(savedCamWorld);
      h.camera.matrixWorldInverse.copy(savedCamWorld).invert();
      h.camera.updateMatrixWorld(true);
      h.setPvsOverride(savedPvsOverride);
      h.visibility.enablePvs = savedEnablePvs;
      h.visibility.autoCullDistance = savedAutoCull;
      h.visibility.cullDistance = savedCull;
      h.setPvsAutoCull(savedAutoFlag);
      gw.__vbspWaterFrustumGate = savedWaterGate;
      gw.__vbspWaterRefrCadence = savedRefrCadence;
      gw.__vbspWaterMirrorCadence = savedMirrorCadence;
      gw.__vbspBudgetOn = savedBudgetOn;
      gc.__vbspParticleCullOff = savedParticleCullOff;
      // 预热期间 `__vbspBudgetOn=false` 不采样；把起点清零，让预热后的第一帧 dt 记为 0。
      // 否则那帧间隔会跨整个载图/预热段（数百 ms），被预算当成一次双槽（审查 P1-3）。
      h.budget.lastStart = 0;
      for (let i = restore.length - 1; i >= 0; i--) restore[i]();
      // 按真实状态重算一次：把 PVS 裁过的 index / 块可见性还原成出生点该有的样子。
      try {
        h.updateVisibility();
      } catch (err) {
        console.warn(`[${h.app}][prewarm] 预热后恢复可见性失败:`, err);
      }
    }
    const total = +(performance.now() - t0).toFixed(1);
    const programs = h.renderer.info.programs?.length ?? null;
    const refrDelta = (waterCounters.__vbspWaterRefrRenders ?? 0) - refrBefore;
    const mirrorDelta = (waterCounters.__vbspWaterMirrorRenders ?? 0) - mirrorBefore;
    g.__vbspPrewarmPasses = {
      call: callNo,
      total,
      ok,
      draws,
      programs,
      progsBefore,
      kids: h.scene.children.length,
      nearGrids,
      refr: refrDelta,
      mirror: mirrorDelta,
    };
    console.info(
      `[${h.app}][prewarm] #${callNo} 整帧预热 ${total}ms（放开 ${restore.length} 项，已还原）` +
        ` draws=${draws} programs=${progsBefore}→${programs ?? '?'} nearGrids=${nearGrids}` +
        ` refr=${refrDelta} mirror=${mirrorDelta} kids=${h.scene.children.length}`,
    );
  }
