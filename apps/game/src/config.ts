/**
 * 运行时配置（最小化版）— 物理参数经 config 消息 → Worker-A → wasm set_params/set_hull。
 */

import { buildPhysicsParams as sharedBuildPhysicsParams } from '../../../src/ts-shared/phys/params.js';

export interface PhysicsConfig {
  /** 物理模式：physics（权威物理）/ noclip（自由视角，禁物理/传送）。 */
  mode: 'physics' | 'noclip';
  /** 物理模拟频率（Hz，默认 64；面板 48-128 可调，Worker-A/B 步长联动）。 */
  tickRate: number;
  gravity: number;
  jumpSpeed: number;
  maxSpeed: number;
  friction: number;
  accelerate: number;
  airAccel: number;
  stopSpeed: number;
  autobhop: boolean;
  /** 走路速度（HU/s，默认 130）。 */
  walkSpeed: number;
  /** 蹲走速度（HU/s，默认 85）。 */
  crouchSpeed: number;
  /** bhop 速度钳制（连跳不超 maxSpeed，默认 false = 不限速，可无限加速）。 */
  bhopSpeedClamp: boolean;
  /** 传送触发落地稳定门槛（帧，默认 3）：落地持续 >= 该值才判定位于传送平面。 */
  teleportGateTicks: number;
}

export interface InputConfig {
  sensitivity: number;
  pitchLimit: number;
  /** Q/E 键 yaw 旋转速度（度/秒，turn bind）。 */
  yawBindSpeed: number;
  /** noclip 自由视角移动速度（HU/s）。 */
  noclipSpeed: number;
}

export interface PlayerConfig {
  halfWidth: number;
  standHeight: number;
  duckHeight: number;
}

/** 准星风格化配置（面板可调，localStorage 持久化）。 */
export interface CrosshairConfig {
  /** 准星颜色（CSS hex）。 */
  color: string;
  /** 线条长度（px）。 */
  size: number;
  /** 线条粗细（px）。 */
  thickness: number;
  /** 中心间隙（px）。 */
  gap: number;
  /** 黑色描边（深色背景下更清晰）。 */
  outline: boolean;
  /** 中心点。 */
  dot: boolean;
}

export interface HudConfig {
  showCrosshair: boolean;
  /** 速度面板模式：'lateral' 横向 / 'lateral-vertical' 横+竖 / 'total' 综合。 */
  speedMode: 'lateral' | 'lateral-vertical' | 'total';
  /** 准星风格（见 CrosshairConfig）。 */
  crosshair: CrosshairConfig;
  /** 视野角 FOV（度，默认 73.6；面板 60-110 可调）。 */
  fov: number;
  /**
   * 渲染距离（世界单位，≈1 英寸）：超过该距离的空间块在 LOD 遍历里隐藏（不产生 draw call）。
   * `0` = 自动（= 地图包围盒对角线的一半，即改造前行为）；面板 0~60000 可调。
   */
  renderDistance: number;
}

/** 纹理画质配置（mosaic 共享模块，运行时切换贴图，无需重载地图）。 */
export interface TextureConfig {
  /** original = 原始纹理（VTF 解码）；mini = mosaic 压缩低清纹理（×8 最近邻）。 */
  quality: 'original' | 'mini';
}

