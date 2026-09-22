/**
 * 运行时配置树（debug 侧唯一配置来源）：主线程 `apps/debug/src/app.ts` 与
 * Worker `apps/debug/src/worker/main.ts` 各持一份 `createConfig()` 深拷贝。
 *
 * 更新通路：主线程先经 `applyConfigPatch` 就地合并某个子段，再把同一份 patch 经
 * `apps/debug/src/input/input-bridge.ts` 的 `sendConfig` 以
 * `{ type: 'config', section, patch }` 发往 Worker；Worker 侧由
 * `src/ts-shared/auth/worker-dispatch.ts` 的 `config` 分支接收（该分支只对 `physics` 与
 * `input` 两段做键名归一，其余段原样透传）。
 */

export interface PhysicsConfig {
  mode: 'noclip' | 'physics';
  /** 模型碰撞网格来源：由 `buildWorldBundle` 在加载地图时读一次，改档位须重新加载地图。
   * `auto` = 先取模型自带 `.phy` 凸包，结果为空再退可视网格；`visual` = 只用可视网格三角形；
   * `phy` = 只用模型自带 `.phy` 凸包。实现见 `src/ts-shared/phys/world-builder.ts` 的
   * `buildWorldBundle`：三档任一步导出抛错都回退可视网格，再失败给空数组。 */
  colliderSource: 'auto' | 'visual' | 'phy';
  gravity: number;
  jumpSpeed: number;
  maxSpeed: number;
  friction: number;
  accelerate: number;
  airAccel: number;
  stopSpeed: number;
  duckScale: number;
  groundAngle: number; // 弧度；可站立地面判据取 `Math.cos(groundAngle)`（collider-debug 的 groundAngleCos）
  slideAngle: number; // 弧度；斜坡滑行判据取 `Math.cos(slideAngle)`（collider-debug 的 slideAngleCos）
  /** 物理模拟频率（Hz）。JS 驱动层参数，不进 Rust：Worker 侧由
   * `apps/debug/src/worker/main.ts` 把 `physicsWorker.params.onTickRateChange` 接到权威固定
   * 步长，主线程侧的交错渲染循环按同一值步进。面板取值范围见
   * `apps/debug/src/physics/param-defs.ts` 的 `PARAM_DEFS` 中 `tickRate` 项（48–128）。 */
  tickRate: number;
  /** 传送触发落地稳定门槛（帧）。经 `buildPhysicsParams` 写成 `set_params` 的
   * `teleport_gate_ticks` 键并存进 `PhysParams`，但 `src/phys/teleport.rs` 的 `check` 形参
   * 名为 `_gate_ticks` 且函数体从不读它 —— 该值不改变传送判定。默认 3，与
   * `PhysParams::default` 同值。 */
  teleportGateTicks: number;
}

export interface PlayerConfig {
  /** 玩家箱半宽（HU）：`set_hull` 的第一个实参。Worker 侧取用于 `syncParamsToWasm`，主线程侧取用于 `rendererMain.setPredictionHull`。 */
  radius: number;
  /** 站立箱高（HU）：`set_hull` 的第二个实参；collider-debug 也用它由相机 Y 反推脚底 Y。 */
  standHeight: number;
  /** 蹲伏箱高（HU）：`set_hull` 的第三个实参。 */
  duckHeight: number;
  /** 由相机 Y 反推脚底 Y 时的补偿量（HU）；唯一读取点是 `apps/debug/src/renderer/collider-debug.ts`。 */
  eyeOffset: number;
}

/** 常规移动速度参数。两个字段在本仓无读取点（配置树保留）：debug 的地面速度上限由 `PhysicsConfig.maxSpeed` 经 `set_params` 的 `run_speed` 决定。 */
export interface MovementConfig {
  /** 基础移动速度（HU/s）。无读取点。 */
  speed: number;
  /** 冲刺倍率。无读取点。 */
  sprintMultiplier: number;
}

