/** 全局常量（与 game 保持一致的部分已标注）。 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/** 固定站立眼高（HU，与 game EYE_STAND 一致）。pos 为脚底，相机 y = pos.y + EYE_STAND。 */
export const EYE_STAND = 64.09;

/** FOV（度）。 */
export const FOV = 73.6;
/** 相机初始 near/far（与 game renderer init 一致；地图加载后 fitCamera 按 maxDim 重设）。 */
export const CAMERA_INIT_NEAR = 0.1;
export const CAMERA_INIT_FAR = 100000;
/** 地图加载后 far = maxDim × 此值（与 game loadScene 一致：基本无远裁剪）。 */
export const CAMERA_FAR_SCALE = 100;
/** 近平面下限（与 game CAMERA_NEAR_MIN 一致）。 */
export const CAMERA_NEAR_MIN = 0.05;
/** 近平面探测距离默认（HU，与 game NEAR_PROBE_DIST_DEFAULT 一致；面板化需求出现前用默认）。 */
export const NEAR_PROBE_DIST = 100;
/** near 收缩系数默认（与 game NEAR_RATIO_DEFAULT 一致：near = 最近几何距离 × 此值）。 */
export const NEAR_RATIO = 0.3;
export const BG_COLOR = 0x0d1b2a;

/** 飞行速度（HU/s）；Shift ×4。 */
export const FLY_SPEED = 500;
export const FLY_SPEED_FAST = FLY_SPEED * 4;

/** 鼠标灵敏度（rad/px）。 */
export const MOUSE_SENS = 0.0022;
export const PITCH_LIMIT = 89 * DEG2RAD;
/** 指针锁定后丢弃下一个 mousemove（初始跳变通常 2000-5000+ px）。 */
export const MOUSE_MAX_DELTA = 1000;

/** pitch 硬限幅（度），标准帧与 UI 共用。 */
export const PITCH_LIMIT_DEG = 89;
