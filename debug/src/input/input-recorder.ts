/**
 * 键盘 + 鼠标输入录制 / 确定性回放器（debug 专属；框架无关，无 three/DOM 依赖）。
 *
 * ── 为什么存在（用户明确要求）──────────────────────────────────
 * 用户反复被要求「手动复现 bug 再描述一遍」，这既慢又不可靠。本模块把「复现」变成
 * **一次性录制**：用户录一段输入 → 导出 JSON → 交给开发者 → 开发者在无头浏览器里
 * 逐帧确定性回放，自己复现。**这是产品功能（确定性复现工具链），不是遗留插桩**，
 * 因此 `globalThis.__wsInput` 是**永久公开**的调试 API（见 app.ts 注册处）。
 *
 * ── 录的是什么：`feedInput` 的最终值 ──────────────────────────
 * 每个 rAF 帧记一次**交给 `rendererMain.feedInput(dx, dy, keys)` 的最终值**：
 * 已并入 Q/E 等效鼠标量（`qeDx`）、已并入滚轮跳位（`KEY_MASK.wheelJump`）。
 * 回放时把这三个量**原样覆盖**回同一条 `feedInput` 通道 → 与录制时逐字节同流。
 *
 * **鼠标通道的取舍（重要，勿"修"）**：`mousemove` 事件本可另开一条通道按事件时间
 * 录制，但本录制器**只记 rAF 帧边界上的合并值**（`pendingDx` 增量 + 当帧按键位），
 * 因为（a）录制器挂在输入循环里，语义就是「喂进物理的每帧输入」；（b）事件级时间戳
 * 在回放时不可能同时钟对齐，反而破坏确定性。代价：**回放端 rAF 频率低于录制端时会
 * 丢帧**（一帧跨过多个录制帧 → 只保留最后一个样本）。回放捕获（`captureText()`）会把这个
 * 丢帧数量出来（见 counts().skipped），别猜。
 * 确定性回放（`stepReplay()`，供无头验证用）不丢帧——它按录制帧序列逐帧推进。
 *
 * ── 已验证的承诺边界（无头实测，见 debug/scripts/input-replay-verify.mjs）────
 * **逐帧输入序列**：录制 480 帧 → 换页重载 → 回放再捕获 480 帧，`dx/dy/keys`
 * **逐帧 `===` 完全相同**（帧数也相同）。这是本工具的硬承诺（CI 判据）。
 *
 * **轨迹**：回放起点已做到位级对齐——录制时导出 Rust 种子面全量状态
 * （`physSeed` ← `state_full_json(false)`；9 参 `set_state` 不够，其余承重字段会残留
 * 旧值，实测同页连放两遍 480 帧后位置差 12.9 HU），回放时 `set_state_ex` 写回，
 * **立即回读偏差 0.000e+0 HU**。但轨迹仍**不能逐位复现**：无头实测（脚本用单步闸门
 * 控步，同一种子各推进**恰好 1 个物理步**）两次结果差位置 1.3e-2 HU / 速度 2.1 HU/s
 * ——即"同状态 + 同输入 + 同步长"下引擎输出仍有差异，说明引擎内存在种子面未覆盖的
 * 状态（种子 schema 只覆盖 player / teleport / triggers）。结论：
 *   · 输入流一致性 = **已达成**（可断言、可回归）；
 *   · 轨迹一致性 = **未达成**，且不是回放接线问题（起点位级一致、输入逐帧一致、
 *     引擎单步即分叉）。要真正逐帧复现轨迹，需要把引擎剩余状态纳入种子面，或让整条
 *     物理（含 Worker 权威线）在同一时钟下重演——超出本工具范围。
 * 面板与本模块一律按"输入流确定性复现"表述，**不宣称**轨迹逐位可复现。
 *
 * ── 热路径不分配对象 ──────────────────────────────────────────
 * 录制/回放都在每帧调用，故内部一律用并行 `Float64Array`（t/dx/dy）+ `Int32Array`（keys），
 * 满则翻倍扩容；`{t,dx,dy,keys}` 对象**只在导出/载入时**构造。
 * 容量不设上限（用户明确要求「不限点数」），仅在 20 万帧后每 10 万帧 console.warn 一次。
 */
import type { KeyState } from '../../../src/ts-shared/auth/shared-state.js';

/** 载荷 schema 标识（字符串带版本号，导入时严格校验）。 */
export const INPUT_REPLAY_SCHEMA = 'websurf-debug/input-replay@1';