/** 平滑参数。字段在本仓无读取点（配置树保留）。 */
export interface SmoothingConfig {
  /** 平滑速度。无读取点。 */
  speed: number;
}

/** 传送触发参数。两个字段在本仓无读取点（配置树保留）：传送判定实际用的触发半径与冷却写在 `apps/debug/src/world/teleport-manager.ts` 的模块常量 `TRIGGER_RADIUS`（64 HU）与 `TRIGGER_COOLDOWN`（0.5 s）。 */
export interface TeleportConfig {
  /** 触发半径（HU）。无读取点。 */
  triggerRadius: number;
  /** 冷却时长（ms）。无读取点。 */
  cooldownMs: number;
}

/** 视距剔除（LOD）参数；实现在 `apps/debug/src/renderer/lod-manager.ts`。 */
export interface LodConfig {
  /** PVS 开关。默认 false；本仓剔除路径只有「块中心到相机距离 > cullDistance」一条判据，不读本字段（见 `LodManager.update`）。 */
  pvsEnabled: boolean;
  /** 重判定间隔（帧）：`LodManager.setup` 与 `LodManager.update` 都从它取；只在计数达到该值时执行一次距离判定。 */
  updateInterval: number;
  /** 视距剔除距离（HU）：构造期默认值；`LodManager.setup` 返回校准值后由 `loadScene` 就地覆盖，面板滑块写的是覆盖后的值。 */
  cullDistance: number;
}

export interface LightingConfig {
  ambientColor: number;
  ambientIntensity: number;
  hemiSkyColor: number;
  hemiGroundColor: number;
  hemiIntensity: number;
  dirColor: number;
  dirIntensity: number;
  dirAzimuth: number;
  dirElevation: number;
  bgColor: number;
  /**
   * 光照模式（面板「预烘焙 / 纯纹理」）：
   * - `baked`（默认）：世界面按 lightmap atlas 采样，prop 走逐顶点烘焙（`sp_<i>.vhv` →
   *   几何属性 `_VBSP_VLIGHT`）。
   * - `texture`：材质改走 `MeshBasicMaterial` 原色，片元不采 atlas、不算解码。
   *
   * 两条路径的加载完全一致：atlas 一律照 `loadLightmapAtlas` 解码并应用，差别只在
   * `apps/debug/src/renderer/lightmap-shader.ts` 的 `setLightingMode` 改一个全场景共享的
   * uniform（`bakedMixUniform`）——不重建场景、不重编译材质。面板切换经
   * `rendererMain.setLightingMode` 落到该函数。
   */
  mode: 'baked' | 'texture';
}

/** 输入层参数。 */
export interface InputConfig {
  /** 鼠标灵敏度倍率：主线程经 `layerMouseDelta` 乘进每帧鼠标增量；写进 Rust 参数时为恒 1（见 `src/ts-shared/phys/params.ts` 的 `buildPhysicsParams`）。 */
  sensitivity: number;
  pitchLimit: number; // 度；CameraController 构造与 applyInputConfig 把它换算成弧度限位
  /** Q/E 键 yaw 旋转速度（度/秒）：由 `buildPhysicsParams` 写成 `set_params` 的 `yaw_bind_speed`；
   * Rust 侧只有 noclip_step 用它加 yaw，主线程另按它折算成等效鼠标像素量。 */
  yawBindSpeed: number;
  /** noclip 自由视角移动速度（HU/s）：由 `buildPhysicsParams` 写成 `set_params` 的 `noclip_speed`，
   * Rust 的 noclip_step 取它作单步位移基准，按住 sprint 位再 ×4。 */
  noclipSpeed: number;
}

