/**
 * 键盘 + 鼠标输入录制 / 回放器（debug 专属；不 import three、不碰 DOM）。
 *
 * ── 定位与上下游 ──────────────────────────────────────────────
 * 本模块只有数据结构与取值逻辑：不挂事件监听、不读任何全局对象，全部接线在
 * `apps/debug/src/app.ts`。
 * - 写入侧（唯一）：`apps/debug/src/app.ts` 的输入循环在回放分支里调
 *   `replayCapture.record(now, finalDx, finalDy, finalKeys)`，记的是该帧实际要喂出去的值；
 *   同一分支随后把这三个量交给 `apps/debug/src/renderer/renderer-main.ts` 的 `feedInput`。
 *   该调用点省略 `dtS`，故写进样本的步长恒为 0。
 * - 读取侧：`apps/debug/src/app.ts` 的 `armReplay` 用 meta 对齐起点，输入循环把样本交回
 *   `feedInput`，并把 `frameDt` 的结果写进 `apps/debug/src/renderer/renderer-main.ts` 的
 *   `replayDtS`（渲染主循环消费一次后置 null）。
 * - 无头验收：`apps/debug/scripts/input-replay-verify.mjs` 经 `globalThis.__wsInput`
 *   （注册在 `apps/debug/src/app.ts`）驱动录制 / 导出 / 载入 / 逐帧回放 / 捕获。
 * - 载入侧只认本模块自己的 schema 字符串，不做版本迁移。
 *
 * ── 录的是什么：调用方给的值 ──────────────────────────────────
 * `record(nowMs, dx, dy, keys, dtS)` 的五个入参全部由调用方给，本模块不自行采样：
 * - `dx`/`dy` 是合并后的鼠标像素增量。输入循环非回放分支里的值只含 Q/E 等效量
 *   （`src/ts-shared/input/input-layer.ts` 的 `qeEquivalentDx`）；`mousemove` 直连
 *   `feedInput` 那条路径的值是原始增量乘灵敏度（同文件的 `layerMouseDelta`），不含 Q/E。
 * - `keys` 是按键位掩码，位定义见 `src/ts-shared/auth/shared-state.ts` 的 `KEY_MASK`；
 *   滚轮跳位（`wheelJump`）只在输入循环里并入。
 * - `dtS`（秒）大于 0 才写入，否则写 0；0 在 `frameDt` 里表示「未记录」。
 * 回放时 `InputPlayer` 把样本里的 `dx`/`dy`/`keys` 原样返回，不重新解释。
 *
 * ── 存储形态与容量 ────────────────────────────────────────────
 * 热路径不建对象：每样本写五个并行数组（`Float64Array` 的 t / dx / dy / dt 与
 * `Int32Array` 的 keys），即每样本 4×8 + 4 = 36 字节；满则 `grow` 整体翻倍。
 * `{t,dx,dy,keys}` 对象只在 `frames` / `toPayload` / `sample` 里物化。
 * 容量不设上限：样本数到 `WARN_FRAMES` 起，每满 `WARN_STEP` 帧 `console.warn` 一次。
 *
 * ── 边界与失败语义 ────────────────────────────────────────────
 * - 丢帧只发生在墙钟推进路径：`InputPlayer.next` 按时间戳跳过样本并把跨过的帧数累加进
 *   `skippedFrames`，`InputPlayer.step` / `stepReplay` 每次只前进一帧、不跳样本。
 *   跳过数由 `InputPlayer.counts` / `InputPlayer.state` 报出，`apps/debug/src/app.ts`
 *   再经 `__wsInput.counts().skipped` 暴露；导出的载荷里没有这个字段。
 * - 起点对齐分两档，由 `apps/debug/src/app.ts` 的 `armReplay` 决定：`meta.physSeed`
 *   非空时用全量种子写回（`set_state_ex`），否则退化为 `meta.initialState` 的部分对齐。
 *   本模块只负责原样存取 meta，不判断对齐质量。
 * - 载入失败一律抛错：载荷非对象、schema 不符、紧凑格式缺字段、四数组长度不齐、
 *   某帧含非有限数、`frameCount` 与实际帧数不符（错误文案见 `load`）。
 * - 两个类的 `load` 都会改写自身样本：`InputRecorder.load` 抛出前就已把新样本写进数组，
 *   `InputPlayer.load` 先解析进临时录制器、成功后才接管，抛错时自身样本不变。
 */
