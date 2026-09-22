/**
 * 本工程的运行时配置：结构定义（`RuntimeConfig` 的七段）、默认值（`DEFAULT_CONFIG`）与三个工具函数。
 *
 * 数据流：
 * - 主线程在 `apps/game/src/app.ts` 建一份副本（`createConfig()`）；面板改动由
 *   `apps/game/src/panel/panel-controller.ts` 就地写回该副本，并经
 *   `apps/game/src/input/input-bridge.ts` 的 `sendConfig` 以 `config` 消息下发 Worker；
 * - Worker 侧另有一份副本（`apps/game/src/worker/main.ts` 的 `createConfig()`），由
 *   `src/ts-shared/auth/worker-dispatch.ts` 的 `config` 分支调 `applyConfigPatch` 部分更新；
 * - 物理参数不从 config 直接取：先经本文件的 `buildPhysicsParams` 映射成 Rust `set_params`
 *   的 snake_case 键（键名映射本体委托给 `src/ts-shared/phys/params.ts` 的同名函数）。
 *
 * 读点分布（各字段注释逐项标注）：面板控件初值与偏好持久化在
 * `apps/game/src/panel/panel-controller.ts`；双端下发在 `apps/game/src/input/input-bridge.ts`
 * 与 `apps/game/src/worker/main.ts` 的 `syncParamsToWasm`；渲染侧消费在
 * `apps/game/src/renderer/renderer-main.ts` 与 `apps/game/src/renderer/lightmap-shader.ts`；
 * 输入与 HUD 在 `apps/game/src/app.ts`。
 */

import { buildPhysicsParams as sharedBuildPhysicsParams } from '../../../src/ts-shared/phys/params.js';

export interface PhysicsConfig {
  /** 物理模式：physics（权威物理）/ noclip（自由视角，禁物理/传送）。
   *  **本字段零读取点**：写入者是 `InputBridge.sendConfig('physics', { mode })` 经
   *  `applyConfigPatch` 落到副本；权威侧的模式判定读的是消息里的 `patch.mode`
   *  （`src/ts-shared/auth/worker-dispatch.ts` 的 `config` 分支），不读本字段。 */
  mode: 'physics' | 'noclip';
  /** 物理模拟频率（Hz）。读点：`apps/game/src/worker/main.ts` 的 `getConfigTickRate`
   *  （→ `src/ts-shared/auth/auth-loop.ts` 的 `setFixedDt`，固定步长 = 1 / max(tickRate, 1) 秒）、
   *  `apps/game/src/input/input-bridge.ts` 的 `sendConfig`（显式附加进 physics 下发参数）、
   *  面板 tickRate 控件（量程 48..128）、`apps/game/src/app.ts` 的 `syncFullConfig`
   *  （`lockTickRate` 为真时强制写 64）。 */
  tickRate: number;
  /** 重力加速度（HU/s²）→ Rust `gravity`。读点：`worker/main.ts` 的 `syncParamsToWasm`
   *  与 `buildPhysicsParams`；面板重力控件（量程 200..2000）。 */
  gravity: number;
  /** 起跳速度（HU/s）→ Rust 侧按 `jump_height = v² / (2·gravity)` 反算成跳高
   *  （见 `src/ts-shared/phys/params.ts`）。读点同 `gravity`。 */
  jumpSpeed: number;
  /** 地面最大速度（HU/s）→ Rust `run_speed`。读点同 `gravity`。 */
  maxSpeed: number;
  /** 地面摩擦系数 → Rust `friction`。读点同 `gravity`。 */
  friction: number;
  /** 地面加速度 → Rust `accelerate`。读点同 `gravity`。 */
  accelerate: number;
  /** 空中加速上限 → Rust `air_accelerate`。读点同 `gravity`。 */
  airAccel: number;
  /** 停速阈值（HU/s）：低于它时摩擦按停速处理 → Rust `stop_speed`。读点同 `gravity`。 */
  stopSpeed: number;
  /** 自动连跳（按住跳跃键持续起跳）→ Rust `autobhop`。读点同 `gravity`。 */
  autobhop: boolean;
  /** 走路速度（HU/s，Shift 慢走）→ Rust `walk_speed`。读点同 `gravity`。 */
  walkSpeed: number;
  /** 蹲走速度（HU/s）→ Rust `crouch_speed`。读点同 `gravity`。 */
  crouchSpeed: number;
  /** 连跳速度钳制（true = 连跳不超过 maxSpeed）→ Rust `bhop_speed_clamp`。读点同 `gravity`。 */
  bhopSpeedClamp: boolean;
  /** 传送触发所需的落地稳定帧数 → Rust `teleport_gate_ticks`。读点同 `gravity`。 */
  teleportGateTicks: number;
}