/** 准星风格化配置（面板可调；随 `UI_PREFS_KEY` 一起写入 localStorage）。 */
export interface CrosshairConfig {
  /** 准星颜色（CSS 颜色串，写进样式变量 `--ch-color`）。 */
  color: string;
  /** 准星线条长度（px，样式变量 `--ch-size`）。 */
  size: number;
  /** 准星线条粗细（px，样式变量 `--ch-thickness`）。 */
  thickness: number;
  /** 准星中心间隙（px，样式变量 `--ch-gap`）。 */
  gap: number;
  /** 是否为 `.ch-line` 加 outline 类（黑色描边）。 */
  outline: boolean;
  /** 是否显示中心点 `.ch-dot`。 */
  dot: boolean;
}

export interface HudConfig {
  /** 显示右上角 HUD（控制 `hudEl` 的 display）。Worker 侧无读取点。 */
  visible: boolean;
  /** 是否显示中心准星（切换 `crosshairEl` 的 hidden 类）。 */
  showCrosshair: boolean;
  /** 准星风格，字段见 `CrosshairConfig`。 */
  crosshair: CrosshairConfig;
}

export interface DebugConfig {
  /** 显示 brush 碰撞箱线框（`colliderDebug.setDebugFlags` 的第一个实参；改动经 `applyConfigPatch` 的 debug 分支重设）。 */
  showSolids: boolean;
  /** brush 线框可视距离（HU，0 = 全量）：`setDebugFlags` 的第四个实参。 */
  brushViewDistance: number;
  /** 显示传送触发区线框（`setDebugFlags` 的第二个实参）。 */
  showTriggers: boolean;
  /** 触发区线框可视距离（HU，0 = 全量）：`setDebugFlags` 的第三个实参。 */
  triggerViewDistance: number;
  /** 显示模型自带 .phy 碰撞网格线框（`colliderDebug.setTriDebugFlags` 的第一个实参）。 */
  showPhy: boolean;
  /** .phy 线框可视距离（HU，0 = 全量）：`setTriDebugFlags` 的第三个实参。 */
  phyViewDistance: number;
  /** 显示模型可视网格线框（`setTriDebugFlags` 的第二个实参）。 */
  showVis: boolean;
  /** 可视网格线框可视距离（HU，0 = 全量）：`setTriDebugFlags` 的第四个实参。 */
  visViewDistance: number;
  /** 显示 brush 棱边 chamfer 切角平面（`colliderDebug.setChamferDebugFlags` 的第一个实参）。 */
  showChamfers: boolean;
  /** chamfer 平面可视距离（HU，0 = 全量）：`setChamferDebugFlags` 的第二个实参。 */
  chamferViewDistance: number;
  /** 准星射线检测开关（写进 `RendererMain.planeInfoEnabled`）。 */
  showPlaneInfo: boolean;
}

/** 纹理画质配置（mosaic 共享模块；切换只换贴图对象，不重载地图）。 */
export interface TextureConfig {
  /** `original` = 用 VTF 解出的原图；`mini` = 用 mosaic 字节码还原的低清图。两者由 `rendererMain.applyTextureQuality` 切换。 */
  quality: 'original' | 'mini';
}

/** 全量运行时配置。子段按消费方分组：`physics` / `input` / `player` 进 Rust 参数与箱体，`lod` / `debug` / `lighting` / `texture` 只走渲染侧。 */
export interface RuntimeConfig {
  /** 物理参数（进 Rust `set_params` / `set_noclip` 与 `set_hull`）。 */
  physics: PhysicsConfig;
  /** 玩家箱体三围与相机抬高量。 */
  player: PlayerConfig;
  /** 常规移动参数，见 `MovementConfig`（无读取点）。 */
  movement: MovementConfig;
  /** 平滑参数，见 `SmoothingConfig`（无读取点）。 */
  smoothing: SmoothingConfig;
  /** 传送参数，见 `TeleportConfig`（无读取点）。 */
  teleport: TeleportConfig;
  /** 视距剔除参数（渲染侧）。 */
  lod: LodConfig;
  /** 灯光参数，由 `LightManager.syncFromConfig` 整体读取。 */
  lighting: LightingConfig;
  /** 输入层参数（主线程鼠标增量 + Q/E 折算 + Rust 两键）。 */
  input: InputConfig;
  /** HUD 与准星（只作用于主线程 DOM）。 */
  hud: HudConfig;
  /** 调试可视化开关（只作用于渲染侧）。 */
  debug: DebugConfig;
  /** 纹理画质（渲染侧）。 */
  texture: TextureConfig;
}

