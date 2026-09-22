/**
 * 角度换算的 TS 侧唯一实现：`wrapDeg` 与 `bspYawToCsYaw`。
 *
 * 上下游：`bspYawToCsYaw` 把 BSP 出生点实体的 Source yaw 转成 cs-movement yaw，由出生点
 * 解析方调用（`src/ts-shared/phys/world-builder.ts`，以及 debug 的出生点/传送管理）；
 * `wrapDeg` 另被 viewer 的位姿模块使用。
 *
 * 归一约定：`wrapDeg` 先把结果归到 `[0, 360)`，再用 `|| 0` 把 `-0` 收敛成 `+0`
 * ——若保留 `-0`，它会在 `Object.is` 比较与 JSON 序列化上暴露差异。由于 `-0 === 0`
 * 为真，这一收敛不改变任何等值判断或排序结果。
 *
 * **跨工程契约**：同一张地图的出生朝向由本文件的规则唯一确定，三个工程都走这里，
 * 不在各自工程内另写一份模运算。
 */

/** 角度归一到 `[0,360)`；结果为 `-0` 时归一为 `+0`。 */
export function wrapDeg(d: number): number {
  return (((d % 360) + 360) % 360) || 0;
}

/**
 * BSP 出生点实体 Source yaw → cs-movement yaw：`wrap(bspYaw + 180)`。
 *
 * 为什么是 +180：本仓的轴映射把 `[x,y,z]` 循环置换为 `[y,z,x]`（行列式 +1），
 * Source 前向 `(cos yaw, sin yaw)` 置换后成为 `(sin yaw, cos yaw)`；而消费端
 * yaw = 0 对应的前向是 `(−sin, −cos)`，两者相差恰好 180°。
 */
export function bspYawToCsYaw(bspYaw: number): number {
  return wrapDeg(bspYaw + 180);
}
