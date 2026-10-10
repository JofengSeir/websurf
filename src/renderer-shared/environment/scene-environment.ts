/**
 * 场景环境的**唯一登记入口**（T-460 WP1；任务书 `.tmp/task-render-parity/TASK.md` §3 WP1）。
 *
 * 为什么有这一层：环境登记此前分散在三端——debug 走 `LightManager.setSkybox/setFog`、game 直接写
 * `scene.background` 再手调 `setReflectionEnvMap`、viewer 只写 `scene.background`（**零反射源**）。
 * 后果不是编译错误，而是 `$envmap` 材质（冰/玻璃/水）在漏调的一端整体丢掉环境反射高光：
 * `lightmap-shader.ts` 的 `applyReflectionEnvMap` 遇到空源时静默 `return`（T-458 取证）。
 * 本模块把「背景 / 反射源 / 雾」的写入口收成一份；`apps/**` 不再直接写 `scene.background` /
 * `scene.fog`，也不再直接调 `setReflectionEnvMap`——该调用面由 `src/scripts/check-render-parity.mjs`
 * 的 `[A]` 断言守（命中即失败）。
 *
 * 状态按 `WeakMap<Scene, state>` 记：同进程可能同时存在多个 `THREE.Scene`（换图重建、天空层调试），
 * 不能用一个模块级变量代替。`setSceneEnvironment` 是**逐字段合并**：只有对象里出现的键才被写，
 * 「不出现」= 不动那一项。
 *
 * 与 `render-sky-pass.ts` 的分工：雾的取值口径（建雾 + `setFogMaxDensity`）仍由那边承载，本模块只做
 * 登记与转发，不重复实现；`renderSkyPass` 每帧对 `scene.background` / `scene.fog` 的摘取与还原
 * （两遍法必需）不经本模块，时序解耦。
 */
import * as THREE from 'three';
import { setReflectionEnvMap } from '../shader/lightmap-shader.js';
import { applyMapFog, type MapFogParams } from './render-sky-pass.js';

/** 三端统一的清屏回落色（与 `apps/game`、`apps/viewer` 的 `0x222222` 同值；`apps/debug` 的 `lighting.bgColor` 默认同值）。 */
export const SCENE_BACKGROUND_FALLBACK = 0x222222;

/** 一次环境登记的入参：只写出现的字段（`background: null` = 清空背景，与「不出现」不同）。 */
export interface SceneEnvironmentInput {
  /** 背景：天空盒立方体贴图 / 纯色 / null（清空）。 */
  background?: THREE.Texture | THREE.Color | null;
  /** `$envmap` 材质的反射源（通常与背景是同一张天空盒 CubeTexture）；null = 清空源。 */
  skyboxReflection?: THREE.Texture | null;
  /** 地图线性雾（`env_fog_controller`）；null = 摘雾。 */
  fog?: MapFogParams | null;
}

/** 场景环境的登记状态（只读出口给一致性探针与负向自测用）。 */
export interface SceneEnvironmentState {
  /** 最近一次登记的背景（贴图或纯色）。 */
  background: THREE.Texture | THREE.Color | null;
  /** 最近一次登记的纯色回落值。 */
  colorFallback: THREE.Color;
  /** 是否登记过天空盒（决定纯色回落是否真的写进 `scene.background`）。 */
  hasSkybox: boolean;
  /** 最近一次登记的反射源。 */
  reflection: THREE.Texture | null;
  /** 最近一次登记的雾参数（雾实例由 `render-sky-pass.ts` 建）。 */
  fogParams: MapFogParams | null;
}

const states = new WeakMap<THREE.Scene, SceneEnvironmentState>();

function stateOf(scene: THREE.Scene): SceneEnvironmentState {
  let st = states.get(scene);
  if (!st) {
    st = {
      background: scene.background ?? null,
      colorFallback: new THREE.Color(SCENE_BACKGROUND_FALLBACK),
      hasSkybox: false,
      reflection: null,
      fogParams: null,
    };
    states.set(scene, st);
  }
  return st;
}

/** 只读状态（副本；改返回值不影响登记状态）。 */
export function getSceneEnvironmentState(scene: THREE.Scene): SceneEnvironmentState {
  const st = stateOf(scene);
  return { ...st, colorFallback: st.colorFallback.clone() };
}

/**
 * 登记场景环境（逐字段合并）。顺序固定：背景 → 反射源 → 雾。
 *
 * 背景与反射源是**两个独立字段**：同一张天空盒 CubeTexture 通常同时传给两者，但「有背景、无反射源」
 * 是合法登记（`$envmap` 材质会走 `lightmap-shader.ts` 的缺源告警并计入 `__vbspEnvMapMissing`）。
 *
 * @param scene 目标场景。
 * @param env 只写出现的字段；返回登记后的状态快照。
 */
export function setSceneEnvironment(scene: THREE.Scene, env: SceneEnvironmentInput): SceneEnvironmentState {
  const st = stateOf(scene);
  if ('background' in env) {
    st.background = env.background ?? null;
    st.hasSkybox = st.background instanceof THREE.CubeTexture;
    scene.background = st.background;
  }
  if ('skyboxReflection' in env) {
    st.reflection = env.skyboxReflection ?? null;
    setReflectionEnvMap(st.reflection);
  }
  if ('fog' in env) {
    st.fogParams = env.fog ?? null;
    applyMapFog(scene, st.fogParams);
  }
  return getSceneEnvironmentState(scene);
}

/**
 * 登记纯色回落背景（灯光配置的 `lighting.bgColor` 走这里）。
 *
 * 语义与 `LightManager` 原有分工一致：**登记过天空盒时只记值、不改背景**（天空盒压过纯色）；
 * 没有天空盒时直接写 `scene.background`。换图清场后由 `clearSceneEnvironment` 回落到这个值。
 */
export function setSceneBackgroundColor(scene: THREE.Scene, color: number | THREE.Color): void {
  const st = stateOf(scene);
  st.colorFallback = color instanceof THREE.Color ? color.clone() : new THREE.Color(color);
  if (!st.hasSkybox) {
    st.background = st.colorFallback;
    scene.background = st.background;
  }
}

/**
 * 换图 / 卸载：清背景（可选释放贴图）+ 清反射源 + 摘雾。
 *
 * `disposeBackground` 在换图路径必须为真，否则旧图的立方体贴图留在显存（`scene.remove` 不释放纹理）；
 * `background` 指定清理后落哪种背景，缺省为**本场景登记的纯色回落值**。
 */
export function clearSceneEnvironment(
  scene: THREE.Scene,
  opts: { disposeBackground?: boolean; background?: THREE.Texture | THREE.Color | null } = {},
): void {
  const st = stateOf(scene);
  if (opts.disposeBackground && scene.background instanceof THREE.Texture) scene.background.dispose();
  st.background = opts.background !== undefined ? opts.background : st.colorFallback;
  st.hasSkybox = st.background instanceof THREE.CubeTexture;
  scene.background = st.background;
  st.reflection = null;
  setReflectionEnvMap(null);
  st.fogParams = null;
  applyMapFog(scene, null);
}
