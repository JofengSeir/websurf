/**
 * 物理路径记录器：把两条物理计算线的**脚底中心点**轨迹各记成一串节点，供 debug 面板绘制、
 * 统计与导出。
 *
 * 两条线各自按**计算节点**采样，不做定时轮询：
 * - **渲染物理线**：主线程 `predPhys`。上游调用点 `apps/debug/src/renderer/renderer-main.ts`
 *   的 `addRender` 在每个 rAF 物理步里调一次（推进物理、读 `predPhys.state()` 之后），
 *   故节点率 = 渲染帧率。
 * - **tick 物理线**：Worker 权威帧。同一文件的 `addTick` 只在权威帧版本号 `V_A` 变化时落点，
 *   故节点率 = 权威固定步长的倒数。该步长由面板 `tickRate` 经
 *   `apps/debug/src/worker/main.ts` 的 `getConfigTickRate` / `onTickRateChange` 交给
 *   `src/ts-shared/auth/auth-loop.ts` 的 `AuthLoop.setFixedDt`。
 *
 * 点位语义：两条线都取 `PhysWorld` 状态的三元组 `(posX, posY, posZ)`，即物理原点；同一次
 * 状态读取里 `camY = posY + eyeHeight` 才是眼睛位置，故该原点是**脚底中心**。
 *
 * 绘制约定：节点之间**直连直线段**（节点处即硬转折），不插值、不展开成轴对齐阶梯；
 * 相邻节点距离 > `JUMP_BREAK` 处不连线（传送/重生会拉出横跨地图的假直线）。
 *
 * **render 节点索引空间与渲染采样传输共享**：`addRender` 恒 append，使记录器的 render 节点
 * 下标与调用点 `shared.writeRenderSample(..., i0, ...)` 的 `i0` 一一对应（Worker 据此把发布
 * 位置标成「渲染轨迹上的第 i0 个采样点」，见 `src/ts-shared/auth/shared-state.ts` 的
 * `writeRenderSample` / `readRenderSample`）。绘制、导出、计数另受 `rec` 标记门控。
 * 两个索引空间同步重启的唯一入口是 `clear`：调用点的 `clearPath` 同时调 `PathRecorder.clear()`
 * 并把渲染采样序号归零。因此导出里的 render 数组是「记录期子集」，其下标不等于 `i0`
 * （离线消费按 `t` 对齐）。
 *
 * **tick 节点的时间戳由调用方给出**，本文件不取时钟：调用点传
 * `shared.readPublishedTau() > 0 ? τ : now`——τ 是本帧发布所依据的渲染采样时刻，未投影时
 * `readPublishedTau()` 返回 0，调用点回落到轮询时刻 `now`。`addTick` 只对它做非递减钳制
 * （见 `lastTickT`）。
 *
 * **三个距离量是三件不同的事，不可互相替代**：
 * - **垂距** `PathPoint.perp`：tick 点到渲染折线的最短距离（投影钳位到线段）。本文件只扫
 *   `±PERP_WINDOW_MS` 时间窗内的线段，属面板实时指示；验收度量在
 *   `apps/debug/scripts/path-acceptance.mjs`——它对全部合格线段建 AABB BVH 做全量最近搜索，
 *   并在统计前剔除跳变邻近窗，两者口径不同。
 * - **偏差梳** `deviStats()` 的 `mean/max/green/yellow/red`：tick 点与**同一时刻**渲染位置的
 *   差（按 `t` 在渲染节点间线性插值），含切向滞后，会被传送放大。
 * - **残差** `PathPoint.residual`：权威自身 post-tick 位置与发布（投影）位置的距离，
 *   由调用方传入；本仓唯一调用点传 `undefined`，故当前无数据。
 */
import * as THREE from 'three';

/** 路径节点。 */
export interface PathPoint {
  /** 时间戳（ms）：render 节点为主线程 `performance.now()`；tick 节点的取值见文件头。 */
  t: number;
  /** 脚底中心坐标（HU）——`PhysWorld` 状态的三元组原样，不做任何换算。 */
  x: number;
  y: number;
  z: number;
  /** 残差（HU）：权威自身 post-tick 位置与发布（投影）位置的距离；仅 tick 节点、且调用方传入有限值时才存在。 */
  residual?: number;
  /** 垂距（HU）：该 tick 点到渲染折线的最短距离；仅当 `perpDistAt` 返回有限值时才存在。 */
  perp?: number;
  /**
   * 该 render 节点是**在记录状态下**落点的（绘制/导出/计数只看它）。
   * `addRender` 恒 append（索引空间与采样传输共享），但只有 `rec` 为真的节点才连线与导出
   * ——开录前的节点只用于对齐 `i0`，不进导出文件。
   */
  rec?: boolean;
}