/** 单帧样本（仅导出/导入/断言用；热路径不产生该对象）。 */
export interface InputFrame {
  /** performance.now()（ms）。录制时 = 该帧输入循环的 now；回放时 = 该帧覆盖发生的时刻。 */
  t: number;
  /** 本帧合并后的鼠标 X 像素增量（已含 Q/E 等效量；物理端 sensitivity 固定 1）。 */
  dx: number;
  /** 本帧合并后的鼠标 Y 像素增量。 */
  dy: number;
  /** 本帧按键位掩码（`src/ts-shared/auth/shared-state.ts` KEY_MASK；含 wheelJump 位）。 */
  keys: number;
}

/** 录制起点的完整玩家状态（回放起点必须与之一致——否则复现不出同一个 bug）。 */
export interface InputReplayInitialState {
  pos: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  vel: { x: number; y: number; z: number };
  onGround: boolean;
}

/** 录制时的碰撞箱（半宽/站高/蹲高，HU）。 */
export interface InputReplayHull {
  halfWidth: number;
  standHeight: number;
  duckHeight: number;
}

/** 单帧覆盖元数据：给回放端对齐世界状态用（少了它复现不出同一个 bug）。 */
export interface InputReplayMeta {
  /** 地图文件名（含 .bsp，如 `surf_666.bsp`）——回放必须用同一张图。 */
  mapFile: string;
  /** 出生点下拉索引；-1 = 未选择（用地图默认出生点）。 */
  spawnIndex: number;
  /**
   * 出生点下拉索引对应的**世界出生点**（HU，脚底中心）。注意这是"世界构建面"的出生点，
   * **不是**录制起点位置——录制起点在 `initialState.pos`（用户可能已经离开出生点）。
   */
  spawnPos: { x: number; y: number; z: number } | null;
  /** 权威物理 tick 率（Hz）。 */
  tickRate: number;
  /** 录制时的物理参数快照（`PARAM_TO_RUST` 键名，含 `autobhop` 等键位行为参数）。 */
  physics: Record<string, unknown>;
  /** 录制时的碰撞箱体型。 */
  hull: InputReplayHull | null;
  /** 录制起点的完整玩家状态（回放起点必须与之一致）。 */
  initialState: InputReplayInitialState | null;
  /**
   * 录制起点的**全量物理种子**（Rust 种子面 v2 JSON，由 `PhysWorld.state_full_json(false)`
   * 导出）。这是回放起点对齐的**权威来源**——9 参 `set_state` 只覆盖 origin/velocity/
   * yaw/pitch/on_ground，其余承重字段（ground_normal / contact_ticks / ducked /
   * ground_ticks_since_landing / teleport cooldown…）会残留旧值，导致"输入逐帧相同、
   * 轨迹仍不可复现"（实测同页连放两遍 480 帧后位置差 12.9 HU）。缺失时回放退化为
   * 部分对齐（`initialState` 仍可用），此时轨迹可能有偏差——报告里如实标注。
   */
  physSeed?: string | null;
  /**
   * 录制时的出生点列表 `[x,y,z,yaw]`（可选；回放端可原样还原 `set_spawn_points`，
   * 使按索引传送/重生在此录制上语义一致）。地图名 + 该列表 = 完整"世界构建面"。
   */
  spawnList?: Array<[number, number, number, number]>;
  /** 输入灵敏度（录制时乘入鼠标增量的系数；回放端若不同需换算）。 */
  sensitivity: number;
  /** 设备像素比（devicePixelRatio）；与 sensitivity 一起决定"同一次甩手转多少度"。 */
  devicePixelRatio: number;
  /** 录制端 rAF 平均帧间隔（ms，仅诊断用）。 */
  meanFrameMs?: number;
  /** 录制起止（ISO 字符串）。 */
  startedAt?: string;
  stoppedAt?: string;
  /** 额外自由字段（app 侧补 href/UA/地图 spawn 列表等）。 */
  [k: string]: unknown;
}

/** 导出载荷。 */
export interface InputReplayPayload {
  schema: typeof INPUT_REPLAY_SCHEMA;
  meta: InputReplayMeta;
  frames: InputFrame[];
}

/** 录制器计数快照。 */
export interface RecorderCounts {
  /** 已录帧数。 */
  frames: number;
  /** 首帧 performance.now()（0 = 尚无样本）。 */
  t0: number;
  /** 末帧 performance.now()。 */
  t1: number;
}

/** 20 万帧后开始告警（约 200fps × 17 分钟；不设上限，仅提醒）。 */
const WARN_FRAMES = 200_000;
/** 告警步长（每满这么多帧再报一次）。 */
const WARN_STEP = 100_000;

