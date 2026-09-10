/**
 * 计算模式与双线互斥门谓词（任务 t2 · 协议与门）。
 *
 * 三模式（plan-v2 §1.1 + t3-memo §6 共存矩阵）：
 * - `coupled`：v7 权威线（auth-loop 67Hz，+3 偏移）+ 主线程预测实例双算；
 * - `decoupled`：1ms 无限制真理源 + tickPhys 64t 速度校准线（r2 违例基线，
 *   解耦标注保留——T-a 协议只扩类型，不改其分支行为）；
 * - `tick`（新增）：worker 单 PhysWorld 实例、raw 64Hz 固定 tick、零校准零
 *   锚定零第二实例；主线程零物理实例、纯历史插值消费（P0 逐帧等式）。
 *
 * §3.2 双线互斥门（phys-mode-port）：任意时刻恰一条线推进唯一物理实例——
 * - **auth 线**（auth-loop，t3-memo §2.1 现成引擎复用）：coupled 与 tick 模式
 *   推进，decoupled 模式早退（写槽权移交解耦线）；
 * - **解耦线**（decoupled-loop）：仅 decoupled 模式推进；tick 模式自动早退
 *   （tickPhys 闲置不驱动不 free，set_velocity 通道静默——t3-memo §2.3）。
 * 门关即墙钟冻结（lastWall=0 复位不补跑）——两线共用该性质，切换期无补步。
 *
 * 类型收敛：本文件是 ComputeMode 的唯一权威定义（decoupled-loop.ts re-export
 * 向后兼容）；gate 谓词三值化 = auth 线谓词从「==coupled」改为「!==decoupled」
 * （t3-memo §2.6 唯一触点），解耦线谓词表达式零改、输入类型三值化。
 */

/** 计算模式（worker 侧真相源；仅 set-mode/mode-ack 握手翻转——§3.4.C 纪律，
 * config.physics.computeMode 字段是声明性元数据不绕过握手）。 */
export type ComputeMode = 'coupled' | 'decoupled' | 'tick';

/** auth 线活跃谓词（三值化门——auth-loop 现成引擎复用入口的缺省谓词）。 */
export function isAuthLineMode(mode: ComputeMode): boolean {
  return mode !== 'decoupled';
}

/** 解耦线活跃谓词（tick 模式自动早退；表达式零改——输入类型三值化）。 */
export function isDecoupledLineMode(mode: ComputeMode): boolean {
  return mode === 'decoupled';
}

/**
 * 权威固定步长速率解析（t4 · A4 参数单写链 · P-tick-6 单点收敛）。
 *
 * - `tick`：面板值 **raw 直译**——用户裁定 tickRate=raw 64（无 +3 偏移；偏移仅
 *   耦合权威线语义）。洞见④「64 边形金标准」只有在 raw 语义下成立；评审检查项
 *   P-tick-6 要求 tick 模式 `fixedDt === 1/64` **精确成立**（防耦合 +3 渗入）。
 * - `coupled`：面板值 + 隐藏偏移（用户定调 2026-08-18：面板显示原值，实际权威
 *   步长 = 原值 + 3）。
 * - `decoupled`：本函数返回值**不被消费**（auth 线早退；tickPhys 速率经
 *   decoupled-loop `getTickPhysRate` 另读 raw，§3.4.D）——返回值仅为形式完备。
 *
 * 抽为纯函数 = 参数链唯一可测接缝（main.ts `getConfigTickRate` 的唯一实现源；
 * 「交接/hold/respawn 路径零 set_params」不变式 §4.5 的对照面）。
 */
export function resolveAuthTickRate(
  mode: ComputeMode,
  panelTickRate: number,
  coupledOffset: number,
): number {
  return mode === 'tick' ? panelTickRate : panelTickRate + coupledOffset;
}

/**
 * §3.2 双线互斥门四向交接矩阵（t3-memo §2.2 全表编码）。
 *
 * coupled↔decoupled 两行为既有语义存档（零改）；tick 四行为本任务补录
 * （T-a 交接矩阵联测的数据面）。列语义：
 * - `authLineAfter` / `decoupledLineAfter`：切换落定后各线是否推进物理
 *   （= 两个门谓词对 `to` 的取值，冗余编码供联测断言互斥性质）；
 * - `stateInject`：worker 侧是否执行主线程全态注入 `phys.set_state(9 字段)`
 *   （t3-memo §2.2 b 步——仅「主线程曾持真理」的方向需要）；
 * - `summary`：交接合同一行摘要（worker 侧动作序列锚）。
 */
export interface ModeHandoverRow {
  from: ComputeMode;
  to: ComputeMode;
  authLineAfter: boolean;
  decoupledLineAfter: boolean;
  stateInject: boolean;
  summary: string;
}

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