/** 一组距离值的分布统计（HU）。 */
export interface DistStats {
  /** 样本数。 */
  n: number;
  /** 算术平均。 */
  mean: number;
  /** 最近秩中位数。 */
  p50: number;
  /** 最近秩 95 分位。 */
  p95: number;
  /** 最大值。 */
  max: number;
}

/** 空统计：n=0，其余字段为 0（不是 NaN，便于 UI 直接 `toFixed`）。`distStats` 在空输入时返回的就是
 *  这个模块级对象本身（同一引用，调用方只读）。 */
const EMPTY_STATS: DistStats = { n: 0, mean: 0, p50: 0, p95: 0, max: 0 };

/** 最近秩分位数 `sorted[min(n-1, floor(n*q))]`（与 `apps/debug/scripts/path-acceptance.mjs` 的 `pct` 同定义）。
 *  `sorted` 须已升序；空数组返回 0。 */
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/** 距离分布统计（mean/中位/p95/最大）：先复制再升序排序，O(n log n)；空输入返回 `EMPTY_STATS`。 */
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
/** tick 物理线的线与节点方点颜色（琥珀）。 */
const TICK_COLOR = 0xf59e0b;
/** 偏差梳颜色（洋红）：每段连一个 tick 节点与其同时刻的渲染位置。 */
const DEVI_COLOR = 0xff3bd0;
/** 每个缓冲的初始顶点容量；写满时由 `LineBuffer.grow` 翻倍。 */
const INITIAL_CAP = 8192;

/** 缓冲绘制模式：`'line'` 节点直连、`'points'` 节点标记、`'segments'` 顶点成对成段。 */
type BufMode = 'line' | 'points' | 'segments';

/**
 * 跳变阈值（HU）：相邻节点距离超过它就不连线——既不画线段，也不把该段算进垂距候选与
 * 形状自检。传送/重生会造成远超此值的位移，连起来是一条横跨地图的假直线。
 */
const JUMP_BREAK = 100;

/**
 * 面板垂距的**近似**时间窗（ms，单侧）。
 *
 * `perpDistAt` 只扫 `[t−此值, t+此值]` 内的渲染线段；`apps/debug/scripts/path-acceptance.mjs`
 * 对全部合格线段做全量最近搜索，并在统计前剔除跳变邻近窗。两者口径不同：本值只用于面板
 * 实时观察（是否接近 0 / 有无趋势），判定以脚本为准（`apps/debug/package.json` 的
 * `test:path-acceptance`，CI 的 debug job 调用）。
 */
const PERP_WINDOW_MS = 250;

/** tick 段按折角着色，只有两档：≤20° 保持 tick 线本色（琥珀），>20° 染红标出硬折角。
 *  返回顶点色三元组（0..1 的分量）。 */
function turnColor(deg: number): [number, number, number] {
  if (deg <= 20) return [0.96, 0.62, 0.04]; // 琥珀 = TICK_COLOR 分量除以 255
  return [1.0, 0.15, 0.15]; // 红：>20° 的硬折角
}

/** 偏差梳按偏差大小分级着色（HU）：≤10 绿、≤30 黄、>30 红；门限与 `deviGreen`/`deviYellow`/`deviRed` 计数一致。 */
function deviColor(hu: number): [number, number, number] {
  if (hu <= 10) return [0.15, 0.85, 0.4]; // 绿：小偏差
  if (hu <= 30) return [1.0, 0.85, 0.15]; // 黄：中等偏差
  return [1.0, 0.15, 0.15]; // 红：大偏差
}

/** 两点距离是否超过 `JUMP_BREAK`（跳变：传送/重生）。 */
function isJump(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > JUMP_BREAK;
}

/** 三点折角（度，0 = 共线）：取 `a→b` 与 `b→c` 两段的夹角；任一段长度 < 1e-9 时返回 0。
 *  余弦先钳位到 [-1, 1] 再 `acos`，避免浮点越界得到 NaN。 */
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