/**
 * 输入录制器：热路径零分配（并行 typed array），导出时才物化成对象数组。
 *
 * 时间戳语义（关键，别改成"逐帧累加"）：`record()` 收到的是**本轮 rAF 的 now**，
 * 若两个 rAF 帧之间 `feedInput` 被别的代码路径调用过（极少数同步路径），delta 会被
 * 并入**同一帧样本**（时间 = 本帧 now）——因为物理只在 rAF 里消费 pendingDx，
 * 事件时刻本身不携带物理含义。首帧 t0 = 第一次 record 的 now（不归一化到 0），
 * 导出 JSON 里 `t` 即原始 performance.now()，便于与 path-recorder 导出按时间对齐。
 */
export class InputRecorder {
  private times: Float64Array;
  private dxs: Float64Array;
  private dys: Float64Array;
  private keysArr: Int32Array;
  /** 每帧**实际消费的**物理步长（秒）；0 = 未记录（旧录制，回落到时间戳推导）。 */
  private dts: Float64Array;
  private n = 0;
  private recording = false;
  private nextWarnAt = WARN_FRAMES;
  /**
   * 无条件落样本（**只给回放捕获器用**）：回放期不经过 start() 的 recording 状态，
   * 但"实际喂出去的帧"必须逐帧记下来才能自检。
   */
  private alwaysOn = false;

  constructor(initialCap = 16384) {
    this.times = new Float64Array(initialCap);
    this.dxs = new Float64Array(initialCap);
    this.dys = new Float64Array(initialCap);
    this.keysArr = new Int32Array(initialCap);
    this.dts = new Float64Array(initialCap);
  }

  isRecording(): boolean {
    return this.recording;
  }

  /** 开始录制（**不**清空已有样本——要清空请显式 clear()，便于分段追加后一次导出）。 */
  start(): void {
    this.recording = true;
  }

  /**
   * 开始录制并**同时**锚定起点状态（用户「开始录制」走这条）。
   *
   * 起点锚定不可省：用户按下「开始录制」时玩家可能正在空中/斜坡上滑动，只记
   * 「出生点」回放不出当时那一步（速度/朝向/着地全是当时的瞬时量）。锚定后
   * 回放可把同一状态原样写回物理，从而逐帧复现（`armReplay`）。
   *
   * 会**清空**已有样本：起点唯一，跨段拼接在本 schema 下不可回放（见方法内注释）。
   */
  startWithState(meta: Partial<InputReplayMeta>): void {
    // **必须先清空磁带**：一份录制只有**一个**起点（`meta.initialState` + `meta.physSeed`），
    // 而本方法每次都用**新起点覆盖旧起点**，帧却会继续往后追加。若沿用已有样本，
    // 导出文件就是「第 1 段的帧 + 第 2 段的起点」——回放会从第 2 段的坐标开始播第 1 段
    // 的输入，**从第一帧就错位**；跨段的时间断层还会让首帧 dt 撞上 0.1 clamp。
    // 「连续录多段拼一份」在这种 schema 下不可能成立，故直接以最后一次开始为准。
    this.clear();
    this.stateMeta = meta;
    this.recording = true;
  }

  /** 本次录制锚定的起点元数据（startWithState 传入；导出时并入 meta）。 */
  private stateMeta: Partial<InputReplayMeta> = {};

  /** 导出时的 meta = 调用方传入值 ⊕ 起点锚定值 ⊕ 默认值（后者优先级低）。 */
  private mergedMeta(meta?: Partial<InputReplayMeta>): InputReplayMeta {
    const c = this.counts();
    return {
      mapFile: '',
      spawnIndex: -1,
      spawnPos: null,
      tickRate: 0,
      physics: {},
      hull: null,
      initialState: null,
      physSeed: null,
      sensitivity: 1,
      devicePixelRatio: 1,
      meanFrameMs: this.n > 1 ? round((c.t1 - c.t0) / (this.n - 1), 4) : 0,
      ...this.stateMeta,
      ...meta,
    } as InputReplayMeta;
  }

  /** 停止录制（保留样本）。 */
  stop(): void {
    this.recording = false;
  }

  /**
   * 无条件落样本开关（**回放捕获器专用**；用户录制器永不开）。
   * 用途：回放期逐帧记下"实际喂出去的值"，作为确定性自检的口径。
   */
  setAlwaysOn(on: boolean): void {
    this.alwaysOn = on;
  }

