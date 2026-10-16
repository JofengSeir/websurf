/**
 * 三端渲染呈现档的**唯一来源**（T-454 P1；任务书 `.tmp/task-unify-render/TASK.md` §2/L6）。
 *
 * 为什么有这一层：三端**各持一份**渲染档（2026-10-16 owner 裁决：三端参数绝不互相影响）。
 * 键按端作用域化 = `vbsp:renderPrefs:<viewer|debug|game>`；作用域由各端 `web/index.html` 注入的
 * `globalThis.__VBSP_APP__` 决定，注入缺失时回退 URL 路径里的 `/viewer|/debug|/game` 段。
 *
 * 历史与现代价：2026-10-09 曾按 `OWNER.md` D-108 把三端收到**唯一键** `vbsp:renderPrefs`（图的是
 * 面板只在 game + 「三端同画面」可验收）——但线上三端同 origin ⇒ localStorage 本就共享，game 面板把
 * 「模型光照」(`ambientScale`) 拖到 0 之后**三端的 prop 一起全黑**（2026-10-16 事故）。⇒ 改为按端隔离：
 * 共享的只剩代码里的默认档 `defaultRenderPrefs()`；要「三端同画面」走**深链覆盖** `?prefs=`（见下）。
 * 旧共用键 `vbsp:renderPrefs` 只作**迁移来源**、且**只迁给 game**（它才是旧档的作者）。
 *
 * 字段与生效阶段（本阶段只把 `lighting` / `textureQuality` 接上，其余先声明、由后续阶段消费）：
 *   - `lighting.*`：**P1 生效**（三端 init 调 `applyRenderPrefs`，值取本模块）；
 *   - `textureQuality`：**P1 生效**（三端把各自的画质档接到它；viewer 无 mosaic 导出 ⇒ 其贴图切换 P6 才生效）；
 *   - `culling.*`：P4 生效（`visibility-controller.ts` 消费；`distance` 语义 = 显式距离，0 = 自动 `maxDim × 0.5`）；
 *   - `camera.fov`：P3 生效（相机统一时消费）。
 *
 * 旧键只读兼容：**只有 game 作用域**迁移一次——先试旧共用键，再退到面板旧档 `vbsp:panelPrefs`
 * （lighting / hud.fov / hud.renderDistance / texture.quality）；debug 与 viewer 一律从默认档起步，
 * 不继承任何旧值（debug 的 `vbsp:uiPrefs` 是它自己的面板档，画质档不再从中搬）。旧键一律不删。
 *
 * 跨端可比性（T-460 WP2 / D1=A）：**深链覆盖** `?prefs=default|<base64(JSON)>`（优先级最高、不落盘）
 * 与**档指纹**（`fp=`）是唯一让三端落到同一档的手段——本地三端各占一个端口、线上三端同 origin，
 * 都不该靠共享存档来对齐。判据 = 各端控制台的 `[render-prefs] 生效：… fp=… scope=…` 一行。
 */
import {
  LIGHTING_PRESENTATION_DEFAULTS,
  setExposure,
  setLightGamma,
  setAmbientScale,
  setPropVertexRelax,
  setPropVertexFlatten,
  setLightingMode,
  type LightingMode,
} from '../shader/lightmap-shader.js';

/** 旧版**共用**键（2026-10-16 起只作迁移来源、不再写入；`apps/**` 不得出现这个字面量）。 */
export const LEGACY_RENDER_PREFS_KEY = 'vbsp:renderPrefs';

/** 按端作用域的键前缀：实际键 = 前缀 + `<viewer|debug|game>`。 */
export const RENDER_PREFS_KEY_PREFIX = LEGACY_RENDER_PREFS_KEY + ':';

/** 三端作用域（每端一份档，互不影响）。 */
export type RenderPrefsScope = 'viewer' | 'debug' | 'game';
const SCOPES: readonly string[] = ['viewer', 'debug', 'game'];

/** 判不出所属端时的兜底作用域（只读默认档、不迁移）。 */
export const RENDER_PREFS_FALLBACK_SCOPE = 'shared';

