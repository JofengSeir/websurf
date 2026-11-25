/**
 * Source `Water` 材质的近似实现（T-650 第六回合；owner 要求"和起源差不多"）。
 *
 * ## 依据（权威实现在仓库自带的 SDK 里）
 *
 * `test/project/source-sdk-2013-master/src/materialsystem/stdshaders/water_ps2x_helper.h`
 * 的 `DrawWater()`：
 * ① 用 DU/DV 法线扰动**折射与反射的屏幕空间 UV**（`reflectRefractScale` 的 x,y =
 *    `$reflectamount`、z,w = `$refractamount`）；
 * ② `fFresnel = pow(1 - saturate(N·V), 5)`（没有 basetexture 的水再按深度门控：水浅 → 纯折射）；
 * ③ 折射色按深度混向 `$fogcolor`：`lerp(refract, fogColor, saturate(depth - 0.05))`；
 * ④ 输出 `lerp(refract, reflect, fFresnel)`，alpha 恒 1（水面是合成，不是 alpha 混合）。
 * 缺省值见 `water.cpp` 的 `SHADER_PARAM`（`$refractamount 0`、`$reflectamount 0.8`、
 * tints `[1 1 1]`、`$abovewater 1`；`$reflecttint` 进 shader 前 ×4 overbright）。
 *
 * ## 本工程怎么对应（以及**做不到**什么）
 *
 * - **折射**：Source 用 `_rt_WaterRefraction`（把身后画面重采样并按 DU/DV 扭曲）。本工程试过
 *   three 的 `MeshPhysicalMaterial.transmission`（同样是屏幕空间折射），但在本仓"世界面合并块 +
 *   双相机天空通道"的架构下 **transmission RT 采到的是空场景（整片死白）**：实测 `thickness`
 *   0/24、`envMapIntensity` 0/0.8、`transmission` 1/0 三组旋钮中，只有关掉 transmission 才有
 *   变化（变黑），其余全部逐字节相同 ⇒ RT 内容与折射射线无关。故退回：**用真半透明让水底真的透出来**
 *   （比伪造折射更实在），再用下方涟漪在**水面本身**做动态。
 * - **反射**：走已有的 `vbsp_envmap` + 本文件的菲涅尔调制（`reflectivity` 来自 `$envmaptint`）。
 *   ⚠️ 反射源是近白天空盒 ⇒ **单纯扰动反射方向看不出涟漪**（T-627 已实测：强度调到 3.0 仍逐像素
 *   相同），所以涟漪做在**基色/不透明度**上（可见），这点与 Source 不同。
 * - **雾色**：Source 的深度雾（`depth` = 折射缓冲的 alpha）没有来源 ⇒ 用**视距**当代理
 *   （`$fogstart/$fogend` 本来就是距离雾；`$abovewater 1` 时用距离是近似）。
 * - **涟漪/波纹**：用**地图水材质真正引用的** DU/DV 图（`$bumpmap dev/water_dudv`，VTF 7.1
 *   256² **UV88**，R=du/G=dv，29 帧动画取 frame 0），内嵌在 `water-dudv-data.ts`（解它要
 *   `src/scripts/vtf-to-png.py` + `gen-water-dudv.mjs`）。它只做 Source 让它做的事：**扭曲镜面
 *   反射的采样 UV**（Source 的 `vDependentTexCoords = vN * vNormal.a * scale`）。平铺密度吃
 *   地图的 `$scale`，滚动吃 `$scroll1`/`$scroll2`。
 *   ⚠️ 2026-10-19 二次返工：更早的两版都是**自己合成正弦坡度图并调制基色明暗**，结果满屏细密
 *   交叉条纹（owner 两次指出）——DU/DV 是噪声场，拿它调亮度只会变雪花纹，所以明暗调制整段删掉，
 *   只留 ~1/10 幅度的漫射起伏。
 *   ⚠️ 反射源是近白天空盒时**扰动反射方向看不出涟漪**（T-627 实测）——本文件的平面反射正是为此
 *   而做：镜面 RT 里是真实场景，扰动才看得见。
 */