/** 单条线的动态顶点缓冲：预分配 + 写满翻倍 + `setDrawRange` 增量绘制。
 *  - `'line'`      → `THREE.Line`（节点直连）
 *  - `'points'`    → `THREE.Points`（节点标记，屏幕尺寸恒定）
 *  - `'segments'`  → `THREE.LineSegments`（顶点成对，每对一段）
 *  `length` 是**顶点数**：`'segments'` 下等于段数乘 2。
 *  材质统一 `transparent` + `opacity 0.95` + `depthWrite = false`；`depthTest` 只对 `'line'`
 *  模式为真（`mode !== 'segments'`），`'points'` 模式另显式设为 false，故本文件的四个实例
 *  都不参与深度测试、被墙挡住也照画。 */
class LineBuffer {
  /** 挂到组里的绘制对象（`Line` / `LineSegments` / `Points`）。 */
  readonly object: THREE.Object3D;
  /** 与 `object` 同源的材质（`LineBasicMaterial` 或 `PointsMaterial`），`dispose` 用。 */
  private readonly mat: THREE.Material;
  /** 顶点坐标数组（长度 = 容量 × 3），翻倍时整体换新数组。 */
  private pos: Float32Array;
  private attr: THREE.BufferAttribute;
  /** 顶点色数组；仅 `useColors` 为真时创建。 */
  private col: Float32Array | null = null;
  private colAttr: THREE.BufferAttribute | null = null;
  private readonly geo: THREE.BufferGeometry;
  /** 已写入的顶点数。 */
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
      // 节点标记：PointsMaterial 不吃光照；sizeAttenuation=false 使屏幕尺寸恒定，depthTest=false 使其不被遮挡
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
        // 'segments' 模式（tick 段与偏差梳）关深度测试：这些线就是用来读数值的，不能被墙挡住
        depthTest: mode !== 'segments',
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
      });
      this.object = mode === 'segments' ? new THREE.LineSegments(this.geo, mat) : new THREE.Line(this.geo, mat);
      this.mat = mat;
    }
    // 路径可横跨整张图：关掉视锥/包围球剔除，避免整条线被一次性剔掉
    this.object.frustumCulled = false;
    this.object.renderOrder = renderOrder;
    this.object.name = 'phys-path-line';
  }

  /** 已写入的顶点数（`'segments'` 下 = 段数 × 2）。 */
  get length(): number {
    return this.count;
  }

  /** 容量翻倍。`BufferAttribute` 不能改底层数组长度，故新建数组 + 新建 attribute 再挂回几何体；
   *  `drawRange` 存在几何体上，替换 attribute 不影响它。 */
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

  /** 追加一个顶点（写满则先 `grow`）。`rgb` 只在构造时 `useColors` 为真且本次传入时写入颜色槽；
   *  否则颜色槽该顶点的三个分量保持 0。本文件里两个 `useColors` 为真的缓冲每个顶点都传了 `rgb`。 */
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

  /** 压入一段（成对顶点，同色）——`'segments'` 模式用；两顶点各走一次 `push`，
   *  调用方按跳变与否决定整段压不压（不压即自然断开）。 */
  pushPair(
    a: [number, number, number],
    b: [number, number, number],
    rgb: [number, number, number],
  ): void {
    this.push(a[0], a[1], a[2], rgb);
    this.push(b[0], b[1], b[2], rgb);
  }

  /** 计数与绘制范围归零（不释放数组、不清颜色槽、不动 attribute）。 */
  clear(): void {
    this.count = 0;
    this.geo.setDrawRange(0, 0);
  }

  /** 前 `count` 个顶点的坐标**视图**（`subarray`，与内部缓冲共享内存）：只读使用；
   *  `grow` 换数组后旧视图不再跟随。 */
  positions(): Float32Array {
    return this.pos.subarray(0, this.count * 3);
  }

  /** 释放几何体与材质（不释放坐标/颜色数组，也不把对象从组里摘除）。 */
  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

