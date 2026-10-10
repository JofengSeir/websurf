/**
 * 三端共享的**只读渲染状态探针**（T-460 WP7；与 `camera/pose-entry.ts` 同族）。
 *
 * 为什么有这一层：三端一致性此前只能靠「各端控制台日志格式各异」或「截图逐像素」来判断——前者
 * 判不全（状态取不到），后者需要浏览器渲染且不可复现（R2 明确不作判据）。本模块把三端**可比的状态**
 * 定义成一个固定形状的快照，挂到 `globalThis.__vbspRenderProbe.snapshot()`：
 *
 *   - 共享部分（各端同源、探针自己取）：`prefs`（生效档 + 档指纹 + 来源）、`envmap`（反射源 ready /
 *     计数 / 缺源计数）、`viewport`（画布矩形 + 声明来源 + 「声明与实际是否一致」）；
 *   - 端私有部分（由各端以 `suppliers` 供给，**只读**）：`cull`（生效/自动/档值）、`pvs`（开关 /
 *     上帧 PVS 剔除数 / 可见 cluster 数）、`merge`（输入 mesh 数 / 块数 / draw call 估算）、
 *     `sky`（有无天空层组 / 子图元数）。
 *
 * 快照形状与字段口径**由本模块固定**，各端不得自定义（R1）；探针只读状态，不改任何渲染行为，
 * 不调用 `setPose`/不触发重绘。判定脚本见 `src/scripts/check-render-consistency.mjs`。
 */
import { getReflectionEnvMapState } from '../shader/lightmap-shader.js';
import { readRenderPrefs, renderPrefsFingerprint } from '../config/render-prefs.js';
import type { PoseScope } from '../camera/pose-entry.js';

/** 视口来源声明（D3）：debug 的画布在布局内（`#previewArea`），game/viewer 用整窗画布。 */
export type ViewportSource = 'layout-canvas' | 'full-window';

/** 各端可能取不到的私有状态（未就绪时返回 null，快照里就是 null）。 */
export interface RenderProbeSuppliers {
  /** 端标识（写进 `snapshot.scope`）。 */
  scope: PoseScope;
  /** 视口来源声明（D3：只声明、不改布局）。 */
  viewportSource: ViewportSource;
  /** 主画布（读 `getBoundingClientRect` 与 CSS 尺寸）。 */
  canvas: () => HTMLCanvasElement | null;
  /** 剔除距离：生效值 / 自动值 / 档值（0 = 自动）。 */
  cull?: () => { distance: number; auto: number; configured: number } | null;
  /** PVS：开关 / 上帧 PVS 剔除块数 / 当前可见 cluster 数。 */
  pvs?: () => { enabled: boolean; pvsHidden: number; clusters: number } | null;
  /** 合并统计：输入 mesh 数 / 块数 / draw call 估算（读产出根的 `userData.vbspMerge`）。 */
  merge?: () => { meshes: number; chunks: number; drawCallEst: number } | null;
  /** 天空层：有无分组 / 子对象数。 */
  sky?: () => { hasGroup: boolean; children: number } | null;
}

/** 视口字段：画布矩形 + 声明来源 + 一致性（`matches`）。 */
export interface RenderProbeViewport {
  x: number;
  y: number;
  w: number;
  h: number;
  aspect: number;
  source: ViewportSource;
  /** 声明与实际是否一致：`full-window` 要求画布覆盖视口，`layout-canvas` 要求小于视口（容差 2 px）。 */
  matches: boolean;
}

/** 三端一致性快照（形状固定；`check-render-consistency.mjs` 逐字段比对）。 */
export interface RenderProbeSnapshot {
  scope: PoseScope;
  prefs: {
    exposure: number;
    lightGamma: number;
    ambientScale: number;
    propVertexRelax: number;
    propVertexFlatten: number;
    mode: string;
    quality: string;
    fov: number;
    cull: number;
    pvs: boolean;
    /** 档指纹（`renderPrefsFingerprint`）。 */
    fingerprint: string;
    /** 取档来源：`deep-link`（`?prefs=`）/ `storage`。 */
    source: string;
  };
  envmap: { ready: boolean; applied: number; missing: number };
  cull: { distance: number; auto: number; configured: number } | null;
  pvs: { enabled: boolean; pvsHidden: number; clusters: number } | null;
  merge: { meshes: number; chunks: number; drawCallEst: number } | null;
  viewport: RenderProbeViewport;
  sky: { hasGroup: boolean; children: number } | null;
}

/** 挂在 `globalThis` 上的入口。 */
export interface RenderProbeEntry {
  readonly scope: PoseScope;
  snapshot(): RenderProbeSnapshot;
  /** 单行描述（三端同格式；日志与人工核对用）。 */
  describe(): string;
}

