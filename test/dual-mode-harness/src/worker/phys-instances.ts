/**
 * 三实例参数同步（G3 同建同参 · t4 F4-C 地基）。
 *
 * 设计基线：t6-render-ahead §10.1（F4-C 主案：worker 内 scratch 第二实例乐观评估）
 * + §11.1（种子面字段表）+ t3-memo §4.5（参数应用路径数 = 1 论证清单）。
 *
 * 为什么必须同参：F4-C 乐观评估的唯一输入是 `scratch.seed_from(authority)` 的
 * **状态**种子——**参数不在种子面内**（§11.1 排除面：参数由各自实例内部持有）。
 * 因此 scratch 与 authority 的参数一旦分叉，乐观投影就不是同物理函数的同参求值，
 * 修订差 div 会从「截断输入窗」语义污染成「参数分叉」语义（div 双桶遥测失真）。
 * G3「同建同参」= F4-C 有效性的前提，而非可选优化。
 *
 * 调用点唯一：worker `syncParamsToWasm`（world-json 建图 + config 消息两处，读同一
 * config store 同一映射函数 buildPhysicsParams）——本模块把「向 N 个实例扇出」这一
 * 步抽为可测纯扇出函数，令「三实例同参」在 node 下可直接断言（禁浏览器约束）。
 */

/** 参数扇出目标（game pkg PhysWorld / debug pkg 同构满足）。 */
export interface ParamTargetLike {
  set_params(json: string): void;
  set_hull(halfWidth: number, standHeight: number, duckHeight: number): void;
}

/**
 * 向实例列表扇出参数与碰撞箱（顺序敏感：phys → tickPhys → scratch；空槽跳过）。
 * 返回实际应用实例数（观测面：game = 3，debug = 1，无 world = 0）。
 */
export function applyParamsToInstances(
  instances: readonly (ParamTargetLike | null)[],
  paramJson: string,
  halfWidth: number,
  standHeight: number,
  duckHeight: number,
): number {
  let applied = 0;
  for (const inst of instances) {
    if (!inst) continue;
    inst.set_params(paramJson);
    inst.set_hull(halfWidth, standHeight, duckHeight);
    applied++;
  }
  return applied;
}
