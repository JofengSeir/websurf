/**
 * 三端渲染面板的**唯一控件规格表**（T-686）。
 *
 * 为什么有这一层：三端要接的面板项高度重叠（debug 全功能 / viewer 画面相关全接 / game 精简），
 * 若各自手写一份 HTML + 绑定点，就会出现「同项不同量程、同项不同默认、改一处漏两处」。
 * 本表只描述**控件是什么**（分组 / 类型 / 量程 / 落到哪个档位或哪个 globalThis 键 / 生效方式 /
 * 哪些端要显示），渲染与绑定由各端自己的 DOM 风格完成（见 `render-panel-ui.ts` 的通用构建器）。
 *
 * 生效方式（`apply`）是**读实现得出**的硬事实，不是设计愿望：
 *   - `live`    ：改完即时可见（走 uniform 或共享 setter）；
 *   - `reload`  ：在材质编译/着色器注入期读一次（如 `__vbspDebugAlbedoOnly`、`textureQuality`）；
 *   - `rebuild` ：在地图加载期烘焙进几何/属性（如 `propVertexRelax`、`propCubeGain`、`bumpStrength`）。
 *
 * 落档规则：有 `pref` 的项写进**本端**的渲染档（键 `vbsp:renderPrefs:<端>`，T-685 起按端隔离）；
 * 只有 `global` 的项（「排查开关」组）**不落档**、刷新即复位——它们是出帧/排查用的一次性开关。
 */
import type { LightmapStage } from '../shader/lightmap-shader.js';

/** 三端标识（与 `render-prefs.ts` 的作用域一致）。 */
export type RenderPanelApp = 'debug' | 'viewer' | 'game';

/** 生效方式：即时 / 需刷新页面 / 需重新加载地图。 */
export type RenderPanelApply = 'live' | 'reload' | 'rebuild';

/** 控件类型。 */
export type RenderPanelKind = 'slider' | 'toggle' | 'select' | 'text';

/** 面板分组（顺序即渲染顺序）。 */
export const RENDER_PANEL_GROUPS = ['光照', '材质与法线', '剔除与相机', '雾', '排查开关'] as const;
export type RenderPanelGroup = (typeof RENDER_PANEL_GROUPS)[number];

export interface RenderPanelItem {
  /** 稳定 id（DOM 元素 id 后缀；同一端内唯一）。 */
  id: string;
  label: string;
  /** 悬停提示：说清这项在改什么、什么代价。 */
  title: string;
  group: RenderPanelGroup;
  kind: RenderPanelKind;
  /** slider 用：量程与步进。 */
  min?: number;
  max?: number;
  step?: number;
  /** select 用。 */
  options?: readonly { value: string; label: string }[];
  /** 落到渲染档的路径（`lighting.exposure` / `extras.lightFloor` …）；与 `global` 二选一。 */
  pref?: string;
  /** 落到 globalThis 的键（`__vbspLightFloor` …）；不落档。 */
  global?: string;
  apply: RenderPanelApply;
  /** 哪些端显示这一项。 */
  apps: readonly RenderPanelApp[];
  /** 仅 toggle 用：globalThis 未设置时的默认是否为「开」（如 __vbspOutputGamma22 缺省即开）。 */
  defaultOn?: boolean;
  /** 读数单位后缀（debug/game 落在读数位、viewer 跟在数字框后）；无单位留空。 */
  unit?: string;
  /** 额外说明（UI 上以小字显示；例如「debug 需重新加载地图」）。 */
  note?: string;
}

const ALL: readonly RenderPanelApp[] = ['debug', 'viewer', 'game'];
const D: readonly RenderPanelApp[] = ['debug'];

/** 排查开关组的统一说明。 */
const SWITCH_NOTE = '已随 debug 本端档保存（刷新后仍是这个值）；材质编译时读取 ⇒ 改完需重新加载地图';