/**
 * 两条物理线的路径记录器：一个场景组 + 四个绘制缓冲 + 两份节点真值 + 统计累加量。
 *
 * 上游（写）：`apps/debug/src/renderer/renderer-main.ts` 在同一个 rAF 物理步里先按新到的
 * 权威帧调 `addTick`，再推进 `predPhys.tick` 并读状态调 `addRender`；`residual` 恒传
 * `undefined`。
 * 下游（读）：同文件的 `counts` / `deviStats` / `shapeStats` / `exportPathJson` /
 * `exportPathCsv` / 各组 `set*Visible`，再经 `apps/debug/src/app.ts` 的 `updatePathCountsUI`
 * 与两个导出按钮落到 UI 与文件。
 *
 * 生命周期：`group` 只被渲染器挂进场景一次；本文件的 `dispose` 在本仓**无调用点**，
 * 换图走的 `disposeScene` 也只摘除带 `userData.isBspModel` 的子节点，故路径组与已记录的
 * 节点都跨地图保留，直到显式 `clear`。
 *
 * 不变量：
 * - `counts().render` 与 `renderNodes` 中 `rec` 为真的个数同步（两者都只在 `addRender`
 *   的记录分支里 +1）；
 * - render 节点下标与调用点的渲染采样序号同空间，唯一同步重启点是 `clear`（见文件头）；
 * - 一次录制内 tick 节点时间戳非递减（见 `lastTickT`）；
 * - 跳变段既不进绘制缓冲、也不进 `shapeStats` 的段计数、也不进偏差梳统计。
 */
export class PathRecorder {
  /** 挂进场景的组（两条线 + tick 节点方点 + 偏差梳四个对象），组名固定 `'phys-path'`。 */
  readonly group = new THREE.Group();
  /** render 线的**绘制**缓冲（分段、固定色；节点真值是 `renderNodes`）。 */
  private readonly renderBuf = new LineBuffer(RENDER_COLOR, 1, 'segments');
  /** tick 线的**绘制**缓冲（分段、顶点色按折角；计数与导出用 `tickNodes`）。 */
  private readonly tickBuf = new LineBuffer(TICK_COLOR, 2, 'segments', 4, true);
  /** tick 节点方点缓冲（`'points'` 模式，屏幕尺寸恒定，跳变点也会落点）。 */
  private readonly tickDots = new LineBuffer(TICK_COLOR, 4, 'points', 4);
  /** 偏差梳缓冲（分段、顶点色按偏差分级）。 */
  private readonly deviBuf = new LineBuffer(DEVI_COLOR, 5, 'segments', 4, true);
  /** render 线节点真值：含未记录期 append 的节点（绘制/导出/垂距参照都读这份）。 */
  private renderNodes: PathPoint[] = [];
  /** 记录期落点的 render 节点数（= `counts().render`；见 `addRender`）。 */
  private recordedRenderCount = 0;
  /** tick 线节点真值（也是导出与统计的口径）。 */
  private tickNodes: PathPoint[] = [];
  /** 分段绘制用：上一个**已记录**的 render 节点；未记录时不更新，跳变时照常前移（只跳过连线）。 */
  private prevRender: PathPoint | null = null;
  /** 最近两个已落点的 tick 节点：着色需要 `prevTick2 → prevTick1 → p` 三点折角。 */
  private prevTick1: PathPoint | null = null;
  private prevTick2: PathPoint | null = null;
  /** 记录开关：`start`/`stop` 写，`addTick`/`addRender`/导出/计数读。 */
  private recording = false;
  /** 上一次已记录的权威帧版本号（`V_A` 自 1 起递增，故 -1 与任何真实帧都不等）。 */
  private lastTickVa = -1;
  /**
   * 上一个 tick 节点的时间戳（**非递减守卫**）。
   *
   * `addTick` 不假设调用方给的 `t` 递增：同一对渲染样本会被相邻两帧复用，调用点也会
   * 回落到轮询时刻。本字段把 `t` 钳到 `max(t, lastTickT)`（允许相等）。
   *
   * 下游依赖升序：本文件的 `sampleRenderAt` / `perpDistAt` 用二分查找；导出后
   * `apps/debug/scripts/path-acceptance.mjs` 也逐点检查时间戳，非单调即判数据非法并拒绝整份文件。
   *
   * 不变量：一次录制内 tick 时间戳非递减。注意只有 `clear` 会复位本字段，`stop`/`start`
   * 不复位，故分段累加时守卫跨段延续。
   */
  private lastTickT = Number.NEGATIVE_INFINITY;
  /** 偏差梳累加量（HU）：和、计数、最大值（均为时间对齐偏差）。 */
  private deviSum = 0;
  private deviCount = 0;
  private deviMax = 0;
  /** 偏差梳分级计数（≤10 / ≤30 / >30 HU，门限与 `deviColor` 一致）。 */
  private deviGreen = 0;
  private deviYellow = 0;
  private deviRed = 0;
  /**
   * **折线形状自检**的累加量（面板实时显示）：用于判定画出来的折线是否被展开成轴对齐阶梯。
   * 三个计数都只统计**非跳变**的 tick 段；`segAxis` 记单轴占比 > 0.99 的段数，`segHard45`
   * 记折角 > 45° 的段数；`segDirectLen` 累加这些段的节点间距，供 `shapeStats` 与实际
   * 绘制长度比。
   */
  private segTotal = 0;
  private segAxis = 0;
  private segHard45 = 0;
  /** 非跳变 tick 段的节点间距之和（与绘制缓冲实际长度比 → 是否被展开成阶梯）。 */
  private segDirectLen = 0;