  /** 清空样本 + 计数 + 告警水位（不影响 recording 状态）。 */
  clear(): void {
    this.n = 0;
    this.nextWarnAt = WARN_FRAMES;
  }

  private grow(): void {
    const cap = this.times.length;
    const nt = new Float64Array(cap * 2);
    const nx = new Float64Array(cap * 2);
    const ny = new Float64Array(cap * 2);
    const nk = new Int32Array(cap * 2);
    const nd = new Float64Array(cap * 2);
    nt.set(this.times);
    nx.set(this.dxs);
    ny.set(this.dys);
    nk.set(this.keysArr);
    nd.set(this.dts);
    this.times = nt;
    this.dxs = nx;
    this.dys = ny;
    this.keysArr = nk;
    this.dts = nd;
  }

  /**
   * 记一帧（**只在 recording 时**落样本）。
   *
   * 调用点契约：**必须在 `predPhys.tick` 之前、用本步实际消费的 `(dx, dy, keys)` 调用**
   * （即 `rendererMain.onPhysicsStep`）。挂在输入循环上会漏掉鼠标——鼠标走 mousemove
   * 直连 `feedInput`，一个显示帧内可被调用多次，只有 tick 前那一刻的 `pending*` 才是
   * 本步完整输入。
   * @param nowMs 该物理步的 performance.now()（ms）
   * @param dtS 本步实际步长（秒）；0 = 未记录
   */
  record(nowMs: number, dx: number, dy: number, keys: number, dtS = 0): void {
    if (!this.recording && !this.alwaysOn) return;
    if (this.n >= this.times.length) this.grow();
    const i = this.n++;
    this.times[i] = nowMs;
    this.dxs[i] = dx;
    this.dys[i] = dy;
    this.keysArr[i] = keys | 0;
    this.dts[i] = dtS > 0 ? dtS : 0;
    if (this.n >= this.nextWarnAt) {
      console.warn(
        `[input-recorder] 已录 ${this.n} 帧（约 ${(this.n * 24 / 1048576).toFixed(1)} MB 内存）` +
          `——容量不设上限，但请留意内存；导出 JSON 会再放大数倍。`,
      );
      this.nextWarnAt += WARN_STEP;
    }
  }

  counts(): RecorderCounts {
    return { frames: this.n, t0: this.n ? this.times[0] : 0, t1: this.n ? this.times[this.n - 1] : 0 };
  }

  /** 样本→对象数组（导出/断言用；O(n) 且会分配，别在热路径调）。 */
  frames(): InputFrame[] {
    const out: InputFrame[] = new Array(this.n);
    for (let i = 0; i < this.n; i++) {
      out[i] = { t: this.times[i], dx: this.dxs[i], dy: this.dys[i], keys: this.keysArr[i] };
    }
    return out;
  }

  /**
   * 导出载荷对象（**未** JSON.stringify）。数值已规整：
   * `t` 三位小数（微秒）、`dx/dy` 六位小数、`keys` 整数——保证 `toJson`/`fromJson`
   * 往返后逐位相等（回放序列一致性断言依赖这一点）。
   */
  toPayload(meta?: Partial<InputReplayMeta>): InputReplayPayload {
    const frames: InputFrame[] = new Array(this.n);
    for (let i = 0; i < this.n; i++) {
      frames[i] = {
        t: round(this.times[i], 3),
        dx: round(this.dxs[i], 6),
        dy: round(this.dys[i], 6),
        keys: this.keysArr[i] | 0,
      };
    }
    return { schema: INPUT_REPLAY_SCHEMA, meta: this.mergedMeta(meta), frames };
  }

  /** 导出 JSON 文本（`frames` 用一维紧凑写法，见 toCompactPayload）。 */
  toJson(meta?: Partial<InputReplayMeta>): string {
    return JSON.stringify(this.toCompactPayload(meta), null, 0);
  }

  /**
   * 紧凑载荷：`frames` 拆成 4 个等长并行数组（`t`/`dx`/`dy`/`keys`）。
   *
   * 为什么不用对象数组：一份 10 万帧的录制，对象数组 JSON 约 1.1 万 KB，
   * 并行数组约 4 千 KB（且 `JSON.parse` 后不产生 10 万个对象）。两者都能被 `fromJson`
   * 读入（对象数组格式同样接受），导出**只写**紧凑格式。
   */
  toCompactPayload(meta?: Partial<InputReplayMeta>): Record<string, unknown> {
    const t = new Array<number>(this.n);
    const dx = new Array<number>(this.n);
    const dy = new Array<number>(this.n);
    const keys = new Array<number>(this.n);
    const dt = new Array<number>(this.n);
    for (let i = 0; i < this.n; i++) {
      t[i] = round(this.times[i], 3);
      dx[i] = round(this.dxs[i], 6);
      dy[i] = round(this.dys[i], 6);
      keys[i] = this.keysArr[i] | 0;
      dt[i] = round(this.dts[i], 6);
    }
    const p = this.toPayload(meta);
    return { schema: p.schema, meta: p.meta, frameCount: this.n, frames: { t, dx, dy, keys, dt } };
  }