import * as THREE from 'three';
import { optimizeFlag } from '../config/optimize-flags.js';
import {
  clampBudgetLevel,
  clampLastFrameDt,
  readBudgetLevelEscapeHatch,
  readLastFrameDtEscapeHatch,
  readWaterForcePassEscapeHatch,
  type RenderFrameContext,
} from '../scene/render-context.js';
import {
  mirrorPlanes,
  reflOnUniform,
  renderMirrorPlane,
  resetMirrorState,
} from './water/planar-reflect.js';
import {
  cullBeneathMaterials,
  hasRefractionTarget,
  renderRefraction,
  resetRefractionState,
  updateRefrUniforms,
  visibleWaterHeights,
  waterMaterials,
  refrOnUniform,
} from './water/refract-underwater.js';

const g = globalThis as {
  __vbspWaterFrustumGate?: boolean;
  __vbspWaterRefrCadence?: number;
  __vbspWaterRefrBudget?: boolean;
  __vbspWaterMirrorCadence?: number;
  __vbspWaterMirrorBudget?: boolean;
  __vbspWaterBudgetReset?: () => void;
  __vbspWaterBudgetSkip?: boolean;
  __vbspWaterBudget?: unknown;
  __vbspLastFrameMs?: number;
  __vbspWaterRtEps?: number;
  __vbspWaterRtCos?: number;
};

/**
 * 折射颜色 RT 的重渲间隔（帧）。默认 2 = 隔帧。
 *
 * ② 2026-11-17：`updateRefrUniforms` 每帧刷投影/视角 uniform，所以隔帧只让**内容**滞后
 * 最多 1 帧（320fps 下约 3ms）——比早期否决的「3 帧交错」温和得多（那只在低帧率下成立）。
 * 滞后量与相机转角成正比：boreas 回放每帧 yaw 均值 0.011°、p99 0.065°（`.tmp/rotrate.mjs`），
 * 屏幕位移远小于 1 像素 ⇒ 隔帧在实测回放里不可辨。
 *
 * 实测（`abdt.mjs`，回放 flight-221413，同构建交替跑）：cadence 1 慢帧(dt≥4.5) 22.3~24.1%、
 * mean 3.95~3.99ms；cadence 2 **13.3~16.4%**、mean 3.62~3.71ms；cadence 3 14.7% 无额外收益。
 * 折射是慢帧的主要增量（同构建 A/B：`__vbspWaterRefrOn=false` ⇒ 慢帧 18.2%→4.9%）。
 * 逃生舱：`__vbspWaterRefrCadence=1` 回全帧率，`=3` 更省（画质未验证）。
 */
let refrSinceRender = 0;
function refrCadence(level: number): number {
  const forced = (g as { __vbspWaterRefrCadence?: number }).__vbspWaterRefrCadence;
  if (typeof forced === 'number' && Number.isFinite(forced) && forced > 0) {
    return Math.max(1, Math.round(forced));
  }
  // 默认隔帧（实测见上：慢帧 22~24% → 13~16%，mean −0.3~0.4ms）。
  // 2026-11-19：慢机掉槽时按帧预算等级再放宽（见 mirrorCadence 同批实测，水面 pass 合计
  // 约 1.3ms/帧，是重载区超槽的主因）。A/B：`__vbspWaterRefrBudget = false`。
  // 2026-11-19 二次调：用户机「level 2 + cadence 4」时重载区仍有 24 条/秒掉槽（水面帧
  // frame 3.4~4.1ms > 3.125ms 槽），本机 CPU 降频 1.35× 的 A/B：cad4 丢槽 30.9%、
  // cad6 25.1%、cad8 22.2%，fps 236→263→268 ⇒ L2 取 6。
  const budgetOn = (g as { __vbspWaterRefrBudget?: boolean }).__vbspWaterRefrBudget !== false;
  // 预算等级由调用方传（T-P2-1：不再从 globalThis 隐式读；没有上下文时调用方走逃生舱）。
  const budgetLevel = clampBudgetLevel(level);
  if (budgetOn && budgetLevel >= 2) return 6;
  if (budgetOn && budgetLevel >= 1) return 4;
  return 2;
}