export interface InputConfig {
  /** 鼠标灵敏度。读点：`apps/game/src/app.ts` 的 `layerMouseDelta(r.dx, r.dy, ...)`
   *  （在主线程输入层乘入角度增量）、面板灵敏度控件（量程 0.1..5.0）与偏好持久化。
   *  **不进入物理参数**：`src/ts-shared/phys/params.ts` 的 `buildPhysicsParams` 把
   *  `sensitivity` 固定写成 1，故改本字段不会造成双端物理参数分叉。 */
  sensitivity: number;
  /** pitch 限位（度）。**本工程内零读取点**：只有接口声明与默认值，
   *  `apps/game/src` 下没有任何读取者。 */
  pitchLimit: number;
  /** Q/E 键 yaw 旋转速度（度/秒，turn bind）→ Rust `yaw_bind_speed`。
   *  读点：`worker/main.ts` 的 `syncParamsToWasm`、`apps/game/src/app.ts` 的 turn bind、
   *  面板控件（量程 0..720）。 */
  yawBindSpeed: number;
  /** noclip 自由视角移动速度（HU/s）→ Rust `noclip_speed`。读点：`worker/main.ts` 的
   *  `syncParamsToWasm`、面板 noclip 控件（量程 200..3000）。 */
  noclipSpeed: number;
}

/** 碰撞箱尺寸（HU）。读点：`worker/main.ts` 的 `syncParamsToWasm`（→ wasm `set_hull`）、
 *  `apps/game/src/input/input-bridge.ts` 的 `sendConfig('player', …)`（构造 hull 并同时写双端）、
 *  面板体型控件。三项都是 `set_hull` 的入参，不是 `set_params` 的键。 */
export interface PlayerConfig {
  halfWidth: number;
  standHeight: number;
  duckHeight: number;
}

/** 准星风格化配置（面板可调，localStorage 持久化）。
 *  读点：`apps/game/src/panel/panel-controller.ts` 的 `applyCrosshair`（写 DOM 样式）
 *  与 `pushHud`（回填控件）。 */
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
  /** 是否显示准星。读点：面板 `applyCrosshair` / `pushHud`。 */
  showCrosshair: boolean;
  /** 速度面板模式：'lateral' 横向 / 'lateral-vertical' 横+竖 / 'total' 综合。
   *  读点：`apps/game/src/app.ts` 的 HUD 速度文本、面板控件。 */
  speedMode: 'lateral' | 'lateral-vertical' | 'total';
  /** 准星风格（见 CrosshairConfig）。 */
  crosshair: CrosshairConfig;
  /** 视野角 FOV（度）。读点：`renderer-main.ts` 的透视相机与 `setFov`、面板控件（量程 60..110）。 */
  fov: number;
  /** 渲染距离（世界单位，≈1 英寸）：超过该距离的空间块在 LOD 遍历里隐藏（不产生 draw call）。
   *  `0` = 自动（取自动剔除距离 = 地图包围盒对角线 × 0.5）；读点：`renderer-main.ts` 的
   *  `cullDistance` 选取、面板控件（量程 0..60000）。 */
  renderDistance: number;
}

/** 纹理画质配置（mosaic 共享模块，运行时切换贴图，无需重载地图）。
 *  读点：`renderer-main.ts` 的场景装载尾部（`applyTextureQuality`）、面板控件。 */
export interface TextureConfig {
  /** original = 原始纹理（VTF 解码）；mini = mosaic 压缩低清纹理（×8 最近邻）。 */
  quality: 'original' | 'mini';
}