import type { KeyState } from '../../../../src/ts-shared/auth/shared-state.js';

/** 载荷 schema 标识；`InputRecorder.load` 与 `apps/debug/src/app.ts` 的 `loadPlaybackFromJson` 都要求载荷的 `schema` 与之严格相等，不等即抛错。 */
export const INPUT_REPLAY_SCHEMA = 'websurf-debug/input-replay@1';

/** 单帧样本（只在导出、载入返回值与回放返回时物化；热路径不产生该对象）。 */
export interface InputFrame {
  /** 样本时间戳（ms）：由写入方的 `nowMs` 原样给定（本仓调用点传输入循环的 rAF 时间戳），载入时取自载荷。 */
  t: number;
  /** 本帧鼠标 X 像素增量。回放时原样取出，不重新解释。 */
  dx: number;
  /** 本帧鼠标 Y 像素增量；来源同 `dx`。 */
  dy: number;
  /** 本帧按键位掩码（位定义见 `src/ts-shared/auth/shared-state.ts` 的 `KEY_MASK`）。 */
  keys: number;
}

/** 录制起点的玩家状态；`apps/debug/src/app.ts` 的 `armReplay` 在缺全量种子时用它做部分对齐。 */
export interface InputReplayInitialState {
  /** 脚底中心坐标（与 `PhysWorld.state()` 的 posX/posY/posZ 同值）。 */
  pos: { x: number; y: number; z: number };
  /** 水平朝向（`PhysWorld.state()` 的 yaw 原值，本模块不做换算）。 */
  yaw: number;
  /** 俯仰（`PhysWorld.state()` 的 pitch 原值）。 */
  pitch: number;
  /** 速度分量（`PhysWorld.state()` 的 velX/velY/velZ 原值）。 */
  vel: { x: number; y: number; z: number };
  /** 该时刻是否着地（`PhysWorld.state()` 的 onGround）。 */
  onGround: boolean;
}

/** 录制时的碰撞箱体型；取自 `apps/debug/src/renderer/renderer-main.ts` 的 `captureReplayState`（即 `config.player` 的 `radius` / `standHeight` / `duckHeight`）。 */
export interface InputReplayHull {
  /** 半宽（`config.player.radius`）。 */
  halfWidth: number;
  /** 站立高度（`config.player.standHeight`）。 */
  standHeight: number;
  /** 蹲下高度（`config.player.duckHeight`）。 */
  duckHeight: number;
}