/**
 * 镜面 RT 的降频计数（task-33 C1 降级点②）。每帧推进，只在真正渲过镜面之后清零。
 */
let mirrorSinceRender = 0;

/**
 * 当前镜面 RT 的重渲间隔（帧）。默认 2 = 隔帧。
 *
 * 早期「每 3 帧交错」会在低帧率下露出拖影，所以一直保持每帧重渲。2026-11-17 复核：
 * 那时反射滞后的**绝对时长**是 3×16.7ms≈50ms；现在 320fps 下一帧只有 3.1ms，
 * 隔帧滞后 ≈3ms，且滞后量与相机每帧转角成正比（boreas 回放 yaw 每帧均值 0.011°、
 * p99 0.065°，屏幕位移 <1.5 像素）——肉眼不可辨。
 *
 * 实测（`abpair.mjs` 同页交错、预算冻结，回放 flight-221413，折射已隔帧）：
 * 镜面每帧 slowPct 17.3~20.3%、mean 3.79~3.91ms、**p90 6.25**；
 * 镜面隔帧 slowPct **9.4~12.2%**、mean 3.49~3.58ms、**p90 3.23**。
 * 帧预算控制器升到 2 级时再降到每 3 帧（原有 L2 降级点）。
 * 逃生舱：`__vbspWaterMirrorCadence=1` 回每帧（A/B 或发现拖影时用）。
 */
function mirrorCadence(level: number): number {
  const forced = (g as { __vbspWaterMirrorCadence?: number }).__vbspWaterMirrorCadence;
  if (typeof forced === 'number' && Number.isFinite(forced) && forced > 0) {
    return Math.max(1, Math.round(forced));
  }
  const budgetOn = (g as { __vbspWaterMirrorBudget?: boolean }).__vbspWaterMirrorBudget !== false;
  // 预算等级由调用方传（T-P2-1，同 refrCadence）。
  const budgetLevel = clampBudgetLevel(level);
  // 2026-11-19 慢机 A/B（CDP CPU 降频 rate 1.4，boreas 回放 38–46s 重载段，同机位 8s）：
  //   cadence 2（默认）frame p50 3.66ms、丢槽(dt>4.6) 52.4%、194.7fps
  //   cadence 4        frame p50 3.09ms、丢槽 38.4%、226.0fps
  //   水面 pass 全关  frame p50 2.36ms、丢槽 20.0%、263.9fps
  // ⇒ 掉槽时把折射/镜面都放宽到 4 帧，能拿回约一半的水面成本。
  // 静态观感：320fps 下 4 帧 ≈12.5ms 的重反射/折射滞后，回放里 yaw 每帧 0.011° ⇒ 屏移 <2px。
  // 2026-11-19 二次调（同 refrCadence）：用户机 level 2 下 cad4 仍有 1.0~1.4ms 的水面帧超槽，
  // 本机 CPU 降频 1.35×：cad4 丢槽 30.9% → cad6 25.1% → cad8 22.2% ⇒ L2 取 6（6 帧≈19ms 滞后，
  // 仅在持续掉槽时启用）。
  if (budgetOn && budgetLevel >= 2) return 6;
  if (budgetOn && budgetLevel >= 1) return 4;
  // 默认隔帧（实测见上：p90 6.25→3.23ms、慢帧 17~20%→9~12%）。
  return 2;
}

