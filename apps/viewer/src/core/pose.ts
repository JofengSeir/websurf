/**
 * 位姿：人物脚底位置 + 视角（出生点跳转 / HUD 读数 / 回放相机共用）。
 *
 * 本文件职责：
 * - 定义 `Pose`（`pos` = 脚底世界坐标，`ang` = [yawDeg, pitchDeg]），在
 *   `apps/viewer/src/app.ts` 的 `applyPose`、`apps/viewer/src/ui/mapinfo.ts` 的跳转回调与
 *   `apps/viewer/src/core/fly.ts` 的 `FlyCam.setPose` / `FlyCam.getPose` 之间传递；
 * - 把共享层的角度换算再导出为 `wrapDeg` 与 `bspYawToCsYaw`（定义在
 *   `src/ts-shared/phys/angles.ts`），使 viewer 内既有的 `./pose.js` / `../core/pose.js`
 *   import 路径保持不变（消费点：`apps/viewer/src/core/spawn.ts` 的 `spawnPointAng`、
 *   `apps/viewer/src/replay/helpers.ts` 的再导出 `wrapDeg`）。
 *
 * 关键不变量：本文件的 `ang` 一律用**度**；弧度只出现在 `FlyCam` 内部。
 * pitch 硬限幅在多处各自执行（`FlyCam.update`、`FlyCam.setPose`、
 * `FlyCam.setWorld`，以及 `apps/viewer/src/replay/helpers.ts` 的 `clampPitch`），
 * 幅度统一取自 `./constants.js` 的 `PITCH_LIMIT` / `PITCH_LIMIT_DEG`（89°）。
 *
 * 依赖：只引 `./constants.js` 与共享层 `src/ts-shared/phys/angles.ts`；不引 three、不碰 DOM。
 */

export { wrapDeg, bspYawToCsYaw } from '../../../../src/ts-shared/phys/angles.js';

/** 位姿：`pos` = [x,y,z] 脚底位置（世界坐标）；`ang` = [yawDeg, pitchDeg]（度）。 */
export interface Pose {
  pos: [number, number, number];
  ang: [number, number];
}

