/**
 * 物理路径记录器 —— 同时记录两条物理计算线的**脚底中心点**轨迹。
 *
 * 两条线（按各自的计算节点采样，**不做定时轮询**）：
 * - **渲染物理线**：主线程 `predPhys`，每个 rAF 物理步记一个节点
 *   （更新率 = 显示器刷新率，用户实测屏 320Hz 即 ~320 节点/秒）。
 * - **tick 物理线**：Worker 权威帧，每来一帧**新的**（`V_A` 变化）记一个节点
 *   （固定步长 1/(tickRate+3)；64 档 → 67 节点/秒）。
 *
 * 点位语义：两条线都取 `PhysWorld` 原点的 `(posX, posY, posZ)`——CS 的 origin
 * 即**脚底中心**（同一处 `camY = posY + eyeHeight` 可证 posY 是脚底而非眼高）。
 *
 * **绘制约定**：两条线都是**节点之间直连直线段**（真实轨迹，节点处即硬转折）。
 * - 渲染线：主线程 predPhys 每个 rAF 一个节点（更新率 = 显示器刷新率；320Hz 下相邻节点
 *   间距 <1 HU，拐角在屏幕上远小于 1 像素——这是它的真实采样率，不是插值）。
 * - tick 线：Worker 权威帧每个新帧一个节点（64 档 → ~67 节点/秒，相邻节点间距明显更大）。
 * - **不要**把节点展开成轴对齐阶梯：那是"量化"示意，会偏离玩家真实走过的位置，
 *   画出来就不是路径线了（2026-09-11 试过，已回退）。
 *
 * 说明：两条线点数不同、时刻不同，因此**不保证逐点对应**；导出数据带 `t`（performance.now）
 * 供外部按时间对齐。用户明确要求「不限点数」，故仅做翻倍扩容、不设上限。
 *
 * ── tick 节点时间戳 = τ（渲染时钟）〔2026-09-11〕─────────────────────
 * Worker 权威帧的**发布位置**是渲染轨迹上的一个采样点（`shared.writeRenderSample`
 * 送出的 `(t,x,y,z)` 流；Worker 按渲染时钟 τ 取点后发布）。因此 tick 节点的 `t` 必须
 * 记「本次发布所依据的渲染时钟采样时刻 τ」（`shared.readPublishedTau()`），
 * **不能记本轮询时刻 `now`**：面板「偏差梳」是**时间对齐**度量，用轮询时刻会把几何上
 * 与渲染轨迹重合的两点读成切向滞后（几十 HU）。τ=0（该帧未做投影）时回落 `now`
 * ——即旧行为。
 *
 * ── render 节点恒落点（索引空间与采样传输共享）──────────────────
 * `addRender` **无条件** append（不再因 `!recording` 提前返回），使记录器的 render
 * 节点索引空间（= 内存数组下标）与主线程 `writeRenderSample(..., i0, ...)` 的 `i0`
 * 一一对应；**绘制/导出/计数仍受 `recording` 门控**（未记录时不连线、不进导出、
 * 不计入 `counts().render` —— 节点带 `rec` 标记）。因此导出里的 render 数组是
 * 「记录期子集」，其下标 ≠ `i0`（离线分析按 `t` 对齐，不依赖下标）。
 *
 * ── 三个"距离"是三个不同的量，勿混用 ───────────────────────────
 * - **垂距**（`perp`）：tick 点到渲染折线的最短距离（投影钳位到线段）＝**验收口径**
 *   （CI 门 `debug/scripts/path-acceptance.mjs`，BVH 全量最近线段）。面板里的垂距
 *   只用 ±PERP_WINDOW_MS 时间窗近似（渲染路径可能绕回，窗口会漏），**权威判定以
 *   CI 脚本为准**。
 * - **偏差梳**（`deviStats().mean/max`）：tick 点与其**同时刻**渲染位置的差
 *   （时间对齐；含切向滞后，会被传送放大）。
 * - **残差**（`residual`）：权威**自身** post-tick 位置 与 发布（投影）位置 的距离
 *   （只有 Worker 侧可得；主线程拿不到时留空）。
 */