/** 光照显示配置（**仅显示侧**，不改烘焙数据）。 */
export interface LightingConfig {
  /**
   * 全局曝光（显示侧亮度倍率，world lightmap 与 prop ambient 共用同一旋钮）。
   * **1.0 = 忠于 BSP 烘焙数据**（surf_666 本身就是暗图）；面板 1~3 可调。
   * >3 起 p90 亮面在中灰贴图下开始削顶（见 `scene-brightness-and-lights.md` §4.2）。
   */
  exposure: number;
  /**
   * 光照项 gamma（shadow-lift）：对解码后的**线性辐射度**做 `pow(d, γ)`。
   * 1.0 = 不修正；**0.85 = 对齐外部参照实现的 γ2.2 域乘算口径（残差 <10%）**。
   * 只抬暗部、亮部（d→1）几乎不动 ⇒ 与曝光不同，它不会削顶。
   * 属**管线口径常量**而非用户亮度设置，故不进面板。见 `scene-brightness-and-lights.md` §7.4。
   */
  lightGamma: number;
  /**
   * 模型（prop）烘焙光照亮度倍率：**只作用于 ambient cube 路径**（static prop 的静态照明），
   * 与 world lightmap 的曝光/γ 相互独立。1.0 = 忠于数据；0 = 模型全黑（A/B 用）。
   */
  ambientScale: number;
  /**
   * 第 1 级逐顶点预烘焙光照的**重建平滑**（只作用于几何侧重建，不改 pakfile 里的烘焙值）。
   *
   * 为什么需要：`s1_ramp1b` 这类「少面大平面」模型（2560×1196 的坡只有 50~66 个三角形，
   * 最长边 p50 = **747**、max 1473 HU），烘焙值只在 238 个顶点上采样，再用 Gouraud 线性
   * 插值铺满整块面 ⇒ 相邻三角形的插值在公共边只有 C0 连续，观感就是"一块一块的色阶"。
   * 实测（`temp/ramp-tri-scale.py`）：小三角形（≤163 HU）内 Δluma 只有 0.035（场本身是平滑的），
   * 大三角形内 0.283~0.384 —— **分块来自重建方式，不是烘焙数据错位**（错位已用
   * 位置/法线自洽、移位/置换搜索、VVD fixup 三路反证排除）。
   *
   * 0 = 原样使用（最忠于数据）；1 = 接缝焊接 + 1 次 Laplacian 松弛（默认，去掉可见分块）；
   * 2~3 = 更平滑。数值为**松弛次数**。
   */
  propVertexRelax: number;
  /**
   * 第 1 级逐顶点光照的**方差压缩**（0..1）：`v ← mean + (1-flatten)·(v-mean)`，均值严格不变。
   *
   * 依据（2026-09-20 与游戏内实拍同靶标的像素量测，`scene-brightness-and-lights.md` §11）：
   * 坡面**均值已经吻合**（我们 `#5c493e` / 亮度 77.6，游戏实拍 `#5b4e40` / 亮度 80），
   * 但**方差差一个量级**（我们 p10..p90 = 26..123，游戏实拍点仅 74..82）——观感即"一块一块的色阶"。
   * 0 = 保留烘焙方差；**0.85 = 压到实拍量级**（保留 15% 结构，避免整片死平）；1 = 该 prop 均匀受光。
   */
  propVertexFlatten: number;
  /**
   * 光照模式（面板「预烘焙 / 纯纹理」）：
   *
   * | 值 | 含义 | 代价 |
   * |---|---|---|
   * | `baked`（默认） | **预烘焙**：世界面吃 lightmap atlas（VRAD 烘焙），prop 吃 `sp_<i>.vhv` 逐顶点烘焙 / leaf ambient cube | **纹理多**（atlas + 默认纹理包 + vhv 顶点属性）⇒ 进图与首帧材质编译更吃时间，会卡顿一下 |
   * | `texture` | **纯纹理**：只上漫反射贴图原色（`MeshBasicMaterial`），不解码 atlas、不吃任何烘焙光照 | 纹理最少、进图最快；画面没有明暗关系 |
   *
   * 切换由面板发起（`renderer.setLightingMode`）：实现上按新模式**重建场景**（材质必须在分块合并
   * 之前施加），代价与重新加载地图相当。
   */
  mode: 'baked' | 'texture';
}