/**
 * 帧预算兜底（2026-11-19，owner：「部分舍弃计算，用画面差错换准时发出提交」）。
 *
 * 水面折射/镜面是每帧最大的**可选**开销（实测 1.0~1.4ms，`renderWaterFramePasses` 一趟整场景）。
 * 慢机的重载区里，只要这一帧跑了水面,整帧就 3.3~4.1ms，超过 3.125ms 槽 ⇒ 掉一个 vsync。
 * 与其按固定 cadence 撞帧，不如在**真渲之前**看预算：若「上一帧非水面成本 + 水面实测成本」
 * 会超预算，就跳过这次更新（水面继续采样上一帧 RT，倒影/折射滞后一帧，肉眼几乎不可见），
 * 把提交准时发出去。持续掉槽时更新自然变稀；但距上次真渲超过 `maxDeferFrames` 仍强制渲一次，
 * 避免倒影完全冻住。
 *
 * 逃生舱：`__vbspWaterBudgetSkip = false` 关掉这道判断（A/B 用）。
 */
const WATER_SLOT_BUDGET_MS = 3.0;
/** 上一趟水面 pass 的实测 CPU 成本（ms），0 = 还没量过。 */
let lastWaterCostMs = 0;
const waterBudgetStats = { skipped: 0, forced: 0, passes: 0, base: 0, cost: 0 };
(g as { __vbspWaterBudgetReset?: () => void }).__vbspWaterBudgetReset = () => {
  waterBudgetStats.skipped = 0;
  waterBudgetStats.forced = 0;
  waterBudgetStats.passes = 0;
};

/** 判断本帧该不该跳过水面更新（true = 跳过）。调用点：已确认本帧有 due 的 pass。 */
function waterBudgetSaysSkip(
  refrAge: number,
  refrEvery: number,
  mirrorAge: number,
  mirrorEvery: number,
  lastDtMs: number,
): boolean {
  // 面板「优化处理」开关：默认关（owner 2026-11-19）。关着时零行为变化。
  if (!optimizeFlag('waterRtReuse')) return false;
  const off = (g as { __vbspWaterBudgetSkip?: boolean }).__vbspWaterBudgetSkip === false;
  if (off) return false;
  const lastFrame = (g as { __vbspLastFrameMs?: number }).__vbspLastFrameMs;
  if (typeof lastFrame !== 'number' || !Number.isFinite(lastFrame) || lastFrame <= 0) return false;
  const base = Math.max(0, lastFrame - lastWaterCostMs);
  const cost = lastWaterCostMs > 0 ? lastWaterCostMs : 1.0;
  waterBudgetStats.base = +base.toFixed(2);
  waterBudgetStats.cost = +cost.toFixed(2);
  (g as { __vbspWaterBudget?: typeof waterBudgetStats }).__vbspWaterBudget = waterBudgetStats;
  // 上一帧 dt 由调用方传（T-P2-1）；0 = 未知，按「没掉槽」处理。
  const missedSlot = clampLastFrameDt(lastDtMs) > 4.8;
  if (!missedSlot && base + cost <= WATER_SLOT_BUDGET_MS) return false;
  // 强制兜底：太久没更新就让这一趟跑（之后如果还是超，就再等下一轮）。
  const forceRefr = refrAge >= Math.max(8, refrEvery * 2);
  const forceMirror = mirrorAge >= Math.max(8, mirrorEvery * 2);
  if (forceRefr || forceMirror) {
    waterBudgetStats.forced++;
    return false;
  }
  waterBudgetStats.skipped++;
  return true;
}

/** 记录一趟水面 pass 的实测成本（EMA，0.6/0.4）——供下一帧的预算判断用。 */
function recordWaterCost(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  lastWaterCostMs = lastWaterCostMs > 0 ? lastWaterCostMs * 0.6 + ms * 0.4 : ms;
}

/**
 * 跑本帧的水面整场景 RT pass（折射/镜面二选一）。
 *
 * @param frame 帧运行期上下文（T-P2-1）。`RenderSession` 传自己的实例；不传时回落
 *   `globalThis.__vbsp*` 逃生舱（外部调试 / CDP 脚本的旧路径）。
 */