import * as THREE from 'three';

/** 路径节点（t = performance.now()，ms；tick 节点的 t = 渲染时钟 τ，见文件头）。 */
export interface PathPoint {
  t: number;
  x: number;
  y: number;
  z: number;
  /** 残差（HU，仅 tick 节点）：权威自身 post-tick 位置 与 发布（投影）位置 的距离。 */
  residual?: number;
  /** 垂距（HU，仅 tick 节点，HUD 近似）：该点到渲染折线的最短距离（见 perpDistAt）。 */
  perp?: number;
  /**
   * 该 render 节点是**在记录状态下**落点的（导出/计数只看它）。
   * `addRender` 恒 append（索引空间与采样传输共享），但只有记录期的节点才绘制/导出
   * ——保持与旧实现完全一致的导出内容（不把开录前的几百秒轨迹塞进导出文件）。
   */
  rec?: boolean;
}

/** 一组距离值的分布统计（HU）。 */
export interface DistStats {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

/** 空统计（n=0；其余 0 而非 NaN，便于 UI 直接 toFixed）。 */
const EMPTY_STATS: DistStats = { n: 0, mean: 0, p50: 0, p95: 0, max: 0 };

/** 分位数（最近秩，floor(n·q)；与 path-acceptance.mjs 的 pct 同定义）。`sorted` 须已升序。 */
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/** 距离分布统计（mean/中位/p95/最大）。O(n log n)，仅在面板刷新（~10Hz）时调用。 */
function distStats(values: number[]): DistStats {
  if (!values.length) return EMPTY_STATS;
  const sorted = values.slice().sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    n: sorted.length,
    mean: sum / sorted.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

/** 渲染物理线颜色（青）。 */
const RENDER_COLOR = 0x22d3ee;
/** tick 物理线颜色（琥珀）。 */
const TICK_COLOR = 0xf59e0b;
/** 偏差梳颜色（洋红）——每个 tick 节点连到渲染线「同一时刻」的位置。 */
const DEVI_COLOR = 0xff3bd0;
/** 初始容量（点）；满则翻倍。 */
const INITIAL_CAP = 8192;

/** 缓冲类型。 */
type BufMode = 'line' | 'points' | 'segments';

/**
 * 跳变阈值（HU）：相邻节点距离超过它就**断开**，不画连接线。
 * respawn/传送会制造上万 HU 的跳变，连起来会是一条横跨地图的假直线，
 * 既掩盖真实折角又误导判读。
 */
const JUMP_BREAK = 100;

/**
 * 面板垂距的**近似**时间窗（ms，单侧）。
 *
 * 验收脚本对「合格线段」做**全量**最近搜索（线段 AABB 的 BVH）——因为渲染路径会绕回，
 * 真正的最近线段可能相差数秒（实测 5.5s）。面板要在每帧/每次刷新里算，只用 ±此窗
 * 内的线段，**故意接受这个误差**：面板只用于实时看「是否 ≈0 / 趋势」，**权威判定
 * 始终是 debug/scripts/path-acceptance.mjs**（CI 门）。
 */
const PERP_WINDOW_MS = 250;

/** 折角着色：**保持 tick 线本色（琥珀）**，只有硬折角才染红。
 *  之前把 ≤5° 染绿会让 tick 线看起来像"另一条绿线"，与图例/渲染线混淆（用户实测反馈）。 */
function turnColor(deg: number): [number, number, number] {
  if (deg <= 20) return [0.96, 0.62, 0.04]; // 琥珀 = tick 线本色
  return [1.0, 0.15, 0.15]; // 红：硬折角 >20°
}

/** 偏差梳着色：按偏差大小分级，分歧大的一眼看到。 */
function deviColor(hu: number): [number, number, number] {
  if (hu <= 10) return [0.15, 0.85, 0.4]; // 绿：小
  if (hu <= 30) return [1.0, 0.85, 0.15]; // 黄：中
  return [1.0, 0.15, 0.15]; // 红：大分歧
}

/** 是否跳变（respawn/传送）——超过阈值就不连线。 */
function isJump(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > JUMP_BREAK;
}

/** 三点折角（度，0=共线）。 */
function turnDeg(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  c: { x: number; y: number; z: number },
): number {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - b.x, vy = c.y - b.y, vz = c.z - b.z;
  const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz);
  if (lu < 1e-9 || lv < 1e-9) return 0;
  const cos = (ux * vx + uy * vy + uz * vz) / (lu * lv);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/** 单条线的动态顶点缓冲（预分配 + 翻倍扩容 + setDrawRange 增量绘制）。
 *  - `'line'`      → `THREE.Line`（节点直连）
 *  - `'points'`    → `THREE.Points`（节点标记）
 *  - `'segments'`  → `THREE.LineSegments`（顶点成对，每对一段——偏差梳用） */
class LineBuffer {
  readonly object: THREE.Object3D;
  private readonly mat: THREE.Material;
  private pos: Float32Array;
  private attr: THREE.BufferAttribute;
  private col: Float32Array | null = null;
  private colAttr: THREE.BufferAttribute | null = null;
  private readonly geo: THREE.BufferGeometry;
  private count = 0;

  constructor(color: number, renderOrder: number, mode: BufMode = 'line', pointSize = 4, useColors = false) {
    this.pos = new Float32Array(INITIAL_CAP * 3);
    this.attr = new THREE.BufferAttribute(this.pos, 3);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', this.attr);
    if (useColors) {
      this.col = new Float32Array(INITIAL_CAP * 3);
      this.colAttr = new THREE.BufferAttribute(this.col, 3);
      this.colAttr.setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute('color', this.colAttr);
    }
    this.geo.setDrawRange(0, 0);
    if (mode === 'points') {
      // 节点标记：不受光照、永远可见（depthTest=false）——便于在任意角度核对 64Hz 网格
      const pmat = new THREE.PointsMaterial({
        color,
        size: pointSize,
        sizeAttenuation: false,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
      });
      this.object = new THREE.Points(this.geo, pmat);
      this.mat = pmat;
    } else {
      const mat = new THREE.LineBasicMaterial({
        color: useColors ? 0xffffff : color,
        vertexColors: useColors,
        // 偏差梳永远可见：它就是用来读数值的，被墙挡住就没意义了
        depthTest: mode !== 'segments',
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
      });
      this.object = mode === 'segments' ? new THREE.LineSegments(this.geo, mat) : new THREE.Line(this.geo, mat);
      this.mat = mat;
    }
    // 路径可能横跨整张图，不能被视锥/包围球剔除掉
    this.object.frustumCulled = false;
    this.object.renderOrder = renderOrder;
    this.object.name = 'phys-path-line';
  }

  get length(): number {
    return this.count;
  }

  private grow(): void {
    const cap = this.pos.length / 3;
    const next = new Float32Array(cap * 2 * 3);
    next.set(this.pos);
    this.pos = next;
    this.attr = new THREE.BufferAttribute(this.pos, 3);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.attr);
    if (this.col) {
      const nc = new Float32Array(cap * 2 * 3);
      nc.set(this.col);
      this.col = nc;
      this.colAttr = new THREE.BufferAttribute(this.col, 3);
      this.colAttr.setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute('color', this.colAttr);
    }
  }

  push(x: number, y: number, z: number, rgb?: [number, number, number]): void {
    if (this.count >= this.pos.length / 3) this.grow();
    const o = this.count * 3;
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    if (this.col && rgb) {
      this.col[o] = rgb[0];
      this.col[o + 1] = rgb[1];
      this.col[o + 2] = rgb[2];
    }
    this.count++;
    this.geo.setDrawRange(0, this.count);
    this.attr.needsUpdate = true;
    if (this.colAttr) this.colAttr.needsUpdate = true;
  }

  /** 压入一段（成对顶点）——`'segments'` 模式用；跳变时整段不压 = 自然断开。 */
  pushPair(
    a: [number, number, number],
    b: [number, number, number],
    rgb: [number, number, number],
  ): void {
    this.push(a[0], a[1], a[2], rgb);
    this.push(b[0], b[1], b[2], rgb);
  }

  clear(): void {
    this.count = 0;
    this.geo.setDrawRange(0, 0);
  }

  /** 前 count 个点的坐标（只读视图；导出用）。 */
  positions(): Float32Array {
    return this.pos.subarray(0, this.count * 3);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

export class PathRecorder {
  /** 挂到场景的组（两条线 + 起点标记）。 */
  readonly group = new THREE.Group();
  private readonly renderBuf = new LineBuffer(RENDER_COLOR, 1, 'segments');
  /** tick 线的**绘制**缓冲（分段 + 按折角着色；计数/导出请用 tickNodes）。 */
  private readonly tickBuf = new LineBuffer(TICK_COLOR, 2, 'segments', 4, true);
  private readonly tickDots = new LineBuffer(TICK_COLOR, 4, 'points', 4);
  private readonly deviBuf = new LineBuffer(DEVI_COLOR, 5, 'segments', 4, true);
  /** render 线节点真值（绘制用分段缓冲，采样/导出用这份）。 */
  private renderNodes: PathPoint[] = [];
  /** 记录期落点的 render 节点数（= 导出/绘制/`counts().render` 的口径；见 addRender）。 */
  private recordedRenderCount = 0;
  /** tick 线的**原始节点**（真值）。 */
  private tickNodes: PathPoint[] = [];
  /** 分段绘制用：上一次已落点（跳变时置空 = 断开）。 */
  private prevRender: PathPoint | null = null;
  private prevTick1: PathPoint | null = null;
  private prevTick2: PathPoint | null = null;
  private recording = false;
  /** 上一次已记录的权威帧版本号（用于「只记新帧」）。 */
  private lastTickVa = -1;
  /**
   * 上一个 tick 节点的时间戳（**单调守卫**）。
   *
   * 为什么需要：tick 节点的 `t` 是**渲染时钟 τ**（`readPublishedTau()`），而 τ 由
   * Worker 每个 tick 重算/钳制——两条相邻权威帧可能落在同一对渲染样本上，钳制后
   * 的 τ 会**倒退 1–3ms**（实测 17278.06 → 17275.40）。τ 在语义上是"这次发布依据的
   * 渲染轨迹位置"，轨迹只会前进，倒退是钳制伪影。
   *
   * 后果（实测）：`debug/scripts/path-acceptance.mjs` 的数据校验直接判
   * 「tick 时间戳非单调」并整体 FAIL——一次 −2.66ms 就废掉整份录制；面板的
   * 「最近线段时间偏移」也会被这种乱序点带偏。故在**记录处**对 `t` 施加
   * 非递减钳制（`t = max(t, lastTickT)`）：时间戳守恒域内、不改位置、不改 τ 通道。
   *
   * 不变量：同一次录制内 tick 时间戳非递减（允许相等——同一 τ 的多帧是合法情形）。
   */
  private lastTickT = Number.NEGATIVE_INFINITY;
  /** 偏差统计（HU）。 */
  private deviSum = 0;
  private deviCount = 0;
  private deviMax = 0;
  /** 偏差分级计数（绿 ≤10 / 黄 ≤30 / 红 >30 HU）。 */
  private deviGreen = 0;
  private deviYellow = 0;
  private deviRed = 0;
  /**
   * **折线形状自检**（面板实时显示）——直接判定"这条折线到底是不是轴对齐阶梯"。
   * 若 tick 段几乎全部轴对齐且折角≈90°，说明画的是曼哈顿阶梯（错误画法）；
   * 正常情况应以斜向段为主、折角中位数接近 0°。
   */
  private segTotal = 0;
  private segAxis = 0;
  private segHard45 = 0;
  /** 节点间直线长度之和（与绘制缓冲实际长度比 → 判定是否被展开成阶梯）。 */
  private segDirectLen = 0;

  constructor() {
    this.group.name = 'phys-path';
    this.group.add(this.renderBuf.object, this.tickBuf.object, this.tickDots.object, this.deviBuf.object);
  }

  get isRecording(): boolean {
    return this.recording;
  }

  /** 开始记录（不自动清空——便于分多段累加；要清空请显式 clear）。 */
  start(): void {
    this.recording = true;
    // 重新开始可能跨越 respawn/换图：下一个权威帧无条件记一次，避免接在旧点上
    this.lastTickVa = -1;
  }

  stop(): void {
    this.recording = false;
  }

  /**
   * 点数统计（UI 显示用；均为**原始节点数**，非绘制顶点数）。
   * `render` = **记录期**落点数（不含开录前为对齐索引空间而 append 的节点）。
   */
  counts(): { render: number; tick: number } {
    return { render: this.recordedRenderCount, tick: this.tickNodes.length };
  }

  /**
   * 记一个渲染物理节点（主线程 predPhys 每个 rAF 物理步调用一次）。
   *
   * **恒落点**：即使未在记录（`!recording`）也 append —— 记录器的 render 节点索引
   * 空间必须与主线程渲染采样传输（`shared.writeRenderSample(..., i0, ...)`）的 `i0`
   * 一一对应（Worker 据此把发布位置标成「渲染轨迹上的第 i0 个采样点」）。
   * **绘制/导出/计数仍只看 `recording`**（节点带 `rec` 标记）：未记录时不连线、
   * 不进 `prevRender` 链、不计入 `counts().render`、不进导出——与旧实现完全一致。
   * @param t performance.now()（ms）
   */
  addRender(t: number, x: number, y: number, z: number): void {
    const p: PathPoint = { t, x, y, z };
    if (this.recording) {
      p.rec = true;
      this.recordedRenderCount++;
      const prev = this.prevRender;
      if (prev && !isJump(prev, p)) this.renderBuf.pushPair([prev.x, prev.y, prev.z], [x, y, z], [0, 0, 0]);
      this.prevRender = p;
    }
    this.renderNodes.push(p);
  }

  /**
   * 记一个 tick 物理节点（Worker 权威帧）。**仅当 va 变化**（= 真的来了新帧）才落点。
   *
   * 绘制：**节点之间直连直线段**（真实轨迹；节点处即硬转折），并按**折角大小着色**
   * （绿 ≤5° / 黄 ≤20° / 红 >20°），硬折角一眼可见。跳变（>JUMP_BREAK HU）处**断开**，
   * 不画连接线——否则 respawn/传送会拉出一条横跨地图的假直线。
   * @param va 权威帧版本号 `V_A`
   * @param t **渲染时钟 τ**（ms）——本帧发布所依据的渲染采样时刻；无投影时为轮询时刻
   * @param residual 残差（HU）：权威自身 post-tick 位置 与 发布（投影）位置 的距离；
   *                 主线程拿不到时传 undefined（见文件头）
   */
  addTick(va: number, t: number, x: number, y: number, z: number, residual?: number): void {
    if (!this.recording) return;
    if (va === this.lastTickVa) return;
    this.lastTickVa = va;
    // τ 单调守卫（见 lastTickT 注释）：τ 只会前进，倒退 1–3ms 是钳制伪影。
    if (t < this.lastTickT) t = this.lastTickT;
    else this.lastTickT = t;
    const p: PathPoint = { t, x, y, z };
    if (residual !== undefined && Number.isFinite(residual)) p.residual = residual;
    // 垂距（HUD 近似；验收口径的权威判定见 scripts/path-acceptance.mjs）
    const perp = this.perpDistAt(t, x, y, z);
    if (Number.isFinite(perp)) p.perp = perp;
    const p1 = this.prevTick1;
    const p2 = this.prevTick2;
    // 跳变（respawn/传送）那一拍：两线可能因时序差异短暂拉开数百 HU，那不是物理分歧，
    // 必须排除，否则偏差统计与着色会被传送污染（实测最大 296 HU 全是 respawn）。
    const jumped = p1 !== null && isJump(p1, p);
    if (p1 && !jumped) {
      // 段 (p1→p) 的颜色取 **p1 处**的折角（由 p2→p1→p 决定；无 p2 时按直线处理）
      const turn = p2 ? turnDeg(p2, p1, p) : 0;
      this.tickBuf.pushPair([p1.x, p1.y, p1.z], [x, y, z], turnColor(turn));
      // 形状自检：轴对齐占比 + 硬折角占比
      const dx = Math.abs(x - p1.x), dy = Math.abs(y - p1.y), dz = Math.abs(z - p1.z);
      const L = Math.hypot(dx, dy, dz);
      this.segTotal++;
      if (L > 1e-6 && Math.max(dx, dy, dz) / L > 0.99) this.segAxis++;
      if (turn > 45) this.segHard45++;
      this.segDirectLen += L;
    }
    this.prevTick2 = this.prevTick1;
    this.prevTick1 = p;
    this.tickDots.push(x, y, z);
    this.tickNodes.push(p);
    // 偏差梳：连到渲染线「同一时刻」的位置（时间对齐，不是最近点）
    if (!jumped) {
      const r = this.sampleRenderAt(t);
      if (r) {
        const d = Math.hypot(x - r.x, y - r.y, z - r.z);
        this.deviBuf.pushPair([x, y, z], [r.x, r.y, r.z], deviColor(d));
        this.deviSum += d;
        this.deviCount++;
        if (d > this.deviMax) this.deviMax = d;
        if (d <= 10) this.deviGreen++;
        else if (d <= 30) this.deviYellow++;
        else this.deviRed++;
      }
    }
  }

  /** 在渲染线上按时间线性插值出位置（偏差梳用）。用原始节点，与绘制缓冲无关。 */
  private sampleRenderAt(t: number): { x: number; y: number; z: number } | null {
    const n = this.renderNodes.length;
    if (n === 0) return null;
    const a0 = this.renderNodes[0];
    const b0 = this.renderNodes[n - 1];
    if (t <= a0.t) return { x: a0.x, y: a0.y, z: a0.z };
    if (t >= b0.t) return { x: b0.x, y: b0.y, z: b0.z };
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.renderNodes[m].t <= t) lo = m;
      else hi = m;
    }
    const a = this.renderNodes[lo];
    const b = this.renderNodes[hi];
    const f = (t - a.t) / Math.max(b.t - a.t, 1e-6);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
  }

  /**
   * 垂距（HUD 用，**近似**）：点 p 到渲染折线的**最短距离**，与
   * `debug/scripts/path-acceptance.mjs` 同定义——
   *   d = min over 合格线段 的 |p − proj_clamped(p, seg)|，
   *   合格线段 = 两端距离 ≤ JUMP_BREAK(100 HU)（跳变处渲染器不连线）。
   *
   * **与离线脚本的差异（故意）**：脚本对**全部**合格线段建线段 AABB 的 BVH 做全量
   * 最近搜索（渲染路径会绕回，实测最近线段可差 5.5s）；这里只扫
   * `[t−PERP_WINDOW_MS, t+PERP_WINDOW_MS]` 窗内的线段（此刻尚未 append 的"未来"节点
   * 天然不在窗内），O(窗内线段数)。**验收判定以 CI 脚本为准，面板只作实时指示**
   * （"是否 ≈0 / 有没有趋势"）。
   * @returns 最短距离（HU）；窗口内无合格线段时 NaN
   */
  private perpDistAt(t: number, x: number, y: number, z: number): number {
    const R = this.renderNodes;
    const n = R.length;
    if (n < 2) return NaN;
    const t0 = t - PERP_WINDOW_MS;
    const t1 = t + PERP_WINDOW_MS;
    // 二分：最后一个 t < t0 的节点也要参与（它与窗口内首节点构成跨越窗口左界的线段）
    let lo = 0;
    let hi = n - 1;
    let start = 0;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (R[m].t < t0) {
        start = m;
        lo = m + 1;
      } else {
        hi = m - 1;
      }
    }
    let best = Infinity;
    for (let i = start; i + 1 < n; i++) {
      const a = R[i];
      const b = R[i + 1];
      if (b.t > t1) break;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const l2 = dx * dx + dy * dy + dz * dz;
      if (l2 < 1e-12) continue; // 零长段无意义（脚本同判）
      if (l2 > JUMP_BREAK * JUMP_BREAK) continue; // 跳变段：渲染器不连线
      let s = ((x - a.x) * dx + (y - a.y) * dy + (z - a.z) * dz) / l2;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      const d = Math.hypot(x - (a.x + dx * s), y - (a.y + dy * s), z - (a.z + dz * s));
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * 折线形状自检（面板显示）。**决定性判据**是 `lenRatio`：
   * 绘制缓冲的实际总长 ÷ 节点间直线总长。直连恒 =1.00；曼哈顿阶梯会 >1.3
   * （轴对齐占比不可靠——竖直下落时相邻节点本就只差一轴）。
   */
  shapeStats(): {
    total: number;
    axis: number;
    hard45: number;
    drawnLen: number;
    directLen: number;
    lenRatio: number;
  } {
    const p = this.tickBuf.positions();
    let drawnLen = 0;
    for (let i = 0; i + 1 < this.tickBuf.length; i += 2) {
      const o = i * 3;
      const q = (i + 1) * 3;
      drawnLen += Math.hypot(p[q] - p[o], p[q + 1] - p[o + 1], p[q + 2] - p[o + 2]);
    }
    return {
      total: this.segTotal,
      axis: this.segAxis,
      hard45: this.segHard45,
      drawnLen,
      directLen: this.segDirectLen,
      lenRatio: this.segDirectLen > 1e-6 ? drawnLen / this.segDirectLen : 1,
    };
  }

  /**
   * 三个距离量的统计（HU），**分开返回、不可互相替代**：
   * - `perp`：垂距（验收口径；HUD 为 ±PERP_WINDOW_MS 近似窗）——面板「垂距 p95」
   * - `mean/max/green/yellow/red`：偏差梳（**时间对齐**，tick 点 vs 同时刻渲染位置）
   * - `residual`：残差（权威 post-tick 位置 vs 发布位置；主线程拿不到则为 n=0）
   * 每次调用 O(n log n)（分位数需排序）；调用方为面板 ~10Hz 刷新，n = 已记录 tick 数。
   */
  deviStats(): {
    n: number;
    mean: number;
    max: number;
    green: number;
    yellow: number;
    red: number;
    perp: DistStats;
    residual: DistStats;
  } {
    return {
      n: this.deviCount,
      mean: this.deviCount ? this.deviSum / this.deviCount : 0,
      max: this.deviMax,
      green: this.deviGreen,
      yellow: this.deviYellow,
      red: this.deviRed,
      perp: this.perpStats(),
      residual: this.residualStats(),
    };
  }

  /** 垂距分布（HU；HUD 近似窗，见 perpDistAt）。 */
  perpStats(): DistStats {
    const vals: number[] = [];
    for (const p of this.tickNodes) if (p.perp !== undefined) vals.push(p.perp);
    return distStats(vals);
  }

  /** 残差分布（HU）；主线程拿不到权威 post-tick 位置时为 n=0。 */
  residualStats(): DistStats {
    const vals: number[] = [];
    for (const p of this.tickNodes) if (p.residual !== undefined) vals.push(p.residual);
    return distStats(vals);
  }

  clear(): void {
    this.renderBuf.clear();
    this.tickBuf.clear();
    this.tickDots.clear();
    this.deviBuf.clear();
    this.renderNodes.length = 0;
    this.recordedRenderCount = 0;
    this.tickNodes.length = 0;
    this.prevRender = null;
    this.prevTick1 = null;
    this.prevTick2 = null;
    this.lastTickVa = -1;
    this.lastTickT = Number.NEGATIVE_INFINITY; // τ 单调守卫同步复位（见 lastTickT）
    this.deviSum = 0;
    this.deviCount = 0;
    this.deviMax = 0;
    this.deviGreen = 0;
    this.deviYellow = 0;
    this.deviRed = 0;
    this.segTotal = 0;
    this.segAxis = 0;
    this.segHard45 = 0;
    this.segDirectLen = 0;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /** 单独控制渲染线显示（对比时先把密集的渲染线关掉，tick 线的粗折角就露出来了）。 */
  setRenderVisible(visible: boolean): void {
    this.renderBuf.object.visible = visible;
  }

  /** 单独控制 tick 线显示（线与点一起）。 */
  setTickVisible(visible: boolean): void {
    this.tickBuf.object.visible = visible;
    this.tickDots.object.visible = visible;
  }
  /** 单独控制偏差梳显示。 */
  setDeviVisible(visible: boolean): void {
    this.deviBuf.object.visible = visible;
  }

  /** 单独控制 tick 节点方点显示（方点在屏幕上连续时会连成"方链"，可关掉只看线）。 */
  setDotsVisible(visible: boolean): void {
    this.tickDots.object.visible = visible;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  /**
   * 导出 JSON（两条线各自独立的时间序列；均为**原始节点**，与绘制方式无关）。
   * - `render` 只含**记录期**节点（`rec` 标记；与绘制折线完全一致，不含开录前的轨迹）
   * - `render` 节点在**内存数组**里的下标 = 渲染采样传输的 `i0`（addRender 恒落点，
   *   见文件头）；导出做了记录期过滤，故导出下标 ≠ `i0`（外部按 `t` 对齐即可）
   * - `tick[i].t` = **渲染时钟 τ**（无投影时为轮询时刻）
   * - `tick[i].residual` = 残差（HU，主线程拿不到时该字段缺省）
   * - `summary` = 垂距 / 偏差梳 / 残差三组统计（面板口径；**验收判定以
   *   debug/scripts/path-acceptance.mjs 为准**——它做全量最近线段搜索）
   */
  toJson(meta?: Record<string, unknown>): string {
    return JSON.stringify(
      {
        schema: 'websurf-debug/phys-path@1',
        generatedAt: new Date().toISOString(),
        unit: 'HU',
        point: 'feet-center (PhysWorld origin: posX/posY/posZ)',
        sampling:
          'render = 主线程 predPhys 每个 rAF 物理步一个节点；' +
          'tick = Worker 权威帧每来一帧新的（V_A 变化）一个节点',
        timebase:
          'render.t = performance.now()（主线程渲染时钟）；' +
          'tick.t = 该帧发布所依据的渲染时钟采样时刻 τ（readPublishedTau；0=未投影 → 轮询时刻）',
        drawing:
          `3D 绘制为分段直线（跳变 >${JUMP_BREAK} HU 处断开），` +
          'tick 段按折角着色：绿 ≤5° / 黄 ≤20° / 红 >20°。本导出为未做任何展开的原始节点',
        meta: meta ?? {},
        summary: this.deviStats(),
        render: this.renderNodes
          .filter((p) => p.rec)
          .map((p) => ({ t: p.t, x: p.x, y: p.y, z: p.z })),
        tick: this.tickNodes.map((p) =>
          p.residual === undefined
            ? { t: p.t, x: p.x, y: p.y, z: p.z }
            : { t: p.t, x: p.x, y: p.y, z: p.z, residual: p.residual },
        ),
      },
      null,
      0,
    );
  }

  /** 导出 CSV（line,t_ms,x_hu,y_hu,z_hu,residual_hu；均为原始节点；render 只含记录期节点）。 */
  toCsv(): string {
    const rows: string[] = ['line,t_ms,x_hu,y_hu,z_hu,residual_hu'];
    for (const p of this.renderNodes) {
      if (!p.rec) continue;
      rows.push(`render,${p.t.toFixed(3)},${p.x},${p.y},${p.z},`);
    }
    for (const p of this.tickNodes) {
      const r = p.residual === undefined ? '' : p.residual.toFixed(3);
      rows.push(`tick,${p.t.toFixed(3)},${p.x},${p.y},${p.z},${r}`);
    }
    return rows.join('\n');
  }

  dispose(): void {
    this.renderBuf.dispose();
    this.tickBuf.dispose();
  }
}