  /**
   * 读入载荷（接受紧凑并行数组 **或** 对象数组两种 `frames` 形式）。
   * 读入后 `n` 就位、`recording` 保持 false（载入的回放数据不应被新帧追加污染）。
   * @throws Error 载荷不合法（schema 不符/长度不齐/非有限数）时
   */
  load(payload: unknown): InputReplayPayload {
    const p = payload as {
      schema?: unknown;
      meta?: unknown;
      frames?: unknown;
      frameCount?: unknown;
    };
    if (!p || typeof p !== 'object') throw new Error('输入录制载荷不是对象');
    if (p.schema !== INPUT_REPLAY_SCHEMA) {
      throw new Error(`schema 不符：期望 ${INPUT_REPLAY_SCHEMA}，实际 ${String(p.schema)}`);
    }
    const meta = (p.meta ?? {}) as InputReplayMeta;
    const f = p.frames as unknown;
    let n = 0;
    if (Array.isArray(f)) {
      n = f.length;
      this.ensure(n);
      for (let i = 0; i < n; i++) {
        const fr = f[i] as InputFrame;
        this.setAt(i, fr.t, fr.dx, fr.dy, fr.keys, (fr as { dt?: unknown }).dt ?? 0);
      }
    } else if (f && typeof f === 'object') {
      const c = f as { t?: unknown; dx?: unknown; dy?: unknown; keys?: unknown; dt?: unknown };
      if (!Array.isArray(c.t) || !Array.isArray(c.dx) || !Array.isArray(c.dy) || !Array.isArray(c.keys)) {
        throw new Error('frames 紧凑格式缺字段（需 t/dx/dy/keys 四个数组）');
      }
      n = c.t.length;
      if (c.dx.length !== n || c.dy.length !== n || c.keys.length !== n) {
        throw new Error(`frames 四数组长度不齐（t=${n} dx=${c.dx.length} dy=${c.dy.length} keys=${c.keys.length}）`);
      }
      this.ensure(n);
      for (let i = 0; i < n; i++) {
        this.setAt(i, c.t[i] as number, c.dx[i] as number, c.dy[i] as number, c.keys[i] as number, Array.isArray(c.dt) ? c.dt[i] : 0);
      }
    } else {
      throw new Error('frames 缺失或类型错误');
    }
    this.n = n;
    this.recording = false;
    const declared = typeof p.frameCount === 'number' ? p.frameCount : n;
    if (declared !== n) throw new Error(`frameCount=${declared} 与 frames 实际长度 ${n} 不符`);
    return { schema: INPUT_REPLAY_SCHEMA, meta, frames: this.frames() };
  }

  /** 从 JSON 文本载入（`load` 的便捷包装）。 */
  fromJson(text: string): InputReplayPayload {
    return this.load(JSON.parse(text));
  }

  private ensure(n: number): void {
    if (n <= this.times.length) return;
    let cap = this.times.length;
    while (cap < n) cap *= 2;
    this.times = new Float64Array(cap);
    this.dxs = new Float64Array(cap);
    this.dys = new Float64Array(cap);
    this.keysArr = new Int32Array(cap);
    this.dts = new Float64Array(cap);
  }

  private setAt(i: number, t: unknown, dx: unknown, dy: unknown, keys: unknown, dt: unknown = 0): void {
    const tt = Number(t);
    const xx = Number(dx);
    const yy = Number(dy);
    const kk = Number(keys);
    if (!Number.isFinite(tt) || !Number.isFinite(xx) || !Number.isFinite(yy) || !Number.isFinite(kk)) {
      throw new Error(`第 ${i} 帧含非有限数（t=${String(t)} dx=${String(dx)} dy=${String(dy)} keys=${String(keys)}）`);
    }
    const dd = Number(dt);
    this.dts[i] = Number.isFinite(dd) && dd > 0 ? dd : 0;
    this.times[i] = tt;
    this.dxs[i] = xx;
    this.dys[i] = yy;
    this.keysArr[i] = kk | 0;
  }
}

