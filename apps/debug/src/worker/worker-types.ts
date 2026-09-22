/**
 * 消息协议类型声明：主线程 ↔ debug Worker。
 *
 * 本文件只有 `interface` 与 `type` 声明，编译后不产生运行时代码；两侧以消息的字符串
 * `type` 字段分发，故字段形状在这里是声明面契约，运行时由发送端与接收端各自断言。
 *
 * 装配点与分发实现：
 * - Worker 侧：`apps/debug/src/worker/main.ts` 把 `self.onmessage` 接到
 *   `src/ts-shared/auth/worker-dispatch.ts` 的 `createWorkerDispatch`。该函数按 `type`
 *   逐分支处理，未识别的消息最后交给 `onExtraMessage`；本工程的面板消息就在那里由
 *   `apps/debug/src/worker/physics-worker.ts` 的 `handleMessage` 接管。
 * - 主线程侧：`apps/debug/src/app.ts` 的 `handleWorkerMessage` 按 `type` 分派 Worker
 *   发回的消息；发送口集中在 `apps/debug/src/input/input-bridge.ts` 与 `app.ts`。
 *
 * 方向约定：`WorkerMessage` 联合的成员由主线程发往 Worker；`MainMessage` 联合的成员由
 * Worker 发往主线程。两侧各自还有「已声明但当前无收发链路」与「运行时存在但未声明」的
 * 项，逐条记在对应成员上。
 */

import type { RuntimeConfig } from '../config.js';

// ── 主线程 → Worker ──────────────────────────────────────────

/**
 * 注入 WASM 模块与内嵌默认纹理包。
 *
 * 实例化来源二选一：`wasmB64` 为真值时走同步解码分支；否则 `wasmUrl` 为真值时取字节后
 * 同步实例化；两者都缺席时分发层直接返回，wasm 就绪标志保持 false。`mtzB64` 与 wasm
 * 无关：它由 `apps/debug/src/worker/main.ts` 注册的 `onWasmInit` 钩子取走（该钩子在本
 * 消息处理流程里最先执行，早于解码与实例化），最终落到
 * `apps/debug/src/worker/mtz-data.ts` 的 `setMtzB64`。
 */
export interface WasmInitMessage {
  type: 'wasm-init';
  wasmB64?: string;
  wasmUrl?: string;
  /** 默认纹理包 base64（构建产物内嵌；主线程从 `globalThis.__VBSP_TEXTURES_MTZ_B64__` 读出）。 */
  mtzB64?: string;
}

export interface InitMessage {
  type: 'init';
  /**
   * 共享内存（SharedArrayBuffer）：
   * - 非 null：Worker 侧建 `ShmState`——输入槽、权威帧槽、渲染采样槽全走共享内存 + 原子操作；
   * - null：建 `MsgState`——改走 `input` / `phys-frame` 消息回退通道。
   * 分发层只读本字段，随后调用 `onInit` 钩子（本工程在那里回一条 `ready`）。
   */
  shared: SharedArrayBuffer | null;
  /** 画布宽高与设备像素比（`InputBridge.sendInit` 传画布客户区尺寸与 `window.devicePixelRatio`）。
   *  渲染在主线程，Worker 侧没有这三个字段的读取点。 */
  width: number;
  height: number;
  dpr: number;
}

/**
 * 输入状态消息（回退通道专用）：`MsgState` 侧每帧发一条，收到后累加 dx/dy 并无条件覆盖
 * keys（反映当前按键状态，松手即清零）。
 *
 * 分发层守卫：仅当通道不是共享内存（`isShared === false`）才处理本消息。运行时同一条消息
 * 还可携带 `rt` / `rx` / `ry` / `rz` / `ri0` / `repoch` 六个渲染采样字段（由
 * `MsgState.addInput` 附带；接收侧只在 `rt` 有值时才写采样槽），本接口不声明这六项。
 */
export interface InputMessage {
  type: 'input';
  dx: number;
  dy: number;
  keys: number;
}

/**
 * 世界数据（主线程解析 BSP 后经 `InputBridge.sendWorldJson` 下发）。
 *
 * 前置条件：wasm 已就绪，否则整条消息被丢弃。处理动作：释放旧实例 → 新建实例 →
 * `build_world(brushJson, triJson, teleportJson, spawn.x, spawn.y, spawn.z, spawn.yawDeg)`
 * → 重放参数与固定步长 → 重放已记忆的死亡阈值 → 依次回调 `onWorldBuilt`、`onWorldSpawn`、
 * `onWorldRebuilt`。
 */