/** 全量默认值；物理段取值与 `src/phys/player.rs` 的 `PhysParams::default` 及 `PARAM_DEFS` 对齐。 */
export const DEFAULT_CONFIG: RuntimeConfig = {
  physics: {
    mode: 'physics',
    colliderSource: 'auto',
    gravity: 800,
    jumpSpeed: 302,
    maxSpeed: 250,
    friction: 4,
    accelerate: 10,
    airAccel: 150,
    stopSpeed: 100,
    duckScale: 0.34,
    groundAngle: (30 * Math.PI) / 180,
    slideAngle: (70 * Math.PI) / 180,
    tickRate: 64,
    teleportGateTicks: 3,
  },
  player: {
    radius: 16,
    standHeight: 72,
    duckHeight: 54,
    eyeOffset: 8,
  },
  movement: {
    speed: 200,
    sprintMultiplier: 4,
  },
  smoothing: {
    speed: 12,
  },
  teleport: {
    triggerRadius: 64,
    cooldownMs: 600,
  },
  lod: {
    // PVS 剔除默认关闭：本仓剔除路径（`apps/debug/src/renderer/lod-manager.ts` 的
    // `update`）只按「块中心到相机距离 > cullDistance」判可见，不查 PVS 可见集；
    // 面板保留该开关，改动只落进 config 与发往 Worker 的 `config` 消息。
    pvsEnabled: false,
    updateInterval: 1,
    cullDistance: 12800, // 构造期默认视距；`loadScene` 之后被 lod-manager 的 `setup` 校准值覆盖
  },
  lighting: {
    ambientColor: 0xffffff,
    ambientIntensity: 0.6,
    hemiSkyColor: 0xb0c4de,
    hemiGroundColor: 0x404030,
    hemiIntensity: 0.4,
    dirColor: 0xfff4e0,
    dirIntensity: 0.5,
    dirAzimuth: 45,
    dirElevation: 45,
    bgColor: 0x222222,
    // 默认预烘焙；纯纹理由面板经 `rendererMain.setLightingMode` 切换
    mode: 'baked',
  },
  input: {
    // 乘数模型：Rust 侧每像素转 `sensitivity × M_YAW` 度（`src/phys/player.rs` 的 M_YAW = 0.022）
    sensitivity: 1.5,
    pitchLimit: 89,
    yawBindSpeed: 210,
    noclipSpeed: 800,
  },
  hud: {
    visible: true,
    showCrosshair: true,
    crosshair: {
      color: '#4ade80',
      size: 6,
      thickness: 2,
      gap: 4,
      outline: true,
      dot: false,
    },
  },
  debug: {
    showSolids: false,
    brushViewDistance: 512,
    showTriggers: false,
    triggerViewDistance: 0,
    showPhy: false,
    phyViewDistance: 4096,
    showVis: false,
    visViewDistance: 1024,
    showChamfers: false,
    chamferViewDistance: 512,
    showPlaneInfo: false,
  },
  texture: {
    quality: 'original',
  },
};

/** 深拷贝默认配置：调用方改自己的副本不会污染 `DEFAULT_CONFIG`。 */
export function createConfig(): RuntimeConfig {
  return structuredClone(DEFAULT_CONFIG);
}

/** 按段浅合并 patch：`Object.assign` 就地改写 `config[section]`；`section` 不存在或非对象时直接返回。 */
export function applyConfigPatch(
  config: RuntimeConfig,
  section: keyof RuntimeConfig,
  patch: Record<string, unknown>,
): void {
  const target = config[section];
  if (!target || typeof target !== 'object') return;
  Object.assign(target, patch);
}