/** 录制元数据：回放端对齐世界状态与起点所需的全部量。 */
export interface InputReplayMeta {
  /** 录制端写当前地图名（`apps/debug/src/app.ts` 的 `teleportMapName`，值为 BSP 文件名）；面板载入 JSON 时用文件名去掉 `.json` 后缀覆盖它。回放端只把它与当前地图名比较，不一致仅告警、不阻断。 */
  mapFile: string;
  /** 出生点下拉的选中索引；无下拉控件或值非有限数时为 -1。 */
  spawnIndex: number;
  /** `spawnIndex` 对应出生点的前三个分量（`loadedSpawnList[spawnIndex]`）；索引为负或越界时为 null。它是世界出生点，不是录制起点位置。 */
  spawnPos: { x: number; y: number; z: number } | null;
  /** 录制时的面板物理 tick 率（`config.physics.tickRate`）。 */
  tickRate: number;
  /** 录制时的物理参数快照，键名见 `apps/debug/src/physics/physics-params.ts` 的 `PARAM_TO_RUST`；回放时 `armReplay` 用它调 `setPredictionParams` 与 `inputBridge.sendConfig`。 */
  physics: Record<string, unknown>;
  /** 录制时的碰撞箱体型；回放时 `armReplay` 写回渲染物理与 Worker 两端。 */
  hull: InputReplayHull | null;
  /** 录制起点的玩家状态（`rendererMain.captureReplayState` 的 `state`）。 */
  initialState: InputReplayInitialState | null;
  /**
   * 录制起点的全量物理种子（Rust 种子面 JSON）：`renderer-main` 的 `captureFullPhysState`
   * 调 `PhysWorld.state_full_json(false)`（事件槽不导出），写入 `PhysWorld.set_state_ex`。
   *
   * 回放侧 `armReplay` 优先用它调 `restoreFullPhysState`（返回 false 或字段缺失时）才回退到
   * `initialState` 的 9 参部分对齐。
   */
  physSeed?: string | null;
  /**
   * 录制时的出生点列表 `[x,y,z,yaw]`（`loadedSpawnList`）。
   * 本仓只有导出侧写入点；回放侧 `armReplay` 不读该字段。
   */
  spawnList?: Array<[number, number, number, number]>;
  /** 录制时的输入灵敏度（`config.input.sensitivity`）；由 `layerMouseDelta` 乘进鼠标增量。本模块的回放路径不读该字段。 */
  sensitivity: number;
  /** 录制时的 `window.devicePixelRatio`。本仓只有写入点，无读取点。 */
  devicePixelRatio: number;
  /** 导出时算出的平均帧间隔（ms）：`(t1 - t0) / (n - 1)`，样本数 ≤ 1 时为 0，保留 4 位小数。 */
  meanFrameMs?: number;
  /** 录制开始时刻（ISO 字符串）。 */
  startedAt?: string;
  /** 导出/捕获时刻（ISO 字符串）：面板与 `__wsInput.exportJson` 传 `stoppedAt`，`__wsInput.captureText` 传 `capturedAt`。 */
  stoppedAt?: string;
  /** 未在上面列出的自由字段原样保留（`apps/debug/src/app.ts` 的 `buildReplayMeta` 额外写 `href`）。 */
  [k: string]: unknown;
}

/** 导出/载入载荷。对象数组形式由 `toPayload` 产出；`toCompactPayload` / `toJson` 产出并行数组形式（字段见该方法）。 */
export interface InputReplayPayload {
  /** 恒等于 `INPUT_REPLAY_SCHEMA`（载入时校验）。 */
  schema: typeof INPUT_REPLAY_SCHEMA;
  /** 由 `mergedMeta` 合并（默认值 < 起点锚定值 < 调用方传入值）。 */
  meta: InputReplayMeta;
  /** 对象数组形式的样本。 */
  frames: InputFrame[];
}

/** 录制器计数快照。 */
export interface RecorderCounts {
  /** 已落样本数。 */
  frames: number;
  /** 首个样本的时间戳；无样本时为 0。 */
  t0: number;
  /** 末个样本的时间戳；无样本时为 0。 */
  t1: number;
}

/** 样本数达到该值时触发第一次告警；不设上限，仅提醒。 */
const WARN_FRAMES = 200_000;
/** 告警水位递增量：每次告警后 `nextWarnAt += WARN_STEP`。 */
const WARN_STEP = 100_000;

/**
 * 输入录制器：热路径零分配（五个并行 typed array），导出时才物化成对象数组。
 *
 * 样本写入的唯一入口是 `record`；`start` / `startWithState` 只切换 `recording` 标志，
 * `alwaysOn` 为真时 `record` 无视该标志落样本。
 *
 * 时间戳不做归一化：`t` 原样保存调用方给的 `nowMs`，`counts` 的 `t0` / `t1` 即首末样本的
 * 该值，`mergedMeta` 的 `meanFrameMs` 由 `(t1 - t0) / (n - 1)` 算出。同一帧内多次 `record`
 * 各自成为独立样本，本类不做去重或合并。
 */
export class InputRecorder {
  /** 各样本的时间戳（ms）。 */
  private times: Float64Array;
  /** 各样本的鼠标 X 像素增量。 */
  private dxs: Float64Array;
  /** 各样本的鼠标 Y 像素增量。 */
  private dys: Float64Array;
  /** 各样本的按键位掩码（写入时 `| 0` 归一为 int32）。 */
  private keysArr: Int32Array;
  /** 各样本的物理步长（秒）；写入时非有限或 ≤ 0 一律记为 0，0 表示「未记录」。 */
  private dts: Float64Array;
  /** 已落样本数，同时是下一个写入下标。 */
  private n = 0;
  /** `record` 的两个落样本条件之一（另一个是 `alwaysOn`）。 */
  private recording = false;
  /** 下一次告警的样本数水位（`clear` 复位为 `WARN_FRAMES`）。 */
  private nextWarnAt = WARN_FRAMES;
  /**
   * 无条件落样本开关：为真时 `record` 不看 `recording`。
   * `apps/debug/src/app.ts` 只对回放捕获器 `replayCapture` 置 true，用户录制器 `inputRecorder` 保持 false。
   */
  private alwaysOn = false;