export function renderWaterFramePasses(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  frame?: RenderFrameContext,
): void {
  if (waterMaterials.size === 0 || refrOnUniform.value <= 0.5) return;
  // 水下底面（`*_beneath`，源 `$bottommaterial`）的面朝下：相机在水面之上时它们被背面剔除，
  // 但每块仍各占一次 draw（boreas 水面 160 块 × 1 槽 = 160 draw，占全帧 412 的 39%）。
  // 这里按「材质高度 vs 相机 y」直接置 `visible`，像素层面等价于背面剔除。
  // A/B：`__vbspBeneathCull = false` 关掉（同构建内对照，确认画面无差）。
  cullBeneathMaterials(camera);
  // ⚠️ 屏幕空间折射的 uniform 必须每帧刷新（相机在动），否则水面会按旧投影采样而扭曲。
  updateRefrUniforms(camera, renderer);
  // 视线里根本没有水面时不画整场景 RT：抬头看天/低头看地时水面在视锥外，
  // 此时三趟整场景 pass 是纯浪费（实测俯仰扫视里最多 1.7ms/帧）。
  // 用镜面网格的世界包围球做视锥测试；没有登记的水面网格时不做门控（保持旧行为）。
  // A/B 取证：`__vbspWaterFrustumGate = false` 关掉这道门（同构建内对照，验证画面无差）。
  const gateOn = (g as { __vbspWaterFrustumGate?: boolean }).__vbspWaterFrustumGate !== false;
  const visibleHeights = gateOn ? visibleWaterHeights(camera) : null;
  if (visibleHeights && visibleHeights.size === 0) return;
  // 计数在**每次调用**都推进（含水位在视锥外/相机静止的帧），这样一动起来就立刻重渲，
  // 不会先给一帧旧 RT；只有真正渲过之后才清零。
  refrSinceRender++;
  mirrorSinceRender++;
  // 静止时跳过：镜面/折射内容只随相机变，相机没动就没有任何可见差异。
  // 注意：这里只**判断**不动状态，标记位姿由下面真正重渲的分支做（见 rtCameraMoved 注释）。
  const refrMoved = refrCameraMoved(camera);
  const reflOn = reflOnUniform.value > 0.5;
  const mirrorMoved = reflOn ? mirrorCameraMoved(camera) : false;
  if (!refrMoved && !mirrorMoved) return;
  // ⚠️ 每帧**最多一趟**整场景 RT pass。折射/镜面都是整场景重渲，撞在同一帧就是那一帧多付
  // 一整趟：实测预算 2 级（镜面 cadence 3、折射 cadence 2）时每 6 帧必撞一次
  // （212/1274 帧），撞帧比单趟帧慢 ~1ms —— 窗口大的机器上直接掉一个 vsync 槽
  // （owner 报的「走动时间歇掉到 160」）。所以用一个「超期比例更大者优先、相等时折射优先」
  // 的调度：本帧渲了折射，镜面就顺延到下一帧补渲（滞后最多 +1 帧，远小于 3 帧交错的可见阈值）。
  // 早期「每帧都重渲」的结论对**画质**成立（拖影主要来自倒影滞后），但代价是双趟帧扎堆。
  // 上下文优先、globalThis 逃生舱兜底（T-P2-1）。
  const budgetLevel = frame ? clampBudgetLevel(frame.budgetLevel) : readBudgetLevelEscapeHatch();
  const lastDtMs = frame ? clampLastFrameDt(frame.lastFrameDtMs) : readLastFrameDtEscapeHatch();
  const refrEvery = refrCadence(budgetLevel);
  const mirrorEvery = mirrorCadence(budgetLevel);
  const refrDue = refrMoved && (refrEvery <= 1 || refrSinceRender >= refrEvery || !hasRefractionTarget());
  const mirrorDue = mirrorMoved && (mirrorEvery <= 1 || mirrorSinceRender >= mirrorEvery);
  // 预热逃生舱（默认 undefined）：`frame.waterForcePass`（旧路径是 `__vbspWaterForcePass`）
  // 强制本帧只跑指定的一趟整场景 RT，绕过 cadence 与「超期比例」调度（相机移动/水位门控仍生效）。
  // 载图期预热帧的 frame() 只会走折射分支（两计数同步 +1 ⇒ refrScore == mirrorScore、折射优先），
  // 镜面 RT 要等首飞第一个移动帧才渲；预热代码在 frame() 之后再调一次本函数并置 'mirror'，
  // 把镜面首渲前移到载图期。
  const forcedPass = frame ? frame.waterForcePass : readWaterForcePassEscapeHatch();
  let refrNow = refrDue;
  let mirrorNow = mirrorDue;
  if (forcedPass === 'refr') {
    refrNow = refrMoved;
    mirrorNow = false;
  } else if (forcedPass === 'mirror') {
    refrNow = false;
    mirrorNow = mirrorMoved;
  }
  if (!refrNow && !mirrorNow) return;
  // 预算兜底：这一帧的水面更新会不会把整帧推出 3.125ms 槽？会就跳过（复用上一帧 RT）。
  if (waterBudgetSaysSkip(refrSinceRender, refrEvery, mirrorSinceRender, mirrorEvery, lastDtMs)) return;
  // 优先级按「超期比例」= 距上次真渲的帧数 ÷ 自己的 cadence（都刚渲过则相等、折射优先）。
  // 注意不能用「cadence<=1 时给固定分」：逃生舱 `__vbspWaterRefrCadence=1` 会让折射每帧
  // 都是固定高分，镜面永远排不到队、倒影被冻住。
  const refrScore = refrSinceRender / refrEvery;
  const mirrorScore = mirrorSinceRender / mirrorEvery;
  if (refrNow && (!mirrorNow || refrScore >= mirrorScore)) {
    refrSinceRender = 0;
    const tPass = performance.now();
    renderRefraction(renderer, scene, camera);
    recordWaterCost(performance.now() - tPass);
    waterBudgetStats.passes++;
    markRefrPose(camera); // 只有真渲过才标记，跳过的帧留到下一帧补渲
    return; // 本帧只跑这一趟
  }
  if (!mirrorNow) return;
  mirrorSinceRender = 0;
  // 镜面 RT 同步去嵌套（T-650 v4：与折射同因——嵌套 render 污染主渲染状态且随视角排序变化）。
  // 只渲「这一帧真的在画面里」的水面层：surf_666 有 5 层水，每层一趟整场景，
  // 全渲是 3.4ms/帧（俯仰扫视掉到 230fps 的主因）；看不见的层保留上一帧 RT。
  // 折射默认 cadence 2、镜面默认 cadence 2；预算升到 2 级时镜面降到 3（task-33 C1 降级点②，
  // `__vbspWaterMirrorBudget=false` 关降级、`__vbspWaterMirrorCadence` 可强制数值）。
  const tMirror = performance.now();
  for (const p of mirrorPlanes.values()) {
    if (p.done) continue;
    if (visibleHeights && !visibleHeights.has(Math.round(p.height * 100) / 100)) continue;
    p.done = true;
    renderMirrorPlane(renderer, scene, camera, p, waterMaterials);
  }
  recordWaterCost(performance.now() - tMirror);
  waterBudgetStats.passes++;
  markMirrorPose(camera); // 同上：跳过的帧不标记，下一帧补渲
}