export interface WorldJsonMessage {
  type: 'world-json';
  brushJson: string;
  triJson: string;
  teleportJson: string;
  spawn: { x: number; y: number; z: number; yawDeg: number };
}

/**
 * 配置部分更新（`InputBridge.sendConfig`）。
 *
 * 前置条件：已有权威实例，否则整条丢弃。`physics` / `input` 两段的 patch 先做键名归一
 * （snake_case → camelCase，并把 `jump_height` 换算成 `jumpSpeed`），其余段原样透传；
 * 归一之后才写 Worker 自身的 config 副本，`physics` 段的 `tickRate` 随即使固定步长生效。
 * `section` 在运行时按字符串比较，`keyof RuntimeConfig` 只是声明面约束。
 */
export interface ConfigMessage {
  type: 'config';
  section: keyof RuntimeConfig;
  patch: Record<string, unknown>;
}

/**
 * 画布尺寸变化消息。
 *
 * 当前无收发链路：`apps/debug/src/app.ts` 的窗口 `resize` 监听只调
 * `RendererMain.resize`，全仓没有本消息的发送点；`createWorkerDispatch` 与
 * `PhysicsWorker.handleMessage` 也都没有对应分支（该消息落到 `onExtraMessage` 后被判为
 * 未处理）。声明保留。
 */
export interface ResizeMessage {
  type: 'resize';
  width: number;
  height: number;
}

/** 重生请求（`InputBridge.sendRespawn`）：重生到 `build_world` 给定的初始出生点。 */
export interface RespawnMessage {
  type: 'respawn';
}

/** 设置物理参数（物理面板）：`name` 取自 `apps/debug/src/physics/param-defs.ts` 的
 *  `PARAM_DEFS`，数值按该定义的上下限钳制；`name` 为 `tickRate` 时不写 Rust 参数。 */
export interface SetPhysicsParamMessage {
  type: 'set-physics-param';
  name: string;
  value: number | boolean;
}

/** 恢复物理参数到 mode-default（`name` 缺省 = 全部参数）。 */
export interface ResetPhysicsParamMessage {
  type: 'reset-physics-param';
  name?: string;
}

/** 设置碰撞箱体型（半宽 + 站立高 + 蹲高；立即写权威 `set_hull`，来源标记为 manual）。 */
export interface SetHullMessage {
  type: 'set-hull';
  hull: { halfWidth: number; standHeight: number; duckHeight: number };
}

/** 恢复默认碰撞箱（半宽 16 / 站立高 72 / 蹲高 54；来源标记回到 mode-default）。 */
export interface ResetHullMessage {
  type: 'reset-hull';
}

/** 碰撞箱自动恢复开关：只改面板侧的标记并随 `physics-snapshot` 回传，不写物理实例。 */
export interface SetAutoRestoreHullMessage {
  type: 'set-auto-restore-hull';
  enabled: boolean;
}

/**
 * 设置视距剔除距离（`InputBridge.sendSetCullDistance`）。
 *
 * Worker 侧无处理分支：`createWorkerDispatch` 不认这个 `type`，消息落到 `onExtraMessage`
 * → `PhysicsWorker.handleMessage` 也不认，返回 `false` 之后被丢弃。剔除由主线程
 * `apps/debug/src/renderer/lod-manager.ts` 的 `setCullDistance` 执行。
 */
export interface SetCullDistanceMessage {
  type: 'set-cull-distance';
  value: number;
}

/** 传送到出生点列表中的第 `target` 项（写全部已注入的权威实例）。 */
export interface TeleportMessage {
  type: 'teleport';
  target: number;
}

/** 传送到任意坐标（自定义传送点面板 / 检查点回退）；`yaw` 缺省时保持权威当前朝向。 */
export interface TeleportToPosMessage {
  type: 'teleport-to-pos';
  pos: [number, number, number];
  yaw?: number;
}

/** 出生点列表（JSON 文本，形如 `[[x, y, z, yaw], ...]`）：只决定 `teleport_to_spawn`
 *  的可选目标，不改 `build_world` 给出的初始出生点。 */
export interface SetSpawnPointsMessage {
  type: 'set-spawn-points';
  json: string;
}