  /** 建组（组名 `'phys-path'`）并把四个绘制对象一次挂入。 */
  constructor() {
    this.group.name = 'phys-path';
    this.group.add(this.renderBuf.object, this.tickBuf.object, this.tickDots.object, this.deviBuf.object);
  }

  /** 是否正在记录（读 `recording` 开关）。 */
  get isRecording(): boolean {
    return this.recording;
  }

  /** 开始记录。**不清空**已有节点（便于分多段累加；要清空请显式调 `clear`）。
   *  同时把 `lastTickVa` 置 -1：停/启之间会跨过重生或换图，下一个权威帧必须无条件落点。 */
  start(): void {
    this.recording = true;
    // 重新开始会跨越重生/换图：把版本号哨兵复位，使下一个权威帧无条件记一次
    this.lastTickVa = -1;
  }

  /** 停止记录（已落点保留，`start` 后继续累加到同一份数据）。 */
  stop(): void {
    this.recording = false;
  }

  /**
   * 点数统计（UI 显示用；均为**节点数**，不是绘制顶点数）。
   * `render` = **记录期**落点数（不含为对齐索引空间而 append 的未记录节点，见 `addRender`）；
   * `tick` = tick 节点数。
   */
  counts(): { render: number; tick: number } {
    return { render: this.recordedRenderCount, tick: this.tickNodes.length };
  }