/** 上一轮水面 RT 用的相机位姿（位置 + 前向）；用于「相机没动就别重渲整场景」的门控。 */
/**
 * 位移门限（HU）与转角门限（cos 值）。
 *
 * 曾经是 8 HU / 0.5°（隔 3 帧才重渲一次）——水面倒影因此比主画面滞后 1~3 帧，肉眼就是「拖影」。
 * 实测每帧重渲的代价只有 ~1.26ms（PVS 之后整场景只剩几十~一百多个 draw），而 fps 与隔帧版
 * 几乎相同（313 vs 314，p95 反而更低：4.96 vs 5.98，因为不再扎堆）。所以门限收到「肉眼不可辨」
 * 的量级：走着走着一帧 ~2 HU，0.5 HU 触发即等于每帧更新。
 */
const RT_MOVE_EPS = 0.5;
const RT_TURN_COS = 0.999999;

/**
 * 运行时覆盖两个门限（只用于 A/B 取证，正常游戏不设）：
 * `__vbspWaterRtEps = 0` ⇒ 相机一动就重渲，用来看「每帧更新」的帧率代价。
 *
 * ⚠️ 判断与标记必须分开：**只有真的重渲了 RT 才调用 `markRefrPose/markMirrorPose`**。
 * 早期版本在判断时顺手更新 `_rtLastPos/_rtLastDir`；加「隔帧」降频后，被跳过的
 * 那一帧会把「相机动过」吃掉 —— 相机正好停在那一帧时，水面 RT 永远停在旧位姿
 * （实测：传送到机位后水面采到上一个机位的折射内容，静态图与基线差 13% 像素）。
 * 拆开后：跳过的那一帧不标记，下一帧必然补渲（滞后仍 ≤1 帧）。
 */