export interface RuntimeConfig {
  /**
   * 锁定 tick 频率（V8/P2 公平性）：true = 锁定 64Hz 只读（计时玩法）；
   * false = 调试构建，面板 48-128 可调。切换后需 reload。
   */
  lockTickRate: boolean;
  physics: PhysicsConfig;
  input: InputConfig;
  player: PlayerConfig;
  hud: HudConfig;
  texture: TextureConfig;
  lighting: LightingConfig;
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  // 调试期 false（面板可调）；上计时玩法前置 true 锁定 64Hz
  lockTickRate: false,
  physics: {
    mode: 'physics',
    tickRate: 64,
    gravity: 800,
    jumpSpeed: 302,
    maxSpeed: 250,
    friction: 4,
    accelerate: 10,
    airAccel: 150,
    stopSpeed: 100,
    autobhop: true,
    walkSpeed: 130,
    crouchSpeed: 85,
    bhopSpeedClamp: false,
    teleportGateTicks: 3,
  },
  input: {
    sensitivity: 1.5,
    pitchLimit: 89,
    yawBindSpeed: 210,
    noclipSpeed: 800,
  },
  player: {
    halfWidth: 16,
    standHeight: 72,
    duckHeight: 54,
  },
  hud: {
    showCrosshair: true,
    speedMode: 'lateral',
    fov: 73.6,
    renderDistance: 0,
    crosshair: {
      color: '#4ade80',
      size: 6,
      thickness: 2,
      gap: 4,
      outline: true,
      dot: false,
    },
  },
  texture: {
    quality: 'original',
  },
  lighting: {
    // ── 外部参照实现平价默认值（2026-09-20 定案：全部亮度旋钮回到参照实现的默认）──
    //
    // 参照实现是外部参照实现（`documents/game/implementation/lightmap-merge-plan.md` 的既定口径），
    // 它的两条路径原文：
    //
    // | 路径 | 原文 | 位置 |
    // |---|---|---|
    // | world | `return inColor * pow(sample, vec3(1.0/2.2));` | `Shaders/LightmappedBase.ts:66` |
    // | prop | `linearToScreenGamma(cube)` = `255*cube^(1/2.2)` 打包进顶点色，再由 `vVertexLighting = floor(enc) * (2.0/255.0)` 还原 = **`2 × cube^(1/2.2)`** | `StudioModel.ts:96-98` + `Shaders/VertexLitGeneric.ts` |
    //
    // 本工程的等价式：屏幕值 = `albedo_srgb × 光照项^(1/2.2)`
    // （`(albedo_linear × lightitem)^(1/2.2)`：albedo→linear 由 three 的 sRGB 解码给，
    //  末端 `^(1/2.2)` 由我们把 `colorspace_fragment` 换成纯 γ2.2 编码给，
    //  乘算来自 `three.module.js:14034` meshbasic fragment 的
    //  `reflectedLight.indirectDiffuse *= diffuseColor.rgb;`）。
    //
    // ⇒ 令屏幕值与外部参照实现逐项相等，**光照项**应为：
    // - world：`lightitem = luxel` ⇒ **曝光 1、γ 1**（本工程 shader 是 `pow(L, 1/γ) × 曝光`）
    // - prop ：`lightitem = 2^2.2 × cube = 4.5948 × cube` ⇒ 由 `PROP_CUBE_GAIN` 承担；
    //   三个旋钮（曝光/γ/模型光照）在默认 1 时不再额外改变量级
    //
    // ⚠️ 之前几轮的 12 / 2.3 都是"看着调"的结果，不是参照实现的默认值，已全部作废。
    // 量级参考（`npm run test:lightmap-atlas-stats` 实测图集在用 texel）：
    // p25 0.0177 / p50 0.0440 / p75 0.0860 / p90 0.1747 ⇒ 世界面屏幕倍率 `luxel^(1/2.2)`
    // = 0.18 / 0.24 / 0.33 / 0.45；prop 侧 `2 × cube^(1/2.2)` 在 cube p50 = 0.0107 时 = 0.25
    // ⇒ **两条路径同量级**（这正是那个 2× 的来历，也是本工程 prop 侧必须补 4.5948 的原因）。
    //
    // ── 2026-09-20 二次定案：**默认取"亮面 ≈ 贴图原色"显示档**（用户口径）──
    //
    // 用户对默认观感的要求是「被照亮的面 ≈ 贴图原色」（例：默认传送旁的坡模型
    // `models/props/666/s1_ramp1b.mdl` 应渲成 ≈ `#60473F` 而不是 `#26211E`）。
    // 该目标 = 屏幕倍率 1.0 ⇒ `pow(luxel, 1/γ) × 曝光 = 1`，取常用挡位
    // **曝光 2.3 / γ 2.2**（对 luxel 0.097 给 1.00；对图集 p50 0.044 给 0.72）。
    //
    // 两个挡位都可一键切换（面板两个滑块），**外部参照实现平价 = 曝光 1 / γ 1**：
    // 代价与依据见 documents/game/implementation/scene-brightness-and-lights.md §8
    // （平价下"被照亮的面"只有贴图原色的 0.35~0.51，是参照实现的语义，不是缺陷）。
    exposure: 2.3,
    lightGamma: 2.2,
    ambientScale: 1,
    // 1 = 接缝焊接 + 1 次 Laplacian 松弛。实测收益（ramp_1，同一相机）：
    // 三角形间亮度跳变显著收敛、贴图重新可见（对照蒙太奇见
    // documents/game/implementation/scene-brightness-and-lights.md §11）。
    // **0 = 原样**（要逐顶点对齐引擎烘焙值时用）。
    propVertexRelax: 1,
    // 0.85 = 方差压到游戏实拍量级（见字段注释里的靶标量测）
    propVertexFlatten: 0.85,
    // 预烘焙（默认）：与迁移前的渲染逻辑逐像素一致；纯纹理由面板切换
    mode: 'baked',
  },
};

export function createConfig(): RuntimeConfig {
  return structuredClone(DEFAULT_CONFIG);
}

export function applyConfigPatch(
  config: RuntimeConfig,
  section: keyof RuntimeConfig,
  patch: Record<string, unknown>,
): void {
  const target = config[section];
  if (!target || typeof target !== 'object') return;
  Object.assign(target, patch);
}

/** 构造 Rust `set_params` 兼容的全量参数对象（权威 Worker 与主线程预测实例共用）。
 * 公共化：映射实现收敛到 ts-shared（buildPhysicsParams + PhysicsParamsLike），
 * 本处仅做 config 字段名 → 统一入参接口的薄映射。 */
export function buildPhysicsParams(config: RuntimeConfig): Record<string, unknown> {
  const p = config.physics;
  return sharedBuildPhysicsParams(
    {
      gravity: p.gravity,
      accelerate: p.accelerate,
      friction: p.friction,
      stopSpeed: p.stopSpeed,
      jumpSpeed: p.jumpSpeed,
      airAccel: p.airAccel,
      maxSpeed: p.maxSpeed,
      walkSpeed: p.walkSpeed,
      crouchSpeed: p.crouchSpeed,
      autobhop: p.autobhop,
      bhopSpeedClamp: p.bhopSpeedClamp,
      teleportGateTicks: p.teleportGateTicks,
    },
    {
      yawBindSpeed: config.input.yawBindSpeed,
      noclipSpeed: config.input.noclipSpeed,
    },
  );
}