/**
 * 渲染主线 → 权威的状态同步（大偏差兜底与传送豁免期同步；由
 * `apps/debug/src/renderer/renderer-main.ts` 的 `onSyncRenderState` 回调经 `app.ts` 转发）。
 *
 * 运行时同一条消息还带一个可选的 `teleport` 布尔字段（本接口不声明），Worker 按它分两支：
 * - `teleport === false`：常规重锚——位置与 yaw/pitch 取渲染状态，速度与 on_ground 从权威
 *   现读后原样写回，未消费的输入增量保留；
 * - 缺省或 `true`：全态注入——九个字段整体写入权威，并清空未消费的输入增量（键位保留）。
 */
export interface SyncRenderStateMessage {
  type: 'sync-render-state';
  state: {
    posX: number; posY: number; posZ: number;
    yaw: number; pitch: number;
    velX: number; velY: number; velZ: number;
    onGround: boolean;
  };
}

/**
 * 掉落死亡阈值（主线程从场景包围盒算出，权威与渲染同值）。
 *
 * 收到数值即被记忆，随后写全部已注入的权威实例；记忆值在世界重建时自动重放，因此
 * 本消息早于 `world-json` 到达也不会丢失。
 */
export interface SetDeathThresholdMessage {
  type: 'set-death-threshold';
  value: number;
}

/** 主线程 → Worker 的消息类型（18 项）。运行时另有 `set-mode` 与 `set-hold` 两条被
 *  分发层处理的消息，未在本联合中声明。 */
export type WorkerMessage =
  | WasmInitMessage
  | InitMessage
  | InputMessage
  | WorldJsonMessage
  | ConfigMessage
  | ResizeMessage
  | RespawnMessage
  | SetPhysicsParamMessage
  | ResetPhysicsParamMessage
  | SetHullMessage
  | ResetHullMessage
  | SetAutoRestoreHullMessage
  | SetCullDistanceMessage
  | TeleportMessage
  | TeleportToPosMessage
  | SetSpawnPointsMessage
  | SyncRenderStateMessage
  | SetDeathThresholdMessage;

// ── Worker → 主线程 ──────────────────────────────────────────

/** 就绪回执：由 `apps/debug/src/worker/main.ts` 的 `onInit` 钩子在 `init` 处理完之后发出；
 *  主线程据此更新状态栏提示。 */
export interface ReadyMessage {
  type: 'ready';
}

/**
 * 权威帧（回退通道专用）：`MsgState.writeAuthoritative` 每发布一帧发一条；共享内存模式下
 * 帧写权威槽，不发本消息。
 *
 * `va` 是发布方单调递增的版本号。发布若带了协议 meta，消息还会多出 `seg` / `tick` / `evt`
 * 三个字段（本接口不声明）；主线程消费点只读 `frame` 与 `va`。
 */
export interface PhysFrameMessage {
  type: 'phys-frame';
  va: number;
  frame: {
    /** 权威位置（HU）。 */
    pos: { x: number; y: number; z: number };
    /** 权威 yaw（度）。 */
    yaw: number;
    /** 权威 pitch（度）。 */
    pitch: number;
    /** 权威速度（HU/s）。 */
    vel: { x: number; y: number; z: number };
    /** 是否着地。 */
    onGround: boolean;
    /** 眼高（HU；随蹲伏姿态变化）。 */
    eyeHeight: number;
    /** 发布时刻（Worker 的 `performance.now()`，ms）。 */
    timeMs: number;
  };
}

/**
 * 权威碰撞事件（低频）：由 `src/ts-shared/auth/auth-loop.ts` 的 `stepPhysics` 在耦合 /
 * 回落支路发出，`land` 与 `blocked` 二选一（前者命中即返回）。
 *
 * 载荷取自事件时刻权威 `state()` 的读数：`land` 判着地上升沿；`blocked` 判速度骤降且实际
 * 位移远小于速度对应的位移。消费点 `apps/debug/src/renderer/renderer-main.ts` 的
 * `applyCollisionCorrection` 形参里只有 `kind` 与 `vel` 参与计算，位置与朝向形参带下划线、
 * 函数体不读。tick 模式零分配支路与 hold 冻结支路都不发本消息。
 */