/** 读数保留 d 位小数（导出规整；往返一致性依赖它）。 */
function round(v: number, d: number): number {
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

/** 回放状态（面板状态行用）。 */
export interface PlayerState {
  playing: boolean;
  /** 已消费的样本下标（-1 = 一帧未放）。 */
  index: number;
  /** 总样本数。 */
  total: number;
  /** 实时回放丢掉的样本数（一帧跨多帧；确定性回放恒 0）。 */
  skipped: number;
}

/**
 * 回放器：按录制时间戳把样本原样喂回输入循环。
 *
 * 两种推进方式：
 * - `step()`：**确定性**逐帧推进，帧号 = 录制帧号 → 逐帧覆盖值序列与录制**完全相同**
 *   （无头验证走这条；见 `debug/scripts/input-replay-verify.mjs`）。
 * - `next(nowMs)`：**实时**推进（按墙钟）。录制端 rAF 高于回放端时会丢样本（一帧跨多帧），
 *   少数情况下会丢按键边沿——这是"回放端不够快"的固有代价，`counts().skipped` 会报出来。
 *
 * 时间语义：`t` 只用于**选择样本**，不作为物理 dt；物理 dt 由录制帧间隔提供
 * （`frameDt()`），回放时覆盖渲染主循环 dt → 轨迹也可复现（见 app.ts 回放分支）。
 */
export class InputPlayer {
  private times = new Float64Array(0);
  private dxs = new Float64Array(0);
  private dys = new Float64Array(0);
  private keysArr = new Int32Array(0);
  /** 每帧实际消费的物理步长（秒）；0 = 旧录制未记（`frameDt` 回落到时间戳推导）。 */
  private dts = new Float64Array(0);
  private n = 0;
  private i = -1;
  private playing = false;
  private skippedFrames = 0;
  private meta: Partial<InputReplayMeta> = {};
  /** 样本时钟模式（`step()` 置 true；`playRealtime()` 置 false）。 */
  private sampleClock = false;

  /** 读入载荷（与 `InputRecorder.load` 同一解析器；这里只保留样本）。 */
  load(payload: unknown): void {
    const tmp = new InputRecorder(1024);
    const parsed = tmp.load(payload);
    this.fromRecorder(tmp, parsed.meta);
  }

  /** 从 JSON 文本读入。 */
  fromJson(text: string): void {
    this.load(JSON.parse(text));
  }

  /** 从已有录制器接管样本（不拷贝对象：直接搬 typed array 引用）。 */
  private fromRecorder(rec: InputRecorder, meta: Partial<InputReplayMeta>): void {
    const raw = rec as unknown as {
      times: Float64Array;
      dxs: Float64Array;
      dys: Float64Array;
      keysArr: Int32Array;
      dts: Float64Array;
      n: number;
    };
    this.times = raw.times;
    this.dxs = raw.dxs;
    this.dys = raw.dys;
    this.keysArr = raw.keysArr;
    this.dts = raw.dts ?? new Float64Array(raw.n);
    this.n = raw.n;
    this.meta = meta;
    this.i = -1;
    this.playing = false;
    this.skippedFrames = 0;
  }

  /** 录制器 → 回放器（同一进程内"录完立刻回放"用；样本按引用接管，不复制）。 */
  adopt(rec: InputRecorder, meta?: Partial<InputReplayMeta>): void {
    this.fromRecorder(rec, meta ?? {});
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /** 覆盖元数据（回放前由 app 侧填入地图/参数等）。 */
  getMeta(): Partial<InputReplayMeta> {
    return this.meta;
  }

  /** 开始回放：把游标复位到"尚未消费任何样本"（等价于 seekTo(0) 的语义）。 */
  start(): void {
    this.i = -1;
    this.skippedFrames = 0;
    this.playing = this.n > 0;
  }

  /**
   * 实时播放（按墙钟推进；`next(performance.now())` 用）。
   * 用户点「载入并回放」走这条；帧率低于录制端时会丢样本（`next` 累加 skipped）。
   */
  playRealtime(): void {
    this.sampleClock = false;
    this.start();
  }

  /**
   * 确定性回放（帧号 = 录制帧号）。用户面板与无头验证默认走这条——这是**唯一**能
   * 保证逐帧覆盖值与录制**完全相同**的推进方式（实时推进会因帧率差丢样本）。
   */
  playDeterministic(): void {
    this.sampleClock = true;
    this.start();
  }

  /** 当前是否样本时钟模式（播放前调用；默认 false）。 */
  isSampleClock(): boolean {
    return this.sampleClock;
  }

  /** 切换到实时墙钟模式（不重置游标）。 */
  setRealtime(): void {
    this.sampleClock = false;
  }

  /**
   * 样本时钟下的"当前时间"：= 下一个待消费样本的时间戳 − ε。
   *
   * 语义：`next(now)` 取 `t < now` 的最后一个样本，故喂一个"刚好还没跨过下一帧"的
   * 时间，就恰好消费下一帧；物理 dt 另由 `frameDt()` 提供（`t` 只用于选帧，
   * 不参与 dt 计算）。这样"帧号 ↔ 录制帧号"严格一一对应，是确定性回放的骨架。
   */
  sampleNow(epsilonMs = 1e-6): number {
    if (this.n === 0) return 0;
    if (this.i < 0) return this.times[0];
    const next = this.i + 1;
    if (next >= this.n) return Number.POSITIVE_INFINITY;
    return this.times[next] - epsilonMs;
  }

  stop(): void {
    this.playing = false;
  }

  /** 回到第 0 帧之前（下一帧 `step()`/`next()` 返回第 0 个样本）。 */
  seekTo(frame: number): void {
    if (frame !== 0) return; // 本工具的复现口径是"从起点整段放"，不支持跳到中间
    this.i = -1;
    this.skippedFrames = 0;
  }

  state(): PlayerState {
    return { playing: this.playing, index: this.i, total: this.n, skipped: this.skippedFrames };
  }

  /**
   * 当前时间对应的样本。
   *
   * - **实时模式**（`playRealtime()`）：取录制时间戳 `t < nowMs` 的最后一个样本，
   *   在下一个时间戳到来前**保持**它（游标随墙钟前进；跨帧 = 丢样本，累加 `skipped`）；
   *   超过末帧后返回 `null`（绝不外推）。
   * - **样本时钟模式**（`playDeterministic()`）：**不自己推游标**——游标只由
   *   `step()`/`stepReplay()` 推进（一帧一步）。若这里也推进，就会变成"每帧走两步"，
   *   每个样本被喂出两次（实测：480 帧录制 → 959 帧回放）。保持语义：调用两次返回同一
   *   样本，直到调用方推进。
   * @param nowMs performance.now()（ms；样本时钟模式下忽略，内部用 `sampleNow()`）
   */
  next(nowMs: number): InputFrame | null {
    if (!this.playing || this.n === 0) return null;
    // 「保持当前帧」**只对样本时钟成立**。此处原先没有 sampleClock 守卫地提前返回，
    // 使下面整段实时推进变成死代码——实时回放同样永远只放第 0 帧。
    if (this.sampleClock) {
      if (this.i < 0) {
        this.i = 0;
        return this.sample(0);
      }
      return this.sample(Math.min(this.i, this.n - 1));
    }
    const now = nowMs;
    if (this.i < 0) {
      if (this.times[0] > now) return null;
      this.i = 0;
      return this.sample(0);
    }
    if (this.i + 1 >= this.n) return this.sample(this.i); // 末帧：保持到 stop（不外推）
    let k = this.i;
    while (k + 1 < this.n && this.times[k + 1] < now) k++;
    if (k > this.i) this.skippedFrames += k - this.i;
    this.i = k;
    return this.sample(k);
  }

  /**
   * **确定性**推进一帧（帧号 = 录制帧号），返回样本 + 本帧步长 + 游标。
   *
   * 无头验证与「确定性回放」都由它驱动：调用方每帧调一次，把 `frame` 交给
   * `feedInput`、把 `dtS` 交给渲染主循环的 dt 覆盖（`rendererMain.replayDtS`）。
   * @param defaultDtS 首帧步长（录制首帧没有"上一帧间隔"；ABBA 模式下录制与回放
   *                   都用同一个默认值，故仍逐帧一致）
   */
  stepReplay(defaultDtS = 1 / 64): {
    frame: InputFrame | null;
    dtS: number;
    index: number;
    total: number;
    done: boolean;
  } {
    const f = this.step();
    return {
      frame: f,
      dtS: this.frameDt(defaultDtS),
      index: this.i,
      total: this.n,
      done: this.i + 1 >= this.n,
    };
  }

  /**
   * **确定性**推进一帧（帧号 = 录制帧号）。
   * @returns 本帧样本；已到末尾返回 `null`（不回绕、不重复）
   */
  step(): InputFrame | null {
    if (this.n === 0 || this.i + 1 >= this.n) return null;
    this.i++;
    return this.sample(this.i);
  }

  /**
   * 本帧对应的物理 dt（秒）：= 录制帧间隔（`t[i] - t[i-1]`）；首帧用 `defaultDt`。
   * 回放时用它覆盖渲染主循环 dt → 轨迹也可复现（否则回放端帧步长不同，输入虽同、
   * 轨迹必分叉——实测见交付报告）。
   */
  frameDt(defaultDt: number): number {
    // 首帧没有「前一帧」，若回落到调用方的 defaultDt（1/64 = 15.6ms），而录制实际按
    // rAF 频率（~3.1ms）落帧，则首步 dt 偏大 5 倍——这是回放机上不可复现的量
    // （真值取决于 arm 时刻距上一次渲染 tick 多久），会让「同一录制连放两遍」必然分叉。
    // 首帧改用「后向间隔」t[1]-t[0]：与邻帧同分布，量级正确，且完全由录制决定。
    const i = this.i;
    // 首选**录制时记下的实际步长**（`onPhysicsStep` 给的 dt）——那才是物理真正用过的值。
    // 时间戳推导对首帧无解（会话中途开始录制时，首帧 dt 取决于此前的 lastTickMs），
    // 且会被历史上的 0.1 clamp 污染。
    if (i >= 0 && i < this.n) {
      const rec = this.dts[i];
      if (Number.isFinite(rec) && rec > 0) return Math.min(rec, 0.1);
    }
    const a = i <= 0 ? this.times[0] : this.times[i - 1];
    const b = i <= 0 ? this.times[Math.min(1, this.n - 1)] : this.times[i];
    const dt = (b - a) / 1000;
    if (!Number.isFinite(dt) || dt <= 0) return defaultDt;
    return Math.min(dt, 0.1);
  }

  /** 回放健康度（丢帧/样本总数/是否放完）。 */
  counts(): { total: number; index: number; skipped: number; exhausted: boolean } {
    return { total: this.n, index: this.i, skipped: this.skippedFrames, exhausted: this.i + 1 >= this.n };
  }

  /** 已放完（或未开始）→ 调用方应停止回放并交还设备输入。 */
  isExhausted(): boolean {
    return this.i + 1 >= this.n;
  }

  private sample(i: number): InputFrame {
    return { t: this.times[i], dx: this.dxs[i], dy: this.dys[i], keys: this.keysArr[i] };
  }
}

/**
 * 把掩码换算成 `KeyState` 布尔对象（诊断/断言用；与 `maskToKeys` 等价但本模块自足）。
 * 键位语义见 shared-state.ts KEY_MASK。
 */
export function keysFromMask(mask: number): KeyState {
  return {
    forward: (mask & 1) !== 0,
    backward: (mask & 2) !== 0,
    left: (mask & 4) !== 0,
    right: (mask & 8) !== 0,
    jump: (mask & 16) !== 0,
    duck: (mask & 32) !== 0,
    sprint: (mask & 64) !== 0,
    reset: (mask & 128) !== 0,
    wheelJump: (mask & 256) !== 0,
    yawLeft: (mask & 512) !== 0,
    yawRight: (mask & 1024) !== 0,
  };
}

/**
 * **确定性自检**（回放逐帧值序列 vs 录制逐帧值序列）。
 *
 * 判定口径：三通道（dx/dy/keys）**逐帧严格相等**（`===`，不是容差比较）。
 * `t` 不参与比较——回放端时间戳必然不同（这正是需要断言"值"而不是"时间"的原因）；
 * 帧数不等即失败（丢帧/多帧都要报出来，不许掩盖）。
 */
export function compareFrames(
  recorded: readonly InputFrame[],
  replayed: readonly InputFrame[],
): { identical: boolean; compared: number; firstMismatch: number; diffs: string[] } {
  const n = Math.min(recorded.length, replayed.length);
  let firstMismatch = -1;
  const diffs: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = recorded[i];
    const b = replayed[i];
    if (a.dx !== b.dx || a.dy !== b.dy || a.keys !== b.keys) {
      if (firstMismatch < 0) firstMismatch = i;
      if (diffs.length < 8) {
        diffs.push(
          `#${i}: rec(dx=${a.dx},dy=${a.dy},keys=${a.keys}) vs play(dx=${b.dx},dy=${b.dy},keys=${b.keys})`,
        );
      }
    }
  }
  const identical = firstMismatch < 0 && recorded.length === replayed.length;
  if (recorded.length !== replayed.length) {
    diffs.push(`帧数不等：录制 ${recorded.length} vs 回放 ${replayed.length}`);
  }
  return { identical, compared: n, firstMismatch, diffs };
}