let scopeCache: string | null = null;

/**
 * 本端作用域：① 各端 `web/index.html` 注入的 `globalThis.__VBSP_APP__`（最可靠）；
 * ② URL 路径里的 `/viewer|/debug|/game` 段（dev 与部署都命中）；③ `'shared'`。
 */
export function renderPrefsScope(): string {
  if (scopeCache) return scopeCache;
  let injected = '';
  try {
    const g = globalThis as { __VBSP_APP__?: unknown };
    if (typeof g.__VBSP_APP__ === 'string') injected = g.__VBSP_APP__;
  } catch {
    /* 无 globalThis：忽略 */
  }
  let fromPath = '';
  try {
    const m = /\/(viewer|debug|game)(?:\/|$)/.exec(location.pathname);
    if (m) fromPath = m[1];
  } catch {
    /* 无 location（worker 等）：忽略 */
  }
  scopeCache = SCOPES.includes(injected) ? injected : SCOPES.includes(fromPath) ? fromPath : RENDER_PREFS_FALLBACK_SCOPE;
  return scopeCache;
}

/** 本端的存储键（`vbsp:renderPrefs:<scope>`）。 */
export function renderPrefsKey(): string {
  return RENDER_PREFS_KEY_PREFIX + renderPrefsScope();
}

/** 结构版本：字段增删时递增；版本不符按「丢弃存档、用默认档」处理（与面板偏好同口径）。 */
export const RENDER_PREFS_VERSION = 1;

/** 只读兼容的旧键（迁移来源，不删）：[0] = game 面板旧档（game 作用域迁移用）。 */
export const LEGACY_PREFS_KEYS = ['vbsp:panelPrefs', 'vbsp:uiPrefs'] as const;

/** 画质档（与 `scene/texture-quality.ts` 的 mosaic 数据源选择同义）。 */
export type TextureQualityPref = 'original' | 'mini';

/** 呈现档（静态光照五档 + 模式）。 */
export interface RenderLightingPrefs {
  exposure: number;
  lightGamma: number;
  ambientScale: number;
  propVertexRelax: number;
  propVertexFlatten: number;
  mode: LightingMode;
}

export interface RenderPrefs {
  version: number;
  lighting: RenderLightingPrefs;
  textureQuality: TextureQualityPref;
  culling: { distance: number; pvs: boolean };
  camera: { fov: number };
}

/** 写入用补丁（逐段合并，缺省字段保持原值）。 */
export interface RenderPrefsPatch {
  lighting?: Partial<RenderLightingPrefs>;
  textureQuality?: TextureQualityPref;
  culling?: Partial<RenderPrefs['culling']>;
  camera?: Partial<RenderPrefs['camera']>;
}

/** 相机 FOV 默认值（度）：三端现状一致（`apps/game/src/config.ts` 的 `hud.fov`、debug/viewer 的常量都是 73.6）。 */
export const RENDER_DEFAULT_FOV = 73.6;

/** 剔除距离默认值：0 = 自动（`maxDim × 0.5`，与 game `hud.renderDistance` 同义）；P4 消费。 */
export const RENDER_DEFAULT_CULL_DISTANCE = 0;

/** PVS 剔除默认值：三端现状均为关（game `ENABLE_PVS = false`）；P4 消费。 */
export const RENDER_DEFAULT_PVS = false;