export const RENDER_PANEL_SPEC: readonly RenderPanelItem[] = [
  // ── 光照 ────────────────────────────────────────────────────────────────
  {
    id: 'mode',
    label: '光照模式',
    title: '预烘焙 = 每像素采 lightmap + 逐顶点/ambient cube 烘焙光照；纯纹理 = 只上漫反射贴图（每帧开销最小）',
    group: '光照',
    kind: 'select',
    options: [
      { value: 'baked', label: '预烘焙' },
      { value: 'texture', label: '纯纹理' },
    ],
    pref: 'lighting.mode',
    apply: 'live',
    // 只有 viewer 从这里生成控件：debug 的「光照模式」单选与 game 的光照模式组已手写，重复会造成同项两控
    apps: ['viewer'],
  },
  {
    id: 'exposure',
    label: '亮度（曝光）',
    title: '整体曝光（所有材质共享的 uniform），面板改动即时生效',
    group: '光照',
    kind: 'slider',
    min: 0.02,
    max: 40,
    step: 0.01,
    pref: 'lighting.exposure',
    apply: 'live',
    // game 面板已有同名控件（走它自己的 config 写档 + setter），面板里不再重复
    apps: ['debug', 'viewer'],
  },
  {
    id: 'lightGamma',
    label: '暗部提升（γ）',
    title: '光照项 gamma（shadow-lift）：1 = 不修正；>1 抬高暗部（与早期 (0,1] 语义相反）',
    group: '光照',
    kind: 'slider',
    min: 0.1,
    max: 8,
    step: 0.01,
    pref: 'lighting.lightGamma',
    apply: 'live',
    // game 面板已有同名控件（走它自己的 config 写档 + setter），面板里不再重复
    apps: ['debug', 'viewer'],
  },
  {
    id: 'ambientScale',
    label: '模型光照',
    title: 'prop 第 2 级（leaf ambient cube）的亮度倍率；0 = 关掉这一级（模型会明显变暗）',
    group: '光照',
    kind: 'slider',
    min: 0,
    max: 10,
    step: 0.01,
    pref: 'lighting.ambientScale',
    apply: 'live',
    // game 面板已有同名控件（走它自己的 config 写档 + setter），面板里不再重复
    apps: ['debug', 'viewer'],
  },
  {
    id: 'lightFloor',
    label: '暗部下限',
    title: '光照下限（0 = 关闭）：把「全黑面」抬到该下限，避免纯黑',
    group: '光照',
    kind: 'slider',
    min: 0,
    max: 2,
    step: 0.01,
    pref: 'extras.lightFloor',
    apply: 'live',
    apps: ALL,
  },
  {
    id: 'propVertexRelax',
    label: 'prop 顶点平滑',
    title: '第 1 级逐顶点光照的重建平滑次数（0 = 最忠于烘焙值）',
    group: '光照',
    kind: 'slider',
    min: 0,
    max: 8,
    step: 1,
    pref: 'lighting.propVertexRelax',
    apply: 'rebuild',
    apps: ALL,
    note: '需重新加载地图',
  },
  {
    id: 'propVertexFlatten',
    label: 'prop 顶点压平',
    title: '第 1 级逐顶点光照的方差压缩（1 = 完全抹平梯度，均值不变）',
    group: '光照',
    kind: 'slider',
    min: 0,
    max: 1,
    step: 0.05,
    pref: 'lighting.propVertexFlatten',
    apply: 'rebuild',
    apps: ALL,
    note: '需重新加载地图',
  },
  {
    id: 'propCubeGain',
    label: 'cube 增益',
    title: '第 2 级 ambient cube 的数据侧增益（默认 2.44，对齐外部参照实现）',
    group: '光照',
    kind: 'slider',
    min: 0,
    max: 16,
    step: 0.01,
    pref: 'extras.propCubeGain',
    apply: 'rebuild',
    apps: ALL,
    note: '需重新加载地图',
  },
  // ── 材质与法线 ──────────────────────────────────────────────────────────
  {
    id: 'textureQuality',
    label: '画质档',
    title: 'original = 原图；mini = mosaic 低清图集（省显存与带宽，观感下降）',
    group: '材质与法线',
    kind: 'select',
    options: [
      { value: 'original', label: '原图' },
      { value: 'mini', label: '低清（mosaic）' },
    ],
    pref: 'textureQuality',
    apply: 'rebuild',
    // 同上：debug「纹理画质」单选、game「画质档」已手写
    apps: ['viewer'],
    note: '需重新加载地图',
  },
  {
    id: 'bumpStrength',
    label: '法线强度',
    title: '法线贴图的扰动强度（默认 0.35）；调大凹凸更明显、反射更散',
    group: '材质与法线',
    kind: 'slider',
    min: 0,
    max: 4,
    step: 0.01,
    pref: 'extras.bumpStrength',
    apply: 'rebuild',
    apps: ALL,
    note: '需重新加载地图',
  },
  {
    id: 'bumpDetail',
    label: '法线细节',
    title: '细节通道强度（默认 0.6；0 = 关掉细节通道，只留反射扰动）',
    group: '材质与法线',
    kind: 'slider',
    min: 0,
    max: 3,
    step: 0.01,
    pref: 'extras.bumpDetail',
    apply: 'rebuild',
    apps: ALL,
    note: '需重新加载地图',
  },
  // ── 剔除与相机 ──────────────────────────────────────────────────────────
  {
    id: 'cullDistance',
    label: '渲染距离',
    title: '0 = 自动（地图包围盒对角线的一半）；单位 ≈ 1 英寸。超出的空间块不渲染',
    group: '剔除与相机',
    kind: 'slider',
    min: 0,
    max: 200000,
    step: 100,
    pref: 'culling.distance',
    unit: 'HU',
    apply: 'live',
    // 同上：debug「视距上限」、game「渲染距离」已手写
    apps: ['viewer'],
  },
  {
    id: 'pvs',
    label: 'PVS 剔除',
    title: '按可见性表剔除空间块（省 draw call，可能看到弹出）',
    group: '剔除与相机',
    kind: 'toggle',
    pref: 'culling.pvs',
    apply: 'live',
    apps: ALL,
    note: 'debug：重新加载地图后生效',
  },
  {
    id: 'fov',
    label: '视野 FOV',
    title: '相机视场角（度）',
    group: '剔除与相机',
    kind: 'slider',
    min: 20,
    max: 150,
    step: 0.1,
    pref: 'camera.fov',
    unit: '°',
    apply: 'live',
    // game 面板已有「视野 FOV」，不重复
    apps: ['debug', 'viewer'],
  },
  {
    id: 'nearPlaneScale',
    label: '近裁面缩放',
    title: '自动近裁面（maxDim/1000）的缩放系数：调小可减轻近处穿插，调大更省深度精度',
    group: '剔除与相机',
    kind: 'slider',
    min: 0.02,
    max: 8,
    step: 0.01,
    pref: 'extras.nearPlaneScale',
    unit: '×',
    apply: 'live',
    // debug 与 game 各自有「探测距离 + 收缩系数」两项（setNearParams 体系）；只有 viewer 没有近裁面控件
    apps: ['viewer'],
  },
  // ── 雾 ──────────────────────────────────────────────────────────────────
  {
    id: 'fogMaxDensity',
    label: '雾最大密度',
    title: '地图线性雾的密度上限（0 = 不限制，按实体值）',
    group: '雾',
    kind: 'slider',
    min: 0,
    max: 1,
    step: 0.01,
    pref: 'extras.fogMaxDensity',
    apply: 'live',
    apps: ALL,
  },
  // ── 排查开关（只有 debug；不落档）────────────────────────────────────────
  {
    id: 'swLightmapStage',
    label: '光照阶段对照',
    title: '强制光照注入的某个阶段（auto = 正常路径）',
    group: '排查开关',
    kind: 'select',
    options: (
      [
        ['auto', 'auto（正常）'],
        ['off', '关闭注入'],
        ['broken', '故意打破（负控）'],
        ['native', '原生 lightMap'],
        ['channel0', '通道 0'],
        ['channel1', '通道 1'],
        ['noinject', '不注入'],
      ] as readonly [LightmapStage, string][]
    ).map(([value, label]) => ({ value, label })),
    pref: 'debug.lightmapStage',
    apply: 'reload',
    apps: D,
    note: SWITCH_NOTE,
  },
  {
    id: 'swOutputGamma22',
    label: '输出端 γ2.2',
    title: '关掉 = 保留 three 的分段 sRGB（A/B 用）',
    group: '排查开关',
    kind: 'toggle',
    pref: 'debug.outputGamma22',
    apply: 'reload',
    defaultOn: true,
    apps: D,
    note: SWITCH_NOTE,
  },
  {
    id: 'swVertexLightingOff',
    label: '关第 1 级顶点光照',
    title: '所有 prop 改走第 2 级 ambient cube、忽略 sp_<i>.vhv（单变量对照）',
    group: '排查开关',
    kind: 'toggle',
    pref: 'debug.vertexLightingOff',
    apply: 'rebuild',
    apps: D,
    note: SWITCH_NOTE,
  },
  {
    id: 'swBumpOff',
    label: '关法线注入',
    title: '不注入法线扰动（A/B 用）',
    group: '排查开关',
    kind: 'toggle',
    pref: 'debug.bumpOff',
    apply: 'reload',
    apps: D,
    note: SWITCH_NOTE,
  },
  {
    id: 'swWorldTransitionOff',
    label: '关世界过渡',
    title: '不注入世界过渡（$basetexture2）着色器',
    group: '排查开关',
    kind: 'toggle',
    pref: 'debug.worldTransitionOff',
    apply: 'reload',
    apps: D,
    note: SWITCH_NOTE,
  },
  {
    id: 'swEnvMapAll',
    label: '强制全部反射',
    title: '给所有材质加 $envmap 反射（排查反射路径用）',
    group: '排查开关',
    kind: 'toggle',
    pref: 'debug.envMapAll',
    apply: 'reload',
    apps: D,
    note: SWITCH_NOTE,
  },
  {
    id: 'swDebugAlbedoOnly',
    label: '只看 albedo',
    title: '只输出贴图原色，不施加 lightmap',
    group: '排查开关',
    kind: 'toggle',
    pref: 'debug.albedoOnly',
    apply: 'reload',
    apps: D,
    note: SWITCH_NOTE,
  },
  {
    id: 'swDebugLightmapOnly',
    label: '只看 lightmap',
    title: '只输出 lightmap 项，去掉 albedo',
    group: '排查开关',
    kind: 'toggle',
    pref: 'debug.lightmapOnly',
    apply: 'reload',
    apps: D,
    note: SWITCH_NOTE,
  },
  {
    id: 'swDebugTexLinear',
    label: '贴图按线性读',
    title: '把 albedo 贴图当线性数据（排查双重 sRGB 解码造成的暗部压低）',
    group: '排查开关',
    kind: 'toggle',
    pref: 'debug.texLinear',
    apply: 'reload',
    apps: D,
    note: SWITCH_NOTE,
  },
  {
    id: 'swFullbrightNames',
    label: '全亮材质名',
    title: '逗号分隔的材质名：这些材质走无光照路径（排查用）',
    group: '排查开关',
    kind: 'text',
    pref: 'debug.fullbrightNames',
    apply: 'reload',
    apps: D,
    note: SWITCH_NOTE,
  },
];

/** 某端要显示的项（按表内顺序）。 */
export function panelItemsFor(app: RenderPanelApp): readonly RenderPanelItem[] {
  return RENDER_PANEL_SPEC.filter((i) => i.apps.includes(app));
}

/** 某端要显示的分组（空组不返回）。 */
export function panelGroupsFor(app: RenderPanelApp): readonly RenderPanelGroup[] {
  return RENDER_PANEL_GROUPS.filter((g) => RENDER_PANEL_SPEC.some((i) => i.group === g && i.apps.includes(app)));
}
