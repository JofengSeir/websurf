/**
 * 消息协议类型声明：主线程 ↔ debug Worker。
 *
 * 本文件只有 `interface` 与 `type` 声明，编译后不产生运行时代码；两侧以消息的字符串
 * `type` 字段分发，故字段形状在这里是声明面契约，运行时由发送端与接收端各自断言。
 *
 * 与共享层的关系（2026-11-18）：两端同形、且由共享分派器消费的消息统一声明在
 * `src/ts-shared/auth/worker-protocol-types.ts`；本文件只 `import type` + `re-export`
 * 保留既有导出名，不再重复声明。留在本文件的是 **debug 端独有** 消息（物理面板、
 * 视距剔除、扫描数据）与 **Worker → 主线程 / 主线程本地结构**（`PlaneInfo`、
 * `SceneDataMessage`、`KeyState` 等）。
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
 *
 * 协议版本：任一消息的 `type` 字面量或字段语义增删改 ⇒ 同步把
 * `src/ts-shared/auth/worker-protocol.ts` 的 `WORKER_PROTOCOL` +1（旧 `web/worker.js`
 * 无握手会静默忽略新消息；2026-11-17 事故）。
 */

import type {
  AddVelocityMessage,
  ConfigMessage,
  InitMessage,
  InputMessage,
  RespawnMessage,
  SetDeathThresholdMessage,
  SetJumpHeightMessage,
  SetPlayerNameMessage,
  SetPushVelocityMessage,
  SetSpeedCapMessage,
  SetSpawnPointsMessage,
  SyncRenderStateMessage,
  TeleportMessage,
  TeleportToPosMessage,
  WasmInitMessage,
  WorldBinMessage,
  WorldJsonMessage,
} from '../../../../src/ts-shared/auth/worker-protocol-types.js';

/** 两端同形的协议消息：共享层是唯一权威，此处原样 re-export 既有导出名。 */
export type {
  AddVelocityMessage,
  ConfigMessage,
  InitMessage,
  InputMessage,
  RespawnMessage,
  SetDeathThresholdMessage,
  SetJumpHeightMessage,
  SetPlayerNameMessage,
  SetPushVelocityMessage,
  SetSpeedCapMessage,
  SetSpawnPointsMessage,
  SyncRenderStateMessage,
  TeleportMessage,
  TeleportToPosMessage,
  WasmInitMessage,
  WorldBinMessage,
  WorldJsonMessage,
};

// ── 主线程 → Worker（debug 端独有消息）───────────────────────

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
 * `apps/debug/src/renderer/renderer-main.ts` 的 `setCullDistance`（夹取后交共享会话
 * `RenderSession.setCullDistance`）执行。
 */
export interface SetCullDistanceMessage {
  type: 'set-cull-distance';
  value: number;
}

/** 主线程 → Worker 的消息类型（24 项）。运行时另有 `set-mode` 与 `set-hold` 两条被
 *  分发层处理的消息（共享类型面已给出，见 `worker-protocol-types.ts`），本联合未收录。 */
export type WorkerMessage =
  | WasmInitMessage
  | InitMessage
  | InputMessage
  | WorldJsonMessage
  | WorldBinMessage
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
  | SetDeathThresholdMessage
  | SetPlayerNameMessage
  | AddVelocityMessage
  | SetPushVelocityMessage
  | SetSpeedCapMessage
  | SetJumpHeightMessage;

// ── Worker → 主线程 ──────────────────────────────────────────

/** 就绪回执：由共享 `worker-runtime` 的 `onInit` 钩子自动发出（`makeReadyMessage()`）；
 *  主线程经 `handleWorkerReady` 校验后更新状态栏提示。 */
export interface ReadyMessage {
  type: 'ready';
  /**
   * Worker 构建时的消息协议版本（见 `src/ts-shared/auth/worker-protocol.ts`）。
   * 旧构建的 `web/worker.js` 不会带这个字段；主线程据此在状态栏告警，
   * 避免「app.js 新、worker.js 旧」时静默跑错行为（2026-11-17 事故）。
   */
  protocol?: number;
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

/** 权威健康告警：由共享 `worker-runtime` 的 `postHealth` 发出，文本前缀
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
   * - 'mesh'：GLB 场景射线命中（取最近交点；`meshName` 取自命中的**来源几何**节点名——块 mesh
   *   由分块合并新建、本身无名，名字按 `faceIndex` 从合并来源区间表反查；该表也查不到时读
   *   mesh 自己的 `name`，仍为空则写 `(unnamed mesh)`），`planeDist` 为 null、`brushIndex` 为 -1；
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
  /** 命中的来源几何名（装载期由 GLTFLoader 按 GLB 网格名赋值：BSP 世界面的 glTF 网格无名，
   *  故名为 `mesh_<网格下标>`，重名再加 `_序号`，如 `mesh_12`、`mesh_12_33321`；模型网格有名字，
   *  如 `666_clip`）。块 mesh 是合并新建的、本身无名，该值由合并来源区间表按 `faceIndex` 给出。 */
  meshName?: string;
  /** 材质名（取不到的来源几何/未合并 mesh 上为空串）。 */
  materialName?: string;
  /** 来源 primitive 的 BSP 面序号（GLB extras `faceIndex`；取不到时为 null）。 */
  bspFace?: number | null;
  /** 命中三角形在该来源 primitive 内的序号（取不到时为 -1）。 */
  sourceTri?: number;
  /** 纹理名（同上）。 */
  textureName?: string;
  /** 材质属性标记（来源几何没有合并元数据时整体为 undefined）。 */
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
  /** `.phy` 凸体的生成补面 JSON（`export_model_phy_bevels`；只服务第六路线框显示，缺省即不带）。 */
  phyBevelsJson?: string;
  /** 纹理画质 manifest：`{ 纹理名(小写 basetexture): mosaic 字节码 }` JSON。 */
  mosaicManifest?: string;
  /** 缺失材质纹理列表（VMT/VTF 缺失 → 走占位色）。 */
  missingTextures?: string[]; skyboxTexture?: import('three').CubeTexture | null; fogParams?: { color: number; start: number; end: number; maxDensity: number } | null; skyCamera?: { origin: [number, number, number]; scale: number; fog?: { enable: boolean; color: number; start: number; end: number } | null } | null;
  spawnJson: string;
  pvsJson: string;
  teleportJson: string;
  /**
   * Source 实体 I/O 无损数据（`buildWorldBundle` 的 `entityIoJson`）。
   * 渲染主线程据此装配通用 `EntitySystem`；wasm 未重建时缺省 ⇒ 不启用新运行期。
   */
  entityIoJson?: string;
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