/** 判定「声明与实际一致」（静态部分由 `check-render-parity.mjs` 的 [J] 断言，这里是运行期核对）。 */
function viewportMatches(source: ViewportSource, rect: { width: number; height: number }): boolean {
  const iw = typeof window === 'undefined' ? rect.width : window.innerWidth;
  const ih = typeof window === 'undefined' ? rect.height : window.innerHeight;
  if (source === 'full-window') return Math.abs(rect.width - iw) <= 2 && Math.abs(rect.height - ih) <= 2;
  return rect.width < iw - 2 || rect.height < ih - 2;
}

/** 读画布矩形；无画布时所有数值为 0、`matches=false`。 */
function readViewport(source: ViewportSource, canvas: HTMLCanvasElement | null): RenderProbeViewport {
  if (!canvas) return { x: 0, y: 0, w: 0, h: 0, aspect: 0, source, matches: false };
  const r = canvas.getBoundingClientRect();
  const w = Math.round(r.width);
  const h = Math.round(r.height);
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    w,
    h,
    aspect: +(w / Math.max(h, 1)).toFixed(4),
    source,
    matches: viewportMatches(source, r),
  };
}

/** 快照 → 单行描述（三端同格式）。 */
export function describeRenderProbe(s: RenderProbeSnapshot): string {
  const p = s.prefs;
  return (
    '[render-probe] scope=' + s.scope +
    ' viewport=' + s.viewport.source + ' ' + s.viewport.w + 'x' + s.viewport.h + '(matches=' + s.viewport.matches + ')' +
    ' aspect=' + s.viewport.aspect +
    ' fp=' + p.fingerprint + '/' + p.source +
    ' envmap=' + (s.envmap.ready ? 'ready' : 'none') + '/' + s.envmap.applied + '/' + s.envmap.missing +
    ' cull=' + (s.cull ? s.cull.distance + '(auto=' + s.cull.auto + ',cfg=' + s.cull.configured + ')' : 'n/a') +
    ' pvs=' + (s.pvs ? (s.pvs.enabled ? 'on' : 'off') + '/' + s.pvs.pvsHidden + '/' + s.pvs.clusters : 'n/a') +
    ' merge=' + (s.merge ? s.merge.meshes + '→' + s.merge.chunks + '/' + s.merge.drawCallEst : 'n/a') +
    ' sky=' + (s.sky ? (s.sky.hasGroup ? '1' : '0') + '/' + s.sky.children : 'n/a')
  );
}

/** 组装一次快照（共享字段自己取，私有字段走 suppliers）。 */
function takeSnapshot(s: RenderProbeSuppliers): RenderProbeSnapshot {
  const rp = readRenderPrefs();
  const env = getReflectionEnvMapState();
  return {
    scope: s.scope,
    prefs: {
      exposure: rp.lighting.exposure,
      lightGamma: rp.lighting.lightGamma,
      ambientScale: rp.lighting.ambientScale,
      propVertexRelax: rp.lighting.propVertexRelax,
      propVertexFlatten: rp.lighting.propVertexFlatten,
      mode: rp.lighting.mode,
      quality: rp.textureQuality,
      fov: rp.camera.fov,
      cull: rp.culling.distance,
      pvs: rp.culling.pvs,
      fingerprint: renderPrefsFingerprint(rp),
      source: String((globalThis as { __vbspRenderPrefsSource?: unknown }).__vbspRenderPrefsSource ?? 'unknown'),
    },
    envmap: { ready: env.ready, applied: env.applied, missing: env.missing },
    cull: s.cull?.() ?? null,
    pvs: s.pvs?.() ?? null,
    merge: s.merge?.() ?? null,
    viewport: readViewport(s.viewportSource, s.canvas()),
    sky: s.sky?.() ?? null,
  };
}

/**
 * 挂载只读探针：接到 `globalThis.__vbspRenderProbe`。
 * 生产路径零影响——不调用 `snapshot()` 就不读任何状态。
 */
export function installRenderProbe(suppliers: RenderProbeSuppliers): RenderProbeEntry {
  const entry: RenderProbeEntry = {
    scope: suppliers.scope,
    snapshot(): RenderProbeSnapshot {
      return takeSnapshot(suppliers);
    },
    describe(): string {
      return describeRenderProbe(takeSnapshot(suppliers));
    },
  };
  (globalThis as unknown as { __vbspRenderProbe?: RenderProbeEntry }).__vbspRenderProbe = entry;
  console.info(
    '[render-probe] 已挂载：scope=' + suppliers.scope + ' viewport=' + suppliers.viewportSource + ' 入口=globalThis.__vbspRenderProbe',
  );
  return entry;
}
