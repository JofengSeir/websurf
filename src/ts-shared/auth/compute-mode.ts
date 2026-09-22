/**
 * 计算模式：三值枚举 + 双线互斥门谓词 + 模式切换交接矩阵。
 *
 * ## 定位
 * `ComputeMode` 的唯一定义处（`src/ts-shared/decoupled/decoupled-loop.ts` 以
 * `export type { ComputeMode }` 原样再导出同一类型）。消费点：
 * - `src/ts-shared/auth/auth-loop.ts`：用 `isAuthLineMode` 作缺省模式门（`resolveAuthGateOpen`）；
 * - `src/ts-shared/auth/worker-dispatch.ts`：用 `ComputeMode` 做 `set-mode` 消息的三值白名单校验，
 *   并只在模式确实变化时调用 `onSetMode` 钩子；
 * - `src/ts-shared/auth/compute-mode.test.ts`：断言两个谓词互斥、矩阵每行的两个 `*After`
 *   字段等于对 `to` 调谓词的结果、四向 tick 行齐备。
 *
 * ## 两条线互斥
 * `coupled` 与 `tick` 由 auth 线推进，`decoupled` 由解耦线推进；两个谓词对任一模式
 * **恰好一真**，即同一时刻只有一条线驱动唯一物理实例。
 *
 * ## 接线现状（实测）
 * `src/ts-shared` 之外没有装配点：`apps/**` 内没有 `compute-mode` 的 import，没有发送
 * `set-mode` 消息的代码，也没有注入 `getComputeMode` / `onSetMode` 钩子。因此
 * `worker-dispatch.ts` 与 `auth-loop.ts` 里的 `?? 'coupled'` 兜底始终生效，
 * 线上行为等同于 `coupled` 模式。
 *
 * ## 本文件无运行时状态
 * 只有两个纯谓词、一个纯换算函数与一张常量矩阵；不持有计时器、不读共享内存、不做 IO。
 */

/**
 * 计算模式取值。三处共用同一组字面量：模式门谓词的入参、`set-mode` 消息的白名单、
 * 交接矩阵的端点。当前值由 Worker 侧持有，经 `getComputeMode` 钩子读出。
 */
export type ComputeMode = 'coupled' | 'decoupled' | 'tick';

/**
 * auth 线是否推进：`coupled` 与 `tick` 为真。`decoupled` 下 auth 线早退，写槽权交给解耦线。
 *
 * 消费点：`src/ts-shared/auth/auth-loop.ts` 的 `resolveAuthGateOpen` —— 调用方注入显式
 * `modeGate` 时以它为准，否则用本谓词判 `getComputeMode()` 的取值。
 */
export function isAuthLineMode(mode: ComputeMode): boolean {
  return mode !== 'decoupled';
}

/**
 * 解耦线是否推进：仅 `decoupled` 为真。
 *
 * 与 `isAuthLineMode` 构成互补对（任一模式恰好一真）。**生产路径零调用点**——
 * 目前只有 `src/ts-shared/auth/compute-mode.test.ts` 引用它做互斥断言。
 */
export function isDecoupledLineMode(mode: ComputeMode): boolean {
  return mode === 'decoupled';
}

/**
 * 按模式把面板 tickRate 换算成权威固定步长（Hz）：`tick` 取原值，其余模式加偏移。
 *
 * **本仓零调用点**（`src/**` 与 `apps/**` 内均无引用）。两个工程实际走各自的
 * `getConfigTickRate()` 钩子并返回面板原值——`apps/debug/src/worker/main.ts` 与
 * `apps/game/src/worker/main.ts` 都写作 `() => config.physics.tickRate`，
 * 因此权威固定步长恒为 `1 / 面板值`，不带偏移。
 *
 * @param mode 计算模式；只有 `'tick'` 走不加偏移的分支。
 * @param panelTickRate 面板 tickRate（Hz）。
 * @param coupledOffset 非 tick 模式下叠加的偏移（Hz）。
 * @returns 权威固定步长（Hz）。
 */
export function resolveAuthTickRate(
  mode: ComputeMode,
  panelTickRate: number,
  coupledOffset: number,
): number {
  return mode === 'tick' ? panelTickRate : panelTickRate + coupledOffset;
}

/**
 * 交接矩阵的一行：描述「从 `from` 切到 `to`」落定后的线状态与注入要求。
 *
 * - `authLineAfter` / `decoupledLineAfter`：交接后两条线是否推进。取值必须分别等于
 *   `isAuthLineMode(to)` 与 `isDecoupledLineMode(to)`——属冗余编码，测试逐行交叉核对；
 * - `stateInject`：本次交接是否需要由主线程向 Worker 注入完整渲染态
 *   （`SyncRenderStateLike`，随 `set-mode` 消息的 `state` 字段携带）；
 * - `summary`：交接步骤的文本摘要（**是数据，不是注释**）。
 */
export interface ModeHandoverRow {
  from: ComputeMode;
  to: ComputeMode;
  authLineAfter: boolean;
  decoupledLineAfter: boolean;
  stateInject: boolean;
  summary: string;
}

/**
 * 六个方向各一行——三模式两两互切，不含同模式自切（`coupled↔decoupled` 两行、
 * `coupled↔tick` 两行、`decoupled↔tick` 两行）。
 *
 * 矩阵本身不驱动运行时行为：它是对外可读的常量数据，由测试与文档消费。
 * `summary` 字段的文本是数据，本次注释重编不改动其内容。
 */
export const MODE_HANDOVER_MATRIX: readonly ModeHandoverRow[] = [
  {
    from: 'coupled',
    to: 'decoupled',
    authLineAfter: false,
    decoupledLineAfter: true,
    stateInject: true,
    summary: '既有行（存档）：gate 翻转 + state 注入 + tickPhys 对齐 + 采样器清零 + resetInput（§3.4.C 步骤 a-f）',
  },
  {
    from: 'decoupled',
    to: 'coupled',
    authLineAfter: true,
    decoupledLineAfter: false,
    stateInject: false,
    summary: '既有行（存档）：worker phys 即真理源免注入；setFixedDt(rate+3)+reset + publishCurrentState 写切换时刻态',
  },
  {
    from: 'coupled',
    to: 'tick',
    authLineAfter: true,
    decoupledLineAfter: false,
    stateInject: true,
    summary: 'tick 行①：state 注入（主线程 predPhys 全态 9 字段，复用 coupled→decoupled 同款通道）+ resetInput + setFixedDt(1/rawRate)+reset（仅清累积器，不动物理状态）+ publishCurrentState',
  },
  {
    from: 'decoupled',
    to: 'tick',
    authLineAfter: true,
    decoupledLineAfter: false,
    stateInject: false,
    summary: 'tick 行②：零状态注入（worker phys 实例本来就是解耦模式真理源）+ setFixedDt(1/rawRate)+reset',
  },
  {
    from: 'tick',
    to: 'coupled',
    authLineAfter: true,
    decoupledLineAfter: false,
    stateInject: false,
    summary: 'tick 行③：免注入（auth 线本就在推进）；主线程侧 predPhys.set_state(最新帧 9 字段) 复入 + setFixedDt(rate+3)',
  },
  {
    from: 'tick',
    to: 'decoupled',
    authLineAfter: false,
    decoupledLineAfter: true,
    stateInject: false,
    summary: 'tick 行④：免注入（worker phys 连续）+ resetSamplers(true)（解耦线采样器对齐清零）',
  },
] as const;