const _rtLastPos = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
const _rtLastDir = new THREE.Vector3();
const _mirrorLastPos = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
const _mirrorLastDir = new THREE.Vector3();
const _rtDir = new THREE.Vector3();
function rtMovedSince(lastPos: THREE.Vector3, lastDir: THREE.Vector3, camera: THREE.Camera): boolean {
  camera.getWorldDirection(_rtDir);
  const eps = (g as { __vbspWaterRtEps?: number }).__vbspWaterRtEps ?? RT_MOVE_EPS;
  const cos = (g as { __vbspWaterRtCos?: number }).__vbspWaterRtCos ?? RT_TURN_COS;
  return lastPos.distanceTo(camera.position) > eps || lastDir.dot(_rtDir) < cos;
}
function markPose(lastPos: THREE.Vector3, lastDir: THREE.Vector3, camera: THREE.Camera): void {
  camera.getWorldDirection(_rtDir);
  lastPos.copy(camera.position);
  lastDir.copy(_rtDir);
}
/** 折射颜色/深度 RT 是否需要重渲（相机相对上次**实际重渲**的位姿变了）。 */
function refrCameraMoved(camera: THREE.Camera): boolean {
  return rtMovedSince(_rtLastPos, _rtLastDir, camera);
}
function markRefrPose(camera: THREE.Camera): void {
  markPose(_rtLastPos, _rtLastDir, camera);
}
/** 镜面 RT 是否需要重渲（与折射各自独立，避免一方降频拖住另一方补渲）。 */
function mirrorCameraMoved(camera: THREE.Camera): boolean {
  return rtMovedSince(_mirrorLastPos, _mirrorLastDir, camera);
}
function markMirrorPose(camera: THREE.Camera): void {
  markPose(_mirrorLastPos, _mirrorLastDir, camera);
}

/**
 * 当前要用的水面高度（水平镜面 + 折射/深度 pass 的隐藏层）。
 *
 * ⚠️ 不能只按 `|camY - h|` 取最近：surf_666 的水面有多层（-16064 / -11968 / -11071 /
 * 15296 / 15312）。相机在 -11071 与 -11968 之间向下看池底时，`|camY-h|` 会选到**头顶的
 * -11071**，于是：① 镜面相机按错误平面镜像；② 折射 pass 不隐藏真正在看的 -11968 水面
 * ⇒ RT 采到水面自身，表现为随视角移动的放射状倒影/自采样。
 *
 * 规则按**视线方向**选层：向下看取最近的**下方**水面，向上看取最近的**上方**水面；
 * 水平视线才退回绝对最近。没有对应方向的层时再回退另一侧。
 */

/**
 * 换图/卸载：释放镜面/折射 RT 与本地登记，复位所有水面状态。
 *
 * 具体释放与清空由两个子模块负责（状态随函数归属）；本文件只复位门面自己的
 * 调度计数与相机位姿缓存。
 */
export function resetWaterShaders(): void {
  resetMirrorState();
  resetRefractionState();
  refrSinceRender = 0;
  mirrorSinceRender = 0;
  _rtLastPos.set(Number.NaN, Number.NaN, Number.NaN);
  _mirrorLastPos.set(Number.NaN, Number.NaN, Number.NaN);
}

export { applyWaterShaders, waterStats } from './water/refract-underwater.js';