  /**
   * 记一个渲染物理节点。调用点 `apps/debug/src/renderer/renderer-main.ts` 在每个 rAF 物理步
   * 里调一次（`predPhys.tick` 之后读 `predPhys.state()`）。
   *
   * **恒 append**：不在记录状态时也压入 `renderNodes`——记录器的 render 节点下标必须与调用点
   * `shared.writeRenderSample(..., i0, ...)` 的 `i0` 一一对应，中途少压一个节点就会整体错位。
   * 绘制、导出、计数只看 `rec`：未记录时不更新 `prevRender`、不连线、不计数、不进导出。
   * @param t 主线程 `performance.now()`（ms）
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
   * 记一个 tick 物理节点（Worker 权威帧）。**仅当 `va` 变化**才落点；未在记录时直接返回，
   * 连 `lastTickVa` 也不更新。
   *
   * 落点内容与副作用：
   * - 与上一个 tick 节点构成跳变（距离 > `JUMP_BREAK`）时不做三件事：不进绘制缓冲、不进
   *   偏差梳、不进形状自检计数；节点本身照常进 `tickDots` 与 `tickNodes`，两个 `prevTick`
   *   也照常前移，于是线在跳变处自然断开。
   * - 非跳变时压一段 `tickBuf`：段色取该段**起点处**的折角（由 `prevTick2 → prevTick1 → p`
   *   三点算出；没有 `prevTick2` 时按 0° 处理）。
   * - 同时算垂距（`perpDistAt`，只有有限值才写进 `perp`）与偏差梳（`sampleRenderAt` 取同时刻
   *   渲染位置；取不到则本点不计入偏差统计）。
   * @param va 权威帧版本号 `V_A`（自 1 起；0 表示通道未开始，调用点拿不到）
   * @param t 本节点时间戳（ms）：调用点传 `shared.readPublishedTau() > 0 ? τ : 轮询时刻`
   * @param residual 残差（HU）：权威自身 post-tick 位置与发布位置的距离；调用点无此数据时传 `undefined`
   */
  addTick(va: number, t: number, x: number, y: number, z: number, residual?: number): void {
    if (!this.recording) return;
    if (va === this.lastTickVa) return;
    this.lastTickVa = va;
    // 非递减钳制（见 lastTickT）：本文件不判断 t 的来源，只保证导出与二分查找所需的升序
    if (t < this.lastTickT) t = this.lastTickT;
    else this.lastTickT = t;
    const p: PathPoint = { t, x, y, z };
    if (residual !== undefined && Number.isFinite(residual)) p.residual = residual;
    // 垂距（面板近似窗；全量口径见 apps/debug/scripts/path-acceptance.mjs）
    const perp = this.perpDistAt(t, x, y, z);
    if (Number.isFinite(perp)) p.perp = perp;
    const p1 = this.prevTick1;
    const p2 = this.prevTick2;
    // 跳变那一拍两线会因时序差异短暂拉开很远，那不是物理分歧：排除它，否则偏差统计与着色被传送污染
    const jumped = p1 !== null && isJump(p1, p);
    if (p1 && !jumped) {
      // 段 (p1→p) 的颜色取 p1 处的折角（由 p2→p1→p 决定；无 p2 时按 0° 处理）
      const turn = p2 ? turnDeg(p2, p1, p) : 0;
      this.tickBuf.pushPair([p1.x, p1.y, p1.z], [x, y, z], turnColor(turn));
      // 形状自检：轴对齐段占比 + 硬折角段占比（都只统计非跳变段）
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
    // 偏差梳：连到渲染线「同一时刻」的位置（时间对齐插值，不是最近点）
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

  /** 在渲染节点链上按 `t` 线性插值出位置（偏差梳用）。读 `renderNodes`（含未记录期的节点），
   *  与绘制缓冲无关；`t` 在链首之前或链尾之后时取端点，链为空时返回 null。
   *  二分查找要求 `renderNodes` 的 `t` 已升序（调用点每个 rAF 追加一个递增的 `performance.now()`）。 */
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
   * 垂距（面板用，**近似**）：点 p 到渲染折线的**最短距离**，与
   * `apps/debug/scripts/path-acceptance.mjs` 的度量同定义——
   *   d = min over 合格线段 的 |p − proj_clamped(p, seg)|，
   *   合格线段 = 长度 ≤ `JUMP_BREAK`（更长的段被跳过，零长段也跳过）。
   *
   * **与脚本的差异（刻意）**：本方法只扫 `[t−PERP_WINDOW_MS, t+PERP_WINDOW_MS]` 内的线段
   * （此刻尚未 append 的节点天然不在窗内，故参照 `renderNodes` 的当前内容）；脚本对全部
   * 合格线段做全量最近搜索，并在统计前剔除跳变邻近窗。判定以脚本为准，这里只作实时指示。
   * @returns 最短距离（HU）；`renderNodes` 少于 2 个时 NaN；有节点但窗口内没有合格线段时为
   *          +Infinity（调用点据此不写入 `perp`）
   */
  private perpDistAt(t: number, x: number, y: number, z: number): number {
    const R = this.renderNodes;
    const n = R.length;
    if (n < 2) return NaN;
    const t0 = t - PERP_WINDOW_MS;
    const t1 = t + PERP_WINDOW_MS;
    // 二分：取最后一个 t < t0 的节点作为起点，使跨越窗口左界的线段也参与
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
      if (l2 < 1e-12) continue; // 零长段没有方向，跳过（离线脚本对同一情形也跳过）
      if (l2 > JUMP_BREAK * JUMP_BREAK) continue; // 超过跳变阈值：渲染器不连线，此处也不算候选
      let s = ((x - a.x) * dx + (y - a.y) * dy + (z - a.z) * dz) / l2;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      const d = Math.hypot(x - (a.x + dx * s), y - (a.y + dy * s), z - (a.z + dz * s));
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * 折线形状自检（面板显示）。**决定性判据**是 `lenRatio` = 绘制缓冲实际总长 ÷ 节点间直线
   * 总长：节点直连恒为 1；被展开成轴对齐阶梯时显著大于 1。`axis`（单轴占比 > 0.99 的段数）
   * 单独看不可靠——竖直下落时相邻节点本就只差一轴。
   * `drawnLen` 按 `tickBuf` 的顶点对累加，只含非跳变段；`directLen` 用同批段的节点间距。
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
   * - `perp`：垂距（面板 ±`PERP_WINDOW_MS` 近似窗，见 `perpDistAt`）
   * - `n/mean/max/green/yellow/red`：偏差梳（**时间对齐**，tick 点对同时刻渲染位置）
   * - `residual`：残差（见 `residualStats`）
   * 每次调用 O(n log n)（分位数要排序）；`n` 是已计入偏差统计的 tick 点数。
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

  /** 垂距分布（HU）：只取已写入 `perp` 的 tick 节点，故 `n` 可小于 tick 点数；近似窗见 `perpDistAt`。 */
  perpStats(): DistStats {
    const vals: number[] = [];
    for (const p of this.tickNodes) if (p.perp !== undefined) vals.push(p.perp);
    return distStats(vals);
  }

  /** 残差分布（HU）：只取已写入 `residual` 的 tick 节点；本仓调用点恒传 `undefined`，故当前为 `n=0` 的空统计。 */
  residualStats(): DistStats {
    const vals: number[] = [];
    for (const p of this.tickNodes) if (p.residual !== undefined) vals.push(p.residual);
    return distStats(vals);
  }

  /** 清空两份节点数组、四个绘制缓冲与全部统计累加量，并把 `prevRender`/两个 `prevTick`、
   *  `lastTickVa`、`lastTickT` 复位到初值；**不改** `recording`（清数据不改变记录状态）。
   *  调用点 `apps/debug/src/renderer/renderer-main.ts` 的 `clearPath` 与本方法配对：那里同时
   *  把渲染采样序号归零，两个索引空间才重新对齐（见文件头）。 */
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
    this.lastTickT = Number.NEGATIVE_INFINITY; // 非递减守卫同步复位（见 lastTickT）
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

  /** 整组显隐：一次切换两条线、tick 节点方点与偏差梳。 */
  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /** 单独控制 render 线显隐（关掉密集的 render 线，tick 线的折角更容易看清）。 */
  setRenderVisible(visible: boolean): void {
    this.renderBuf.object.visible = visible;
  }

  /** 单独控制 tick 线显隐：线与节点方点一起切换。 */
  setTickVisible(visible: boolean): void {
    this.tickBuf.object.visible = visible;
    this.tickDots.object.visible = visible;
  }
  /** 单独控制偏差梳显隐。 */
  setDeviVisible(visible: boolean): void {
    this.deviBuf.object.visible = visible;
  }

  /** 单独控制 tick 节点方点显隐（方点密集时会在屏幕上连成链，可只留线）。 */
  setDotsVisible(visible: boolean): void {
    this.tickDots.object.visible = visible;
  }

  /** 组当前的可见性（`setVisible` 写的值）。 */
  get visible(): boolean {
    return this.group.visible;
  }

  /**
   * 导出 JSON。字段顺序按代码固定为：
   * `schema` / `generatedAt` / `unit` / `point` / `sampling` / `timebase` / `drawing` / `meta` /
   * `summary` / `render` / `tick`，`JSON.stringify` 缩进为 0（单行文本）。
   * - `schema`/`unit`/`point`/`sampling`/`timebase`/`drawing` 是写死的说明性字符串（代码字面量）
   * - `meta` = 调用方传入的会话标签（缺省为 `{}`；调用点传 source/href/recordedAt）
   * - `summary` = `deviStats()`（垂距 / 偏差梳 / 残差三组统计）
   * - `render`：只含 `rec` 为真的记录期节点，每项 `{t,x,y,z}`——是 `renderNodes` 的子集，
   *   故其下标不等于渲染采样传输的 `i0`（见文件头），外部按 `t` 对齐
   * - `tick`：每项 `{t,x,y,z}`，仅当该节点有 `residual` 时多一个 `residual` 字段
   * 注意 `sampling`/`timebase`/`drawing` 是**代码里的字符串字面量**：`drawing` 对折角着色的描述
   * 是三档，而 `turnColor` 实际只有两档（≤20° 琥珀 / >20° 红），本注释不改变该字面量。
   * 读法：`apps/debug/scripts/path-acceptance.mjs` 与 `apps/debug/scripts/plot-path.mjs`
   * 都只读 `render`/`tick` 两个数组（后者还要求两者都非空）。
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

  /** 导出 CSV：首行表头 `line,t_ms,x_hu,y_hu,z_hu,residual_hu`；随后先 render 行（只含 `rec`
   *  为真的记录期节点，残差列留空）再 tick 行（无残差时同样留空）。时间戳与残差保留三位小数，
   *  坐标为原始数值，行分隔符 `\n`。 */
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

  /** 释放 render 线与 tick 线的几何体与材质；tick 节点方点与偏差梳两个缓冲不在其中。
   *  本仓无调用点（见类头注的「生命周期」）。 */
  dispose(): void {
    this.renderBuf.dispose();
    this.tickBuf.dispose();
  }
}