/** 共享层默认档（唯一来源是 `LIGHTING_PRESENTATION_DEFAULTS`，本函数只补 mode 与其余档位）。 */
export function defaultRenderPrefs(): RenderPrefs {
  return {
    version: RENDER_PREFS_VERSION,
    lighting: { ...LIGHTING_PRESENTATION_DEFAULTS, mode: 'baked' },
    textureQuality: 'original',
    culling: { distance: RENDER_DEFAULT_CULL_DISTANCE, pvs: RENDER_DEFAULT_PVS },
    camera: { fov: RENDER_DEFAULT_FOV },
  };
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const quality = (v: unknown, fallback: TextureQualityPref): TextureQualityPref =>
  v === 'original' || v === 'mini' ? v : fallback;

/** 把任意来源（localStorage 存档 / 旧键）归一到合法结构：缺项与类型不符一律回落默认值。 */
function normalize(raw: unknown): RenderPrefs {
  const d = defaultRenderPrefs();
  const o = (raw ?? {}) as Record<string, unknown>;
  const l = (o.lighting ?? {}) as Record<string, unknown>;
  const c = (o.culling ?? {}) as Record<string, unknown>;
  const cam = (o.camera ?? {}) as Record<string, unknown>;
  return {
    version: RENDER_PREFS_VERSION,
    lighting: {
      exposure: num(l.exposure, d.lighting.exposure),
      lightGamma: num(l.lightGamma, d.lighting.lightGamma),
      ambientScale: num(l.ambientScale, d.lighting.ambientScale),
      propVertexRelax: num(l.propVertexRelax, d.lighting.propVertexRelax),
      propVertexFlatten: num(l.propVertexFlatten, d.lighting.propVertexFlatten),
      mode: l.mode === 'texture' ? 'texture' : 'baked',
    },
    textureQuality: quality(o.textureQuality, d.textureQuality),
    culling: { distance: num(c.distance, d.culling.distance), pvs: c.pvs === true },
    camera: { fov: num(cam.fov, d.camera.fov) },
  };
}

function readRaw(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch (err) {
    console.warn('[render-prefs] 读取 ' + key + ' 失败:', err);
    return null;
  }
}

function writeRaw(p: RenderPrefs): void {
  try {
    localStorage.setItem(renderPrefsKey(), JSON.stringify(p));
  } catch (err) {
    console.warn('[render-prefs] 保存失败:', err);
  }
}

/**
 * `ambientScale === 0` 复位：0 本身是合法的滑块位置，但 2026-10-16 的事故是**旧共用档里被置 0**
 * 之后传染三端（prop 全黑）。迁移是「搬别人写的值」的唯一时机 ⇒ 只在迁移这一步修这一个已知污染值；
 * 用户此后仍可在面板上手动调到 0。
 */
function repairPoisonedLighting(p: RenderPrefs): { prefs: RenderPrefs; repaired: boolean } {
  if (p.lighting.ambientScale !== 0) return { prefs: p, repaired: false };
  return {
    prefs: { ...p, lighting: { ...p.lighting, ambientScale: defaultRenderPrefs().lighting.ambientScale } },
    repaired: true,
  };
}

/** 旧档迁移（**只有 game 作用域会真的搬**）：旧共用键 → 面板旧档 `vbsp:panelPrefs` → null（默认档）。 */
function migrateLegacy(): RenderPrefs | null {
  if (renderPrefsScope() !== 'game') return null;
  const shared = readRaw(LEGACY_RENDER_PREFS_KEY) as Record<string, unknown> | null;
  if (shared && shared.version === RENDER_PREFS_VERSION) {
    const { prefs, repaired } = repairPoisonedLighting(normalize(shared));
    writeRaw(prefs);
    console.info(
      '[render-prefs] 已把旧共用键 ' + LEGACY_RENDER_PREFS_KEY + ' 迁移到 ' + renderPrefsKey() +
        (repaired ? '（ambientScale=0 判为污染，已复位 ' + prefs.lighting.ambientScale + '）' : ''),
    );
    return prefs;
  }
  return migrateGamePanelPrefs();
}

/** game 面板旧档里语义相同的字段：lighting / hud.fov / hud.renderDistance / texture.quality。 */
function migrateGamePanelPrefs(): RenderPrefs | null {
  const panel = readRaw(LEGACY_PREFS_KEYS[0]) as Record<string, unknown> | null;
  if (!panel) return null;
  const base = defaultRenderPrefs();
  let touched = false;
  const section = (o: Record<string, unknown> | null, name: string): Record<string, unknown> => {
    const s = o && o[name];
    return s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
  };
  const panelLighting = section(panel, 'lighting');
  if (Object.keys(panelLighting).length) {
    base.lighting = normalize({ lighting: panelLighting }).lighting;
    touched = true;
  }
  const panelHud = section(panel, 'hud');
  if (panelHud.fov !== undefined) {
    base.camera.fov = num(panelHud.fov, base.camera.fov);
    touched = true;
  }
  if (panelHud.renderDistance !== undefined) {
    base.culling.distance = num(panelHud.renderDistance, base.culling.distance);
    touched = true;
  }
  const panelTexture = section(panel, 'texture');
  if (panelTexture.quality !== undefined) {
    base.textureQuality = quality(panelTexture.quality, base.textureQuality);
    touched = true;
  }
  if (!touched) return null;
  const { prefs, repaired } = repairPoisonedLighting(base);
  writeRaw(prefs);
  console.info(
    '[render-prefs] 已从 ' + LEGACY_PREFS_KEYS[0] + ' 迁移呈现档到 ' + renderPrefsKey() +
      (repaired ? '（ambientScale=0 判为污染，已复位 ' + prefs.lighting.ambientScale + '）' : ''),
  );
  return prefs;
}

function loadStored(): RenderPrefs {
  const raw = readRaw(renderPrefsKey()) as Record<string, unknown> | null;
  if (raw && raw.version === RENDER_PREFS_VERSION) return normalize(raw);
  if (raw) console.warn('[render-prefs] 存档版本 ' + String(raw.version) + ' ≠ ' + RENDER_PREFS_VERSION + '，改用默认档');
  return migrateLegacy() ?? defaultRenderPrefs();
}

/** 深链覆盖的查询参数名：`?prefs=default` 或 `?prefs=<base64(JSON)>`（D1=A）。 */
export const RENDER_PREFS_QUERY = 'prefs';

/** 取档来源（诊断行与三端一致性门禁据此判断覆盖是否真的生效）。 */
let deepLinkActive = false;

/** base64（标准与 URL 安全两种字符集都收）→ UTF-8 文本。 */
function decodeBase64(b64: string): string {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * 深链覆盖：`?prefs=default` 强制默认档；`?prefs=<base64(JSON)>` 强制指定档（经 `normalize` 归一）。
 *
 * 优先级**高于 localStorage，且不落盘**（只在取档时生效）；解析失败时告警并回落存档档。
 * 用途：三端档现已按端隔离（互不影响）⇒ 需要「三端同画面」做 A/B 或验收时，用深链把同一份档
 * 同时喂给三端（`?prefs=default` 或 `?prefs=<base64(JSON)>`），比对各自控制台的生效行 `fp=`。
 */
function deepLinkPrefs(): RenderPrefs | null {
  if (typeof location === 'undefined' || typeof atob !== 'function') return null;
  let raw: string | null = null;
  try { raw = new URLSearchParams(location.search).get(RENDER_PREFS_QUERY); } catch { return null; }
  if (!raw) return null;
  if (raw === 'default') { deepLinkActive = true; return defaultRenderPrefs(); }
  try {
    const p = normalize(JSON.parse(decodeBase64(raw)) as unknown);
    deepLinkActive = true;
    return p;
  } catch (err) {
    console.warn('[render-prefs] ?' + RENDER_PREFS_QUERY + '= 解析失败，忽略深链覆盖:', err);
    return null;
  }
}

/** 取生效档：深链覆盖优先，其次存档档。 */
function load(): RenderPrefs {
  return deepLinkPrefs() ?? loadStored();
}

/**
 * 档指纹：四段生效值归一后的 FNV-1a 32 位短哈希（8 位十六进制，三端同格式）。
 *
 * 同档必同指纹、任一项不同必不同 ⇒ 判据可以「比指纹」而不必逐字段比（`describeRenderPrefs` 的
 * `fp=` 与三端一致性探针都读它）。不进 localStorage、不参与 `version`。
 */
export function renderPrefsFingerprint(p: RenderPrefs): string {
  const key = JSON.stringify([
    p.lighting.exposure, p.lighting.lightGamma, p.lighting.ambientScale,
    p.lighting.propVertexRelax, p.lighting.propVertexFlatten, p.lighting.mode,
    p.textureQuality,
    p.culling.distance, p.culling.pvs,
    p.camera.fov,
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

let logged = false;

/**
 * 读生效档。首次调用会打一行三端**逐字相同**的生效值（页面级一次，用于判据比对）。
 * 注意：读是纯函数式的（不做隐式落盘）；落盘只发生在 `writeRenderPrefs` 与旧键迁移。
 */
export function readRenderPrefs(): RenderPrefs {
  const p = load();
  if (!logged) {
    logged = true;
    console.info(describeRenderPrefs(p));
  }
  const g = globalThis as { __vbspRenderPrefsFp?: string; __vbspRenderPrefsSource?: string };
  g.__vbspRenderPrefsFp = renderPrefsFingerprint(p);
  g.__vbspRenderPrefsSource = deepLinkActive ? 'deep-link' : 'storage';
  return p;
}

/** 写入（逐段合并）并返回落盘后的完整档；调用方只有代表用户写入的那一端（game 面板 / debug 画质档）。 */
export function writeRenderPrefs(patch: RenderPrefsPatch): RenderPrefs {
  const cur = loadStored(); // 深链覆盖不落盘：写入一律以存档档为基准
  const next = normalize({
    ...cur,
    ...patch,
    lighting: { ...cur.lighting, ...(patch.lighting ?? {}) },
    culling: { ...cur.culling, ...(patch.culling ?? {}) },
    camera: { ...cur.camera, ...(patch.camera ?? {}) },
  });
  writeRaw(next);
  return next;
}

/** 把档里的静态光照项施加到共享着色器（三端 init 的唯一调用点）。 */
export function applyRenderPrefs(p: RenderPrefs): void {
  applyLightingPresentation(p.lighting);
  setLightingMode(p.lighting.mode);
}

/** 生效值的单行描述（三端同格式；判据直接比对这一行）。 */
export function describeRenderPrefs(p: RenderPrefs): string {
  const l = p.lighting;
  return (
    '[render-prefs] 生效：exposure=' +
    l.exposure +
    ' lightGamma=' +
    l.lightGamma +
    ' ambientScale=' +
    l.ambientScale +
    ' propVertexRelax=' +
    l.propVertexRelax +
    ' propVertexFlatten=' +
    l.propVertexFlatten +
    ' mode=' +
    l.mode +
    ' quality=' +
    p.textureQuality +
    ' fov=' +
    p.camera.fov +
    ' cull=' +
    p.culling.distance +
    '（0=自动） pvs=' +
    (p.culling.pvs ? 'on' : 'off') +
    ' fp=' +
    renderPrefsFingerprint(p) +
    ' source=' +
    (deepLinkActive ? 'deep-link' : 'storage') +
    ' scope=' +
    renderPrefsScope()
  );
}

/**
 * 字段级施加静态光照项（缺省字段不动）：**不读档、不落盘**，值来源由调用方决定。
 *
 * 与 `applyRenderPrefs` 的分工：整档（含光照模式）由它施加；本函数是两个字段级调用方的共享入口——
 * ① 各端初始化把配置对象里的现值写进共享 uniform（值仍是各自的 `config.lighting`）；
 * ② 面板滑块单点改写（每次只动一个字段），不因拖动而反复解析 localStorage 存档。
 */
export function applyLightingPresentation(patch: Partial<RenderLightingPrefs>): void {
  if (patch.exposure !== undefined) setExposure(patch.exposure);
  if (patch.lightGamma !== undefined) setLightGamma(patch.lightGamma);
  if (patch.ambientScale !== undefined) setAmbientScale(patch.ambientScale);
  if (patch.propVertexRelax !== undefined) setPropVertexRelax(patch.propVertexRelax);
  if (patch.propVertexFlatten !== undefined) setPropVertexFlatten(patch.propVertexFlatten);
}