  /** 按 `initialCap` 分配五个并行数组（默认 16384）。 */
  constructor(initialCap = 16384) {
    this.times = new Float64Array(initialCap);
    this.dxs = new Float64Array(initialCap);
    this.dys = new Float64Array(initialCap);
    this.keysArr = new Int32Array(initialCap);
    this.dts = new Float64Array(initialCap);
  }

  /** `recording` 标志；不含 `alwaysOn`，故 `alwaysOn=true` 的捕获器回读恒为 false。 */
  isRecording(): boolean {
    return this.recording;
  }

  /** 打开落样本开关。不清空已有样本（清空见 `clear`），不改 `alwaysOn`。 */
  start(): void {
    this.recording = true;
  }

  /**
   * 开始录制并同时锚定起点元数据（`apps/debug/src/app.ts` 的 `startRecording` 走这条）。
   *
   * 先 `clear` 再写 `stateMeta`、置 `recording = true`。清空不可省：一份载荷只有**一个**
   * 起点（`meta.initialState` 与 `meta.physSeed`），而本方法每次都用新起点覆盖旧起点；
   * 若沿用旧样本，导出结果就是「前一段的帧 + 后一段的起点」，回放从首帧起就与起点不符。
   */
  startWithState(meta: Partial<InputReplayMeta>): void {
    // 清空磁带：起点唯一，跨段样本拼接在本 schema 下无法与起点对应。
    this.clear();
    this.stateMeta = meta;
    this.recording = true;
  }

  /** 本次录制锚定的起点元数据（`startWithState` 写入；导出时由 `mergedMeta` 并入）。 */
  private stateMeta: Partial<InputReplayMeta> = {};

  /** 合并三层来源：本方法的默认值 < `stateMeta` < 调用方传入的 `meta`（展开顺序即覆盖顺序）。`meanFrameMs` 在这里按当前样本算出。 */
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

  /** 关闭落样本开关；样本保留。`alwaysOn` 为真时 `record` 仍会落样本。 */
  stop(): void {
    this.recording = false;
  }

  /**
   * 切换 `alwaysOn`：为真时 `record` 无视 `recording` 落样本，用于逐帧记下回放期实际喂出的值。
   * `apps/debug/src/app.ts` 只对 `replayCapture` 置 true。
   */
  setAlwaysOn(on: boolean): void {
    this.alwaysOn = on;
  }

  /** 样本数归零并复位告警水位；不动 `recording` / `alwaysOn`，也不清数组内容（后续写入从下标 0 覆盖）。 */
  clear(): void {
    this.n = 0;
    this.nextWarnAt = WARN_FRAMES;
  }

  /** 五个数组各分配为旧长度的两倍并搬运已写样本；旧容量为 0 时长度为 `0 * 2 = 0`，不会增长。 */
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
   * 记一条样本：`recording` 或 `alwaysOn` 为真才写，否则立即返回。
   *
   * 本类不采样，五个入参全由调用方给；样本按调用顺序追加，不去重、不合并，容量不足时先
   * `grow`。本仓唯一调用点是 `apps/debug/src/app.ts` 回放分支的
   * `replayCapture.record(now, finalDx, finalDy, finalKeys)`——它省略 `dtS`，故 `dts` 写入 0。
   *
   * @param nowMs 样本时间戳（ms，原样保存）
   * @param dx 本帧鼠标 X 像素增量
   * @param dy 本帧鼠标 Y 像素增量
   * @param keys 按键位掩码（写入前 `| 0`）
   * @param dtS 本步物理步长（秒）；大于 0 才写入，否则写 0
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

  /** 样本数与首末时间戳（无样本时 `t0` / `t1` 均为 0）。 */
  counts(): RecorderCounts {
    return { frames: this.n, t0: this.n ? this.times[0] : 0, t1: this.n ? this.times[this.n - 1] : 0 };
  }

