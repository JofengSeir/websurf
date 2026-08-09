/**
 * 运行时配置 — 对应 render-worker.js 的 DEFAULT_CONFIG
 * 前端通过 postMessage({type:'config', patch}) 部分更新
 */

export interface PhysicsConfig {
  mode: 'noclip' | 'physics';
  /** 模型碰撞网格来源（加载地图时生效，切换后需重新加载）：
   * auto=模型自带(.phy)优先、visual=可视模型网格、phy=模型自带碰撞体 */
  colliderSource: 'auto' | 'visual' | 'phy';
  gravity: number;
  jumpSpeed: number;
  maxSpeed: number;
  friction: number;
  accelerate: number;
  airAccel: number;
  stopSpeed: number;
  duckScale: number;
  groundAngle: number; // 弧度
  slideAngle: number; // 弧度
  /** 物理模拟频率（Hz，默认 64；面板可调 48-128）。 */
  tickRate: number;
  /** 传送落地触发门槛帧数，Rust 侧当前未消费，为 config 对齐预留。默认 1。 */
  teleportGateTicks: number;
}

export interface PlayerConfig {
  radius: number;
  standHeight: number;
  duckHeight: number;
  eyeOffset: number;
}

export interface MovementConfig {
  speed: number;
  sprintMultiplier: number;
}

export interface SmoothingConfig {
  speed: number;
}

export interface TeleportConfig {
  triggerRadius: number;
  cooldownMs: number;
}

export interface LodConfig {
  pvsEnabled: boolean;
  updateInterval: number;
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
}

export interface InputConfig {
  sensitivity: number;
  pitchLimit: number; // 度
  /** Q/E 键 yaw 旋转速度（度/秒，turn bind），按住时视角水平旋转。默认 210 度/秒。 */
  yawBindSpeed: number;
  /** noclip 自由视角移动速度 HU/s，Rust noclip_step 用，sprint ×4。默认 800。 */
  noclipSpeed: number;
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
  /** 显示右上角 HUD（stats/cullStats/gameStats/planeInfo）；关闭时 Worker 停止 stats 发送与平面检测，省性能。 */
  visible: boolean;
  /** 是否显示中心准星。 */
  showCrosshair: boolean;
  /** 准星风格（见 CrosshairConfig）。 */
  crosshair: CrosshairConfig;
}

export interface DebugConfig {
  /** 显示实体碰撞箱线框（玩家附近 brush AABB，地面绿/斜坡黄/墙红）。 */
  showSolids: boolean;
  /** brush 碰撞线框显示可视距离（HU，0 = 全量）。 */
  brushViewDistance: number;
  /** 显示传送触发碰撞箱线框（所有 trigger AABB，青/紫/灰/橙分类）。 */
  showTriggers: boolean;
  /** 触发区域线框显示可视距离（HU，0 = 全量）。 */
  triggerViewDistance: number;
  /** 显示模型 .phy 碰撞网格线框（橙色，按 phyViewDistance 距离筛选）。 */
  showPhy: boolean;
  /** .phy 碰撞网格显示可视距离（HU，0 = 全量）。 */
  phyViewDistance: number;
  /** 显示模型可视网格线框（紫色，按 visViewDistance 距离筛选）。 */
  showVis: boolean;
  /** 可视网格线框显示可视距离（HU）。 */
  visViewDistance: number;
  /** 准星射线检测（hover 查看模型/实体平面/触发面信息）。 */
  showPlaneInfo: boolean;
}

/** 纹理画质配置（mosaic 共享模块，运行时切换贴图，无需重载地图）。 */
export interface TextureConfig {
  /** original = 原始纹理（VTF 解码）；mini = mosaic 压缩低清纹理（×8 最近邻）。 */
  quality: 'original' | 'mini';
}

export interface RuntimeConfig {
  physics: PhysicsConfig;
  player: PlayerConfig;
  movement: MovementConfig;
  smoothing: SmoothingConfig;
  teleport: TeleportConfig;
  lod: LodConfig;
  lighting: LightingConfig;
  input: InputConfig;
  hud: HudConfig;
  debug: DebugConfig;
  texture: TextureConfig;
}

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
    teleportGateTicks: 1,
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
    // PVS 默认开启，每帧判定，视角转动时剔除即时响应，显著降低 draw calls
    pvsEnabled: true,
    updateInterval: 1,
    cullDistance: 12800, // 默认视距上限（加载后由场景覆盖，见 lod-manager）
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
  },
  input: {
    // cs-movement 乘数模型：有效灵敏度 = sensitivity * m_yaw(0.022) deg/px
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
    showPlaneInfo: false,
  },
  texture: {
    quality: 'original',
  },
};

/** 深拷贝默认配置，避免运行时修改污染 */
export function createConfig(): RuntimeConfig {
  return structuredClone(DEFAULT_CONFIG);
}

/** 部分更新配置（对应 render-worker.js applyConfigPatch） */
export function applyConfigPatch(
  config: RuntimeConfig,
  section: keyof RuntimeConfig,
  patch: Record<string, unknown>,
): void {
  const target = config[section];
  if (!target || typeof target !== 'object') return;
  Object.assign(target, patch);
}