export interface PhysEventMessage {
  type: 'phys-event';
  kind: 'land' | 'blocked';
  pos: number[];
  /** 事件时刻权威朝向（度）。 */
  yawDeg: number;
  pitchDeg: number;
  /** 事件时刻权威速度（HU/s；`land` 供速度校准，`blocked` 侧消费端零写入）。 */
  vel?: number[];
  timeMs: number;
}

/**
 * 物理参数快照（参数/碰撞箱变更后回传，面板渲染用）。
 *
 * `params` 逐项来自 `PARAM_DEFS`（当前 12 项：11 个物理参数 + `tickRate`）；主线程
 * `renderPhysicsSnapshot` 用它回填控件，并把同一份参数镜像到渲染物理实例。
 */
export interface PhysicsSnapshotMessage {
  type: 'physics-snapshot';
  /** 每项只含 name/value/source；label、单位与取值范围留在主线程的 `PARAM_DEFS`。 */
  params: Array<{ name: string; value: number | boolean; source: string }>;
  hull: {
    halfWidth: number;
    standHeight: number;
    duckHeight: number;
    source: string;
    isDefault: boolean;
  };
  autoRestoreHull: boolean;
}

/**
 * 物理事件通知（面板提示）。
 *
 * 当前无生产者：`event` 的取值在本仓库内只有本文件声明与 `apps/debug/src/app.ts` 的
 * `onPhysicsEvent` 消费，没有发送点。
 */
export interface PhysicsEventMessage {
  type: 'physics-event';
  event: 'hull-auto-restored';
  message: string;
}

/** 错误回传：分发层的 wasm 实例化失败路径发一条（文本前缀 `Worker wasm 加载失败`）；
 *  主线程 `setError` 把它显示到错误条。 */
export interface ErrorMessage {
  type: 'error';
  message: string;
}

/** 权威健康告警：由 `apps/debug/src/worker/main.ts` 的 `postHealth` 发出，文本前缀
 *  `[authority-health]`；主线程 `pushHealthLog` 写进面板「权威健康」控制台（最新在顶、
 *  上限 30 条），不写 console。 */
export interface HealthLogMessage {
  type: 'health-log';
  message: string;
}

/** Worker → 主线程的消息类型（7 项）。分发层还会发 `mode-ack`（`set-mode` 分支），
 *  该类型未在本联合中声明，主线程分派也没有对应分支。 */
export type MainMessage =
  | ReadyMessage
  | PhysFrameMessage
  | PhysEventMessage
  | PhysicsSnapshotMessage
  | PhysicsEventMessage
  | ErrorMessage
  | HealthLogMessage;

/**
 * 准星射线检测结果（hover 查看模型 / 实体平面 / 触发面）。
 *
 * 全程在主线程内：由 `apps/debug/src/renderer/plane-inspector.ts` 的 `cast` 系列方法构造，
 * `apps/debug/src/renderer/renderer-main.ts` 的 `getPlaneInfo` 取出，`apps/debug/src/app.ts`
 * 的 `formatPlaneInfo` 渲染成文本。它不过线程——`type` 字段是命中类型判别，不是消息类型。
 */
export interface PlaneInfo {
  /**
   * 命中类型：
   * - 'mesh'：GLB 场景射线命中（取最近交点；`meshName` 取自节点名，命中不到名字时为
   *   `(unnamed mesh)`），`planeDist` 为 null、`brushIndex` 为 -1；
   * - 'solid'：世界实体碰撞 brush 的射线-凸体求交；
   * - 'ladder'：梯子碰撞 brush 的同一套求交；
   * - 'trigger'：传送触发器 AABB。
   */
  type: 'mesh' | 'solid' | 'ladder' | 'trigger';
  /** 命中点距离（HU）。 */
  distance: number;
  /** 命中点坐标（Y-up）。 */
  point: [number, number, number];
  /** 命中面法线（Y-up，朝外）；mesh 交点的面法线取不到时为 null。 */
  normal: [number, number, number] | null;
  /** 命中面 dist（`dot(normal, pointOnPlane)`）；仅 brush 命中给出，mesh 命中为 null。 */
  planeDist: number | null;
  /** 'solid' / 'ladder'：brush 在对应数组中的下标；'trigger'：在传送管理器触发器列表中的
   *  下标；'mesh'：恒为 -1。 */
  brushIndex: number;
  // ── mesh 信息（type='mesh'）──
  /** GLB 节点名（同名节点由加载器追加序号，如 `crate`、`crate#1`）。 */
  meshName?: string;
  /** 材质名（取不到时为空串）。 */
  materialName?: string;
  /** 纹理名（取不到时为空串）。 */
  textureName?: string;
  /** 材质属性标记（网格 userData 缺失时整体为 undefined）。 */
  meshMeta?: {
    isTools: boolean;
    isNodraw: boolean;
    hasTexture: boolean;
    isWater: boolean;
    isTrans: boolean;
    isLightEmissive: boolean;
  };
  // ── trigger 信息（type='trigger'）──
  /** 触发器目标 targetname。 */
  triggerTarget?: string;
  /** 目标出生点索引；负值表示触发器没有解析到目标。 */
  triggerDestIdx?: number;
  /** 触发器 classname。 */
  triggerClassname?: string;
  /** 触发器 spawnflags 位域。 */
  triggerSpawnflags?: number;
  /** 触发器是否初始禁用。 */
  triggerStartDisabled?: boolean;
}

