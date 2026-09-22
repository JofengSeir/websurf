/**
 * viewer 全局常量单点（`EYE_STAND` 除外——那一条从共享层再导出）。
 *
 * 单位口径：
 * - 角度：`DEG2RAD` / `RAD2DEG` 是换算因子；`FOV` 与 `PITCH_LIMIT_DEG` 用度；
 *   `PITCH_LIMIT` 用弧度（`FlyCam` 与 `pitchClampedRad` 消费）。
 * - 长度：一律 HU。`EYE_STAND` 站立眼高、`CAMERA_*` 相机裁剪面、`FLY_SPEED*` 每秒位移。
 * - 鼠标：`MOUSE_SENS` 单位 rad/px（`FlyCam.update` 把像素增量换成弧度）；
 *   `MOUSE_MAX_DELTA` 单位 px，是**单次事件**的绝对值上限（`FlyCam.delta`）。
 *
 * 跨工程对齐（逐值核对 apps/game 与 apps/debug 的同名量）：
 * `FOV` 73.6 对齐 `apps/game/src/config.ts` 的 `fov` 默认值；`CAMERA_NEAR_MIN` 0.05、
 * `NEAR_PROBE_DIST` 100、`NEAR_RATIO` 0.3、`CAMERA_FAR_SCALE` 100 分别对齐
 * `apps/game/src/renderer/renderer-main.ts` 的 `CAMERA_NEAR_MIN`、`NEAR_PROBE_DIST_DEFAULT`、
 * `NEAR_RATIO_DEFAULT` 与 `far = maxDim * 100`；`CAMERA_INIT_NEAR` 0.1、
 * `CAMERA_INIT_FAR` 100000 与 `BG_COLOR` 0x0d1b2a 只属本工程。
 *
 * 消费点：`apps/viewer/src/core/scene.ts`（相机、背景、near/far 与探测参数）、
 * `apps/viewer/src/core/fly.ts`（速度、灵敏度、pitch 限幅）、
 * `apps/viewer/src/replay/helpers.ts`（`PITCH_LIMIT_DEG`）。
 * `RAD2DEG` 在本仓 `apps/viewer/src` 内零调用点。
 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/**
 * 站立眼高（HU）。`pos` 为脚底，相机 y = `pos.y + EYE_STAND`。
 *
 * 本文件**不持有该字面量**：只从共享单点 `src/ts-shared/phys/constants.ts` 再导出，
 * 使 `apps/viewer/src/core/fly.ts` 与 `apps/viewer/src/core/pose.ts` 的既有 import 路径
 * `./constants.js` 保持不变。共享层该值须与 Rust 权威 `src/phys/player.rs` 的 `EYE_STAND`
 * 逐位相等，这一点由 `src/scripts/check-shared-sync.mjs` 的 eye-stand 子检查强制。
 */
export { EYE_STAND } from '../../../../src/ts-shared/phys/constants.js';

/** 垂直视野角（度）：`ViewerScene` 构造 `THREE.PerspectiveCamera` 时传入（与 game 默认一致）。 */
export const FOV = 73.6;
/** 相机初始 near / far（HU）：构造时传入，地图挂载后由 `ViewerScene.fitCamera` 重设。 */
export const CAMERA_INIT_NEAR = 0.1;
export const CAMERA_INIT_FAR = 100000;
/** 地图加载后 far = maxDim × 此值，再与 `CAMERA_INIT_FAR` 取大（`ViewerScene.fitCamera`）。 */
export const CAMERA_FAR_SCALE = 100;
/** near 下限（HU）：`ViewerScene.fitCamera` 与 `updateNearPlane` 收缩 near 时都不得低于它。 */
export const CAMERA_NEAR_MIN = 0.05;
/** 近平面探测距离默认（HU）：`updateNearPlane` 的射线 far，也是包围球粗筛的距离基数。 */
export const NEAR_PROBE_DIST = 100;
/** near 收缩系数默认：near = 最近命中距离 × 此值，再与 `CAMERA_NEAR_MIN` 取大。 */
export const NEAR_RATIO = 0.3;
export const BG_COLOR = 0x0d1b2a;

/** 自由飞行速度（HU/s）：`FlyCam.update` 每帧位移 = 归一化方向 × 速度 × dt；`FLY_SPEED_FAST` 为 ×4（按住左右 Shift）。 */
export const FLY_SPEED = 500;
export const FLY_SPEED_FAST = FLY_SPEED * 4;

/** 鼠标灵敏度（rad/px）：`FlyCam.update` 把累加的像素增量乘上它得到弧度增量（yaw 与 pitch 同一系数）。 */
export const MOUSE_SENS = 0.0022;
export const PITCH_LIMIT = 89 * DEG2RAD;
/**
 * 单次 mousemove 增量的绝对值上限（px），在 `FlyCam.delta` 里逐事件削平。
 * 与「指针锁定后丢弃第一个 mousemove」不是同一机制——后者由 `FlyCam.discardNextMouse`
 * 承担（在 `pointerlockchange` 时置位），不比较像素阈值。
 */
export const MOUSE_MAX_DELTA = 1000;

/** pitch 硬限幅（度）：`apps/viewer/src/replay/helpers.ts` 的 `clampPitch` 用它收敛玩家朝向。 */
export const PITCH_LIMIT_DEG = 89;