  /** 样本 → 对象数组（`load` 用它构造返回值；O(n) 且逐个分配对象）。 */
  frames(): InputFrame[] {
    const out: InputFrame[] = new Array(this.n);
    for (let i = 0; i < this.n; i++) {
      out[i] = { t: this.times[i], dx: this.dxs[i], dy: this.dys[i], keys: this.keysArr[i] };
    }
    return out;
  }

  /**
   * 对象数组形式的载荷（**未**序列化）。数值已规整：`t` 保留 3 位小数（ms）、`dx` / `dy`
   * 保留 6 位小数、`keys` 取 int32，`meta` 走 `mergedMeta`。规整后的十进制文本经
   * `toJson` / `fromJson` 往返后仍是同一个双精度值，逐帧比较据此成立。
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

  /** 导出 JSON 文本：`JSON.stringify(..., null, 0)`，无空白；结构见 `toCompactPayload`。 */
  toJson(meta?: Partial<InputReplayMeta>): string {
    return JSON.stringify(this.toCompactPayload(meta), null, 0);
  }

  /**
   * 紧凑载荷对象（**未**序列化）：`frames` 拆成五个等长并行数组。
   *
   * 落盘形态（`toJson` 的键顺序即下面的书写顺序，读入侧不依赖顺序、只按键取值）：
   * - 顶层：`schema`、`meta`、`frameCount`（等于样本数）、`frames`；
   * - `frames`：`t`、`dx`、`dy`、`keys`、`dt`，五个数组长度都等于样本数。
   *
   * 元素是十进制 JSON 数字，源数据分别是 `Float64Array`（8 字节浮点）与 `Int32Array`
   * （4 字节整数）：`t` 3 位小数、`dx` / `dy` / `dt` 6 位小数、`keys` 为整数。
   * `dt` 是每样本的物理步长（秒），对象数组形式里没有对应字段——`load` 读对象数组时
   * 会去看每个元素的可选 `dt`。
   * 本方法内部仍调一次 `toPayload`，只取它的 `schema` 与 `meta`，对象数组被丢弃。
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
   * 读入载荷：`frames` 接受两种形式。
   * - 对象数组：逐元素读 `t` / `dx` / `dy` / `keys`，可选的 `dt` 缺失时按 0；
   * - 并行数组：必须有 `t` / `dx` / `dy` / `keys` 四个数组且长度一致，`dt` 非数组时全部按 0。
   *
   * 四个数值经 `setAt` 做 `Number()` 归一并要求有限，`keys` 再 `| 0`；`dt` 非有限或 ≤ 0
   * 记 0。读入成功后 `n` 置为帧数、`recording` 置 false（`alwaysOn` 不动），返回对象数组
   * 形式的载荷（`meta` 原样带出）。
   *
   * `frameCount` 为数字时必须等于实际帧数；该判断排在 `n` 与 `recording` 赋值之后，
   * 故它抛错时本对象已持有新样本。
   *
   * @throws Error 载荷非对象 / schema 不符 / 紧凑格式缺字段 / 四数组长度不齐 /
   *               某帧含非有限数 / `frameCount` 与实际帧数不符
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

  /** `JSON.parse` 后交给 `load`；文本非法时由 `JSON.parse` 抛 SyntaxError。 */
  fromJson(text: string): InputReplayPayload {
    return this.load(JSON.parse(text));
  }

  /**
   * 扩容到至少 n：从当前容量反复翻倍，然后**重新分配**五个数组（不搬运旧内容）。
   * 只由 `load` 在写入之前调用，故无需保留原内容。当前容量为 0 时翻倍不增长。
   */
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