// ── 场景数据（主线程本地结构；不过线程）──

/**
 * 主线程解析 BSP 后交给渲染器的场景数据。
 *
 * 事实：`apps/debug/src/app.ts` 的 `handleLoadBsp` 构造该对象后**直接**传给
 * `apps/debug/src/renderer/renderer-main.ts` 的 `loadScene`；`type: 'scene-data'` 字段虽然
 * 存在，但全仓没有它的发送点。字段来源见逐项说明。
 */
export interface SceneDataMessage {
  type: 'scene-data';
  /** GLB 字节（`buildWorldBundle` 导出）。 */
  glb: ArrayBuffer;
  /** 碰撞体 JSON（WASM 侧 brushes，主线程转成渲染物理世界）。 */
  brushJson: string;
  /** 模型可视网格的三角形碰撞 JSON（缺省即不带该部分）。 */
  triJson?: string;
  /** 纹理画质 manifest：`{ 纹理名(小写 basetexture): mosaic 字节码 }` JSON。 */
  mosaicManifest?: string;
  /** 缺失材质纹理列表（VMT/VTF 缺失 → 走占位色）。 */
  missingTextures?: string[];
  spawnJson: string;
  pvsJson: string;
  teleportJson: string;
  metadata: {
    mapName: string;
    numFaces: number;
    numVertices: number;
    numBrushes: number;
    numModels: number;
  };
  /** 初始出生点（Y-up 坐标 + 朝向，单位度）。 */
  spawn: { x: number; y: number; z: number; yawDeg: number };
  /** 场景对角线（构造时置 0，实际值由 `loadScene` 返回）。 */
  diagonal: number;
  /** 剔除距离上界（构造时 100000）。 */
  maxCull: number;
  /** 默认剔除距离（取 `config.lod.cullDistance`）。 */
  defaultCull: number;
  glbSizeKb: number;
  numSpawnPoints: number;
  /** PVS 数据是否可用（构造判据 = `pvsJson.length > 2`）。 */
  hasPvs: boolean;
  /** 掉落死亡阈值 Y（构造时置 0，实际值由 `onSceneLoaded` 回调给出）。 */
  deathThresholdY: number;
}

// ── 输入状态 ─────────────────────────────────────────────────

/**
 * 按键状态（主线程键盘映射的产物；Worker 侧不直接消费本对象）。
 *
 * `apps/debug/src/input/keyboard.ts` 维护该对象，位掩码由
 * `src/ts-shared/auth/shared-state.ts` 的 `keysToMask` 换算（那边另有一份同结构声明，掩码值
 * forward 1 / backward 2 / left 4 / right 8 / jump 16 / duck 32 / sprint 64 / reset 128 /
 * wheelJump 256 / yawLeft 512 / yawRight 1024）。其中 `wheelJump` 不在键盘映射表里：它由
 * `apps/debug/src/app.ts` 的滚轮监听器置本帧标记，随后并入掩码。
 */
export interface KeyState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  duck: boolean;
  /** Shift 键：noclip 模式为冲刺倍率；物理模式映射为慢走（走路速度）。 */
  sprint: boolean;
  /** R 键：重生。 */
  reset: boolean;
  /** 滚轮连跳：本帧是否有滚轮产生的 +jump 脉冲（Pointer Lock 锁定时才置位）。 */
  wheelJump: boolean;
  /** Q 键：yaw 左旋。 */
  yawLeft: boolean;
  /** E 键：yaw 右旋。 */
  yawRight: boolean;
}