/** 光照显示配置（只作用于显示侧，不改 pakfile 里的烘焙数据）。 */
export interface LightingConfig {
  /** 全局曝光（显示侧亮度倍率，world lightmap 与 prop ambient 共用同一旋钮）。
   *  读点：`renderer-main.ts` 初始化装配的 `setExposure`、
   *  `apps/game/src/renderer/lightmap-shader.ts` 的 `setExposure`（写共享 uniform）、
   *  面板控件（量程 0.1..8）。接受窗口：`setExposure` 只接受有限正数，非正数直接忽略。 */
  exposure: number;
  /** 光照项 gamma（shadow-lift）：对解码后的线性辐射度做 `pow(d, γ)`，只抬暗部。
   *  读点同 `exposure`（`setLightGamma` 的共享 uniform、面板控件量程 0.5..6）。
   *  **接受窗口是 `(0, 1]`**：`lightmap-shader.ts` 的 `setLightGamma` 对
   *  `value <= 0 || value > 1` 直接返回，故本字段取大于 1 的值时该次写入被忽略。 */
  lightGamma: number;
  /** 模型（prop）烘焙光照亮度倍率：只作用于 ambient cube 路径（static prop 的静态照明），
   *  与 world lightmap 的曝光 / γ 相互独立。读点：`renderer-main.ts` 初始化装配、
   *  `lightmap-shader.ts` 的 `setAmbientScale`（接受有限非负数）、面板控件（量程 0..3）。 */
  ambientScale: number;
  /** 第 1 级逐顶点预烘焙光照的**重建平滑次数**（只作用于几何侧重建，不改烘焙值）。
   *  0 = 原样使用；1 = 接缝焊接 + 1 次 Laplacian 松弛；2~3 = 更平滑。
   *  读点：`renderer-main.ts` 初始化装配 → `lightmap-shader.ts` 的 `setPropVertexRelax`
   *  （取整后使用，负数忽略）。面板无控件。 */
  propVertexRelax: number;
  /** 第 1 级逐顶点光照的**方差压缩**（0..1）：`v ← mean + (1-flatten)·(v-mean)`，均值不变。
   *  0 = 保留烘焙值的原始分布；1 = 该 prop 均匀受光。读点同 `propVertexRelax`
   *  （`setPropVertexFlatten`，取值被钳到上限 1）。面板无控件。 */
  propVertexFlatten: number;
  /** 光照模式（面板「预烘焙 / 纯纹理」）：
   *  - `baked`：世界面吃 lightmap atlas，prop 吃逐顶点烘焙 / leaf ambient cube；
   *  - `texture`：只上漫反射贴图原色（`MeshBasicMaterial`），不解码 atlas。
   *  读点：`renderer-main.ts` 初始化装配 → `lightmap-shader.ts` 的 `setLightingMode`
   *  （写共享 uniform 的运行期切换）、面板控件与偏好持久化。 */
  mode: 'baked' | 'texture';
}

export interface RuntimeConfig {
  /** 锁定 tick 频率：true = `physics.tickRate` 固定 64 且面板控件禁用；
   *  false = 面板 48..128 可调。读点：`apps/game/src/panel/panel-controller.ts`
   *  （控件禁用与固定下发）、`apps/game/src/app.ts` 的 `syncFullConfig`（下发前强制写 64）。 */
  lockTickRate: boolean;
  physics: PhysicsConfig;
  input: InputConfig;
  player: PlayerConfig;
  hud: HudConfig;
  texture: TextureConfig;
  lighting: LightingConfig;
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  // 默认不锁频（面板可调）；改为 true 后需 reload 生效
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
    // 默认取「被照亮的面 ≈ 贴图原色」的显示档：曝光 × pow(luxel, 1/γ) ≈ 1。
    // lightGamma 的接受窗口是 (0, 1]（见字段注释），本默认值大于 1
    // ⇒ `setLightGamma` 忽略本次写入、共享 uniform 保持其自身初值。
    exposure: 2.3,
    lightGamma: 2.2,
    ambientScale: 1,
    // 1 = 接缝焊接 + 1 次 Laplacian 松弛；0 = 原样使用烘焙值
    propVertexRelax: 1,
    // 0.85 = 压掉大部分方差、保留少量结构；1 = 完全压平到 prop 均值
    propVertexFlatten: 0.85,
    // 预烘焙；纯纹理由面板切换
    mode: 'baked',
  },
};

export function createConfig(): RuntimeConfig {
  return structuredClone(DEFAULT_CONFIG);
}

/** 部分更新：按 `section` 取顶层段并 `Object.assign` 合入 patch。
 *  段不存在或不是对象时静默返回（不抛错）；patch 里出现段中不存在的键时照写。 */
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
 *  本函数只做 `config` 字段名 → 统一入参接口（`PhysicsParamsLike` / `PhysicsInputLike`）的
 *  薄映射，键名与 `jump_height` 换算全在 `src/ts-shared/phys/params.ts` 的 `buildPhysicsParams`。
 *  注意入参是**整个 `RuntimeConfig`**（与 `input-bridge.ts` 的调用形式一致），不是 physics 段。 */
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