  /** 写第 i 个样本：四个数值先 `Number()` 归一，任一非有限即抛错（错误文案带帧号与原始值）；`keys` 再 `| 0`，`dt` 非有限或 ≤ 0 记 0。 */
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

/** 四舍五入到 d 位小数（先乘 `10 ** d` 再 `Math.round`，最后除回）；导出规整与 `meanFrameMs` 都用它。 */
function round(v: number, d: number): number {
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

/** 回放状态快照（面板状态行与 `__wsInput.counts` 用）。 */
export interface PlayerState {
  /** 是否处于播放态：`stop` 置 false，`start` 按样本数是否大于 0 决定。 */
  playing: boolean;
  /** 已消费的样本下标；-1 = 尚未消费任何样本。 */
  index: number;
  /** 样本总数。 */
  total: number;
  /** 墙钟推进累计跳过的样本数；`step` / `stepReplay` 不改它。 */
  skipped: number;
}

/**
 * 回放器：持有样本数组与游标，供调用方按时间戳或按帧取样本。
 *
 * 两种推进方式，由 `sampleClock` 决定 `next` 的行为：
 * - `step()` / `stepReplay()`：每次只前进一帧（`i += 1`），不跳样本；样本时钟模式下
 *   `next` 自己不动游标，重复调用返回同一样本，直到调用方推进。
 * - `next(nowMs)`：墙钟模式按 `t < nowMs` 取最后一个样本，跨过的帧数累加进 `skippedFrames`；
 *   已到末帧时保持末帧样本，不外推。
 *
 * 物理步长不取自 `t`：`frameDt` 优先用录制时写下的 `dts[i]`，否则用相邻时间戳差值，
 * 两者都受 0.1 s 上限约束。调用方 `apps/debug/src/app.ts` 把它写进
 * `apps/debug/src/renderer/renderer-main.ts` 的 `replayDtS`（该字段被渲染主循环消费一次后置 null）。
 * 本类不读 `meta` 的任何字段，只原样保存并由 `getMeta` 返回。
 */
export class InputPlayer {
  /** 各样本时间戳（接管自录制器或载入的载荷）。 */
  private times = new Float64Array(0);
  /** 各样本鼠标 X 像素增量。 */
  private dxs = new Float64Array(0);
  /** 各样本鼠标 Y 像素增量。 */
  private dys = new Float64Array(0);
  /** 各样本按键位掩码。 */
  private keysArr = new Int32Array(0);
  /** 各样本物理步长（秒）；全 0 时 `frameDt` 走时间戳回退。 */
  private dts = new Float64Array(0);
  /** 样本总数。 */
  private n = 0;
  /** 游标：-1 = 尚未消费任何样本。 */
  private i = -1;
  /** 播放态（`next` 的第一道守卫）。 */
  private playing = false;
  /** 墙钟推进累计跳过的样本数（`start` 与 `fromRecorder` 清零）。 */
  private skippedFrames = 0;
  /** 载入时带出的 meta（原样保存）。 */
  private meta: Partial<InputReplayMeta> = {};
  /** 是否样本时钟模式（`playDeterministic` 置 true，`playRealtime` / `setRealtime` 置 false）。 */
  private sampleClock = false;

  /**
   * 载入载荷：先用一次性 `InputRecorder`（容量 1024）走 `InputRecorder.load` 的全部校验，
   * 成功后才 `fromRecorder` 接管其数组与载荷的 `meta`。解析抛错时本对象样本不变。
   */
  load(payload: unknown): void {
    const tmp = new InputRecorder(1024);
    const parsed = tmp.load(payload);
    this.fromRecorder(tmp, parsed.meta);
  }

  /** `JSON.parse` 后交给 `load`；文本非法时由 `JSON.parse` 抛 SyntaxError。 */
  fromJson(text: string): void {
    this.load(JSON.parse(text));
  }

  /** 按引用接管录制器的五个数组与 `n`（不复制对象），并复位游标、播放标志与丢帧计数；`dts` 缺失时新建与 `n` 等长的零数组。 */
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

  /** 录制器 → 回放器（按引用接管，不复制）；本仓无调用点。 */
  adopt(rec: InputRecorder, meta?: Partial<InputReplayMeta>): void {
    this.fromRecorder(rec, meta ?? {});
  }

  /** `playing` 标志；`apps/debug/src/app.ts` 用自己的 `inputReplaying` 判断回放态，未调用本方法。 */
  isPlaying(): boolean {
    return this.playing;
  }

  /** 载入时保存的 `meta`（原样返回，不合并默认值）；本仓无调用点。 */
  getMeta(): Partial<InputReplayMeta> {
    return this.meta;
  }

  /** 游标复位为 -1、丢帧计数清零，`playing` 置为「样本数大于 0」。 */
  start(): void {
    this.i = -1;
    this.skippedFrames = 0;
    this.playing = this.n > 0;
  }

  /** 置墙钟模式（`sampleClock = false`）后 `start`；只有 `__wsInput.play(false)` 能走到（面板「载入并回放」与 `startPlayback` 的默认参数都是逐帧确定性）。 */
  playRealtime(): void {
    this.sampleClock = false;
    this.start();
  }

  /** 置样本时钟模式（`sampleClock = true`）后 `start`；面板与 `__wsInput.tickReplay` 走这条。 */
  playDeterministic(): void {
    this.sampleClock = true;
    this.start();
  }

  /** 当前是否样本时钟模式；两个调用点都在 `apps/debug/src/app.ts`（状态行文案与输入循环的推进分支）。 */
  isSampleClock(): boolean {
    return this.sampleClock;
  }

  /** 只把 `sampleClock` 置 false，不重置游标；本仓无调用点。 */
  setRealtime(): void {
    this.sampleClock = false;
  }

  /**
   * 样本时钟模式下给调用方的时间：让墙钟分支的 `next(nowMs)` 恰好停在待消费样本上。
   *
   * 返回分档：无样本返回 0；游标在起点之前（`i < 0`）返回 `times[0]`（不减 epsilonMs）；
   * 已到末帧返回 `Infinity`；否则返回 `times[i + 1] - epsilonMs`。
   * 依据是 `next` 墙钟分支取 `t < nowMs` 的最后一个样本，故喂「下一帧时间戳减 eps」时
   * 只会命中当前帧；物理步长另由 `frameDt` 给出。
   */
  sampleNow(epsilonMs = 1e-6): number {
    if (this.n === 0) return 0;
    if (this.i < 0) return this.times[0];
    const next = this.i + 1;
    if (next >= this.n) return Number.POSITIVE_INFINITY;
    return this.times[next] - epsilonMs;
  }

  /** `playing` 置 false；游标与样本保留。 */
  stop(): void {
    this.playing = false;
  }

  /** 只接受 0（回到第 0 帧之前）；其他值直接返回，不报错、不改状态。本仓无调用点。 */
  seekTo(frame: number): void {
    if (frame !== 0) return; // 只支持从起点整段放，不支持跳到中间
    this.i = -1;
    this.skippedFrames = 0;
  }

  /** 当前状态快照（`apps/debug/src/app.ts` 的状态行与 `__wsInput.counts` 各取一次）。 */
  state(): PlayerState {
    return { playing: this.playing, index: this.i, total: this.n, skipped: this.skippedFrames };
  }

  /**
   * 取当前时间对应的样本；未在播放或样本数为 0 时返回 null。
   *
   * 样本时钟模式（`sampleClock` 为 true）：
   * - 游标在起点之前：取第 0 个样本并落游标，不判断 `nowMs`；
   * - 否则返回 `sample(min(i, n - 1))`，游标不动——只由 `step` / `stepReplay` 推进，
   *   重复调用返回同一样本。
   *
   * 墙钟模式（`sampleClock` 为 false）：
   * - 游标在起点之前：`times[0] > nowMs` 时返回 null（还没到首帧时间），否则取第 0 个样本；
   * - 已到末帧（`i + 1 >= n`）：返回当前末帧样本（保持到 `stop`，不外推）；
   * - 否则把游标推进到满足 `t < nowMs` 的最后一个样本，跨过的帧数累加进 `skippedFrames`。
   *
   * 本方法不使用 `sampleNow`；样本时钟模式下 `nowMs` 被忽略。
   * @param nowMs 墙钟时间（ms）
   */
  next(nowMs: number): InputFrame | null {
    if (!this.playing || this.n === 0) return null;
    // 样本时钟：只回读当前样本，不推游标（推进权在 step / stepReplay）。
    if (this.sampleClock) {
      if (this.i < 0) {
        this.i = 0;
        return this.sample(0);
      }
      return this.sample(Math.min(this.i, this.n - 1));
    }
    const now = nowMs;
    if (this.i < 0) {
      // 墙钟还没到首帧时间 → 本轮无样本
      if (this.times[0] > now) return null;
      this.i = 0;
      return this.sample(0);
    }
    if (this.i + 1 >= this.n) return this.sample(this.i); // 末帧：保持当前样本到 stop
    let k = this.i;
    // 严格小于 now：时间戳恰好等于 now 的下一个样本留到下次
    while (k + 1 < this.n && this.times[k + 1] < now) k++;
    if (k > this.i) this.skippedFrames += k - this.i;
    this.i = k;
    return this.sample(k);
  }

  /**
   * 确定性推进一帧：调 `step` 前进一格，再取本帧步长与游标。
   *
   * 不检查 `playing`：未调 `playDeterministic` / `playRealtime` 也能推进。已到末帧时
   * `frame` 为 null，但 `dtS` 仍按当前游标算（末帧间隔）。两个调用点都在
   * `apps/debug/src/app.ts`（`__wsInput.tickReplay` 与输入循环的面板分支），都传 `1 / 64`。
   * @param defaultDtS 录制步长与时间戳都不可用时的兜底步长（秒）
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
   * 前进一帧并返回该样本；样本数为 0 或已在末帧时返回 null（不回绕、不重复）。
   * 不检查 `playing`。
   */
  step(): InputFrame | null {
    if (this.n === 0 || this.i + 1 >= this.n) return null;
    this.i++;
    return this.sample(this.i);
  }

  /**
   * 本帧物理步长（秒）。取值顺序：
   * 1. `0 <= i < n` 且 `dts[i]` 有限且大于 0 → `min(dts[i], 0.1)`；
   * 2. 时间戳回退：`i <= 0` 时用后向间隔 `(times[min(1, n - 1)] - times[0]) / 1000`（首帧没有
   *    前一帧，后向间隔与邻帧同量级），否则用 `(times[i] - times[i - 1]) / 1000`；
   *    结果非有限或 ≤ 0 → 返回 `defaultDt`；否则 `min(dt, 0.1)`。
   *
   * 本仓唯一 `record` 调用点不传 `dtS`，故线上样本的 `dts` 全为 0，实际走第 2 条。
   */
  frameDt(defaultDt: number): number {
    // 首帧没有「前一帧」：后向间隔 t[1] − t[0] 与邻帧同量级，且完全由录制内容决定。
    const i = this.i;
    // 首选录制时写下的实际步长；当前调用点不传 dtS，故实际都落到下面的时间戳回退。
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

  /** 回放健康度：样本总数、当前游标、累计跳过数，以及 `exhausted`（`i + 1 >= n`，样本数为 0 时也为 true）。 */
  counts(): { total: number; index: number; skipped: number; exhausted: boolean } {
    return { total: this.n, index: this.i, skipped: this.skippedFrames, exhausted: this.i + 1 >= this.n };
  }

  /** 是否已到末尾或没有样本（`i + 1 >= n`）；`apps/debug/src/app.ts` 的输入循环据此自动收尾回放。 */
  isExhausted(): boolean {
    return this.i + 1 >= this.n;
  }

  /** 物化第 i 个样本（不含 `dt`；`dts` 只经 `frameDt` 暴露）。 */
  private sample(i: number): InputFrame {
    return { t: this.times[i], dx: this.dxs[i], dy: this.dys[i], keys: this.keysArr[i] };
  }
}

/**
 * 位掩码 → `KeyState` 布尔对象：逐位与字面量比较（1/2/4/8/16/32/64/128/256/512/1024），
 * 位序与 `src/ts-shared/auth/shared-state.ts` 的 `KEY_MASK`、`maskToKeys` 相同
 * （`maskToKeys` 在本仓同样没有导入点）。
 * 本函数在本仓无调用点。
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
 * 逐帧比对两组样本：只比 `dx` / `dy` / `keys`（`!==` 严格不等），不比 `t`。
 *
 * `compared` 取两组长度的较小值；`firstMismatch` 是首个不等帧的下标（无则 -1）；
 * `diffs` 最多收 8 条逐帧描述（此后不再追加），两组长度不等时额外追加一条帧数说明。
 * `identical` 要求无任何不等帧**且**两组长度相等。
 * 本函数在本仓无调用点：`apps/debug/scripts/input-replay-verify.mjs` 的 `compareInputs`
 * 另有一份同口径实现。
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
