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
import { WATER_DUDV } from './water-dudv-data.js';

/** glTF extras `vbsp_water` 的形态（`gltf_builder.rs` 的 `push_material` 写）。 */
interface WaterExtras {
  /** `$fogcolor`（gamma 色，0..1）：深水色。缺 VMT 时是**泛白**兜底色（见 Rust 侧 `WATER_COLOR`） */
  fog?: [number, number, number];
  refractTint?: [number, number, number];
  reflectTint?: [number, number, number];
  refractAmount?: number;
  reflectAmount?: number;
  aboveWater?: boolean;
  fogStart?: number;
  fogEnd?: number;
  /** `$scroll1`/`$scroll2` 前两维：两层涟漪的 UV 滚动速率。 */
  scroll1?: [number, number];
  scroll2?: [number, number];
  /** `$scale`：水材质的贴图缩放（`water01.vmt` 写 `[1 1]`）。 */
  scale?: [number, number];
  /** `$bumpmap`：失真图路径（`dev/water_dudv`）——用于**选资源**，不再写死。 */
  bumpmap?: string | null;
  /** `$normalmap`：法线图路径（`dev/water_normal`）。仅记录。 */
  normalmap?: string | null;
  /** `$bumptransform` 的 scale / rotate（作用在主采样 UV 上）。 */
  bumpScale?: [number, number];
  bumpRotate?: number;
  /** `$waterdepth`：该水面 patch 的水深（世界单位）。源里对应折射缓冲 alpha 的归一化深度。 */
  waterDepth?: number | null;
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

const g = globalThis as {
  __vbspWaterWave?: unknown;
  __vbspWaterFlow?: unknown;
  __vbspWaterOff?: unknown;
  __vbspWaterTime?: unknown;
  __vbspWaterFogMix?: unknown;
  __vbspWaterFallbackFogEnd?: unknown;
  __vbspWaterRippleSize?: unknown;
  __vbspWaterFrameRate?: unknown;
  __vbspWaterOpacity?: unknown;
  __vbspWaterMirrorSize?: unknown;
  /** 调试：把水面强制做**不透明**（判断波纹形状用，隔离水底/雾/反射的干扰）。 */
  __vbspWaterOpaque?: unknown;
  /** 调试：覆盖水面基色（如 `[0.08,0.3,0.6]`）。 */
  __vbspWaterColor?: unknown;
  /** 调试：把波纹法线着色强度拉到 1（正常是 0.35，刻意压小）。 */
  __vbspWaterDebugShade?: unknown;
  /** 调试：把深度中间量输出成颜色（R=raw depth, G=厚度, B=视距）。 */
  __vbspWaterDebugDepth?: unknown;
  /** 波纹法线着色强度（缺省 0 = 按 SDK；>0 只是实验）。 */
  __vbspWaterShade?: unknown;
  /** 无 `$waterdepth` 时的归一化水层深度（0..1，缺省 0.35）。 */
  __vbspWaterDefaultDepth?: unknown;
  /** 反射强度（缺省 0.28；owner 反馈反射过强）。 */
  __vbspWaterReflectStrength?: unknown;
  /** 近处/远处的水面不透明度（缺省 0.10 / 0.45）：近处近乎透明、远处带蓝更像水。 */
  __vbspWaterNearAlpha?: unknown;
  __vbspWaterFarAlpha?: unknown;
  /** 蓝调渐变的距离区间（世界单位，缺省 60 / 800）。 */
  __vbspWaterBlueStart?: unknown;
  __vbspWaterBlueEnd?: unknown;
  /** 最终"水色收敛"强度（缺省 0 = 关；这是"贴一个颜色"的粗暴做法，靠体积吸收就够）。 */
  __vbspWaterTint?: unknown;
  /** 体积吸收系数（每世界单位，缺省 0.012）与水层厚度（缺省 180）。 */
  __vbspWaterAbsorb?: unknown;
  __vbspWaterThickness?: unknown;
  /** 金丝雀：把水面强制染成纯红不透明，验证注入是否真的控制这些像素。 */
  __vbspWaterCanary?: unknown;
  /** 真实水厚模型：结构保底透射率 / 透明度参考厚度 / 兜底水厚。 */
  __vbspWaterTransFloor?: unknown;
  __vbspWaterAlphaRef?: unknown;
  /** 用深度 pass 的"到地形距离"当水厚（缺省开；`=false` 退回常数膜厚模型）。 */
  __vbspWaterUseDepthPass?: unknown;
  /** 光程过渡区间（薄端/厚端，世界单位）。 */
  __vbspWaterThickLo?: unknown;
  __vbspWaterThickHi?: unknown;
  /** 厚水混入深水色的比例（缺省 0.92）。 */
  __vbspWaterDeepMix?: unknown;
  /** 雾量上限（缺省 0.55）与软化曲线（缺省 1.35）：控制"水底有多蓝"。 */
  __vbspWaterFogMax?: unknown;
  __vbspWaterFogCurve?: unknown;
  /** 雾量下限（缺省 0 = tp-more 那档）。 */
  __vbspWaterFogFloor?: unknown;
  /** 岸边透明带宽度（缺省 140，竖直深度口径）与岸边反射可见度（缺省 1）。 */
  __vbspWaterShoreWidth?: unknown;
  __vbspWaterShoreRefl?: unknown;
  /** 折射内容亮度上限（缺省 0.78，线性）：控制"水面泛白"程度。 */
  __vbspWaterContentMax?: unknown;
};

/** 涟漪幅度（基色 ±，Source 的 `$refractamount` 乘在这里）。 */
const waveOf = () => Math.max(0, num(g.__vbspWaterWave, 0.22));
/** 涟漪滚动速率的**整体倍率**（0 = 用地图自带 `$scroll1`/`$scroll2` 的原值；>0 时按倍率缩放）。 */
const flowOf = () => Math.max(0, num(g.__vbspWaterFlow, 0));
/** 换帧速率（帧/秒）。源 VMT 的 `AnimatedTexture` 写 30.00。 */
/**
 * 换帧速率（帧/秒）。**缺省 0 = 不做帧动画**。
 *
 * 2026-10-20 逐帧分析结论：`dev/water_dudv` 的 29 帧**彼此是独立噪声**
 * （相邻帧平均|Δ| 100~130/255；四种帧/mip 布局都如此，且文件大小精确等于"每帧全 mip"布局
 * ⇒ 不是解码错），按帧换图必然整片跳变（owner：极其剧烈的抖动）。
 * 源里水面的"动"还有另一条来源 —— `$scroll1`/`$scroll2` 的 UV 滚动，平滑且是 VMT 声明的数据，
 * 所以缺省走滚动；要看帧动画可 `__vbspWaterFrameRate=15`。
 */
const frameRateOf = () => Math.max(0, num(g.__vbspWaterFrameRate, 0));
/**
 * 距离雾最大混合比（1 = 远处完全是 `$fogcolor`）。
 *
 * ⚠️ 2026-10-19（owner 给的三张对照图）：源里 `$fogcolor` 是按**水面以下的深度**混
 * （`saturate(depth - 0.05)`，depth 取自折射缓冲 alpha），**不是按视距**。此前按视距 0.75 混
 * ⇒ 整片水面被刷成白色奶油（游戏里同视角是深色通透的玻璃水）。缺深度来源，只能把混合比压到
 * 很小，让"透过水看到水底 + 掠射反射暗环境"主导观感。
 */
const fogMixOf = () => Math.min(1, Math.max(0, num(g.__vbspWaterFogMix, 0.55)));
/**
 * 水面自身的不透明度（真半透明）。
 *
 * 源里水面的 alpha 恒 1，但它的**颜色**是折射缓冲里的场景（近乎全透明玻璃）。
 * 2026-10-21 起改为源一致：折射可用时 alpha=1、"近水面透明"靠颜色≈水底实现；
 * 不再用 `__vbspWaterOpacity`（旧的半透明混合会把亮底冲成奶白）。
 */
/** 调试：强制不透明（配合 `__vbspWaterColor` 单独判断波纹形状）。 */
const opaqueDebug = () => g.__vbspWaterOpaque === true;
/** 波纹法线着色强度：**缺省 0**（按 SDK，水面没有 basetexture 时观感全部来自
 *  lerp(refract, reflect, fresnel)；噪声失真图不是法线）。留旋钮做实验用：
 *  `__vbspWaterDebugShade` ⇒ 1。 */
const shadeStrengthOf = () => (g.__vbspWaterDebugShade === true ? 1 : num(g.__vbspWaterShade, 0));
/** `$fogstart/$fogend` 缺失时的距离雾终点（世界单位）。 */
const fallbackFogEndOf = () => Math.max(1, num(g.__vbspWaterFallbackFogEnd, 2400));
/** 涟漪在一个平铺里覆盖的世界尺寸（越小越密）；用世界坐标 ⇒ 各图一致。
 *  缺省 200：96 时波纹太密，斜视会读出格纹（2026-10-19 owner 反馈）。 */
/**
 * DU/DV 在一个平铺里覆盖的世界尺寸（越小越密）。
 *
 * 缺省 300：只用于**位移镜面 UV**（不再画到水面颜色上），所以纹理自身的横向条带不会露出来；
 * 太大（700）会因各向异性/mip 塌缩而看不出摆动，太小（96）则在远处被 mip 抹平、近处变成噪点。
 */
/**
 * 涟漪贴图的世界尺度（一个 tile 覆盖多少世界单位）。
 *
 * ⚠️ 2026-10-20（owner 第 3 张图：水面下图案有明显网格、不连续）：内嵌图集是 **64²**，
 * 之前给 300 单位/tile ⇒ 每纹素 4.7 单位，近处一个纹素铺在屏幕上几十像素，
 * 双线性插值的折痕（C0 不连续）就显出"格子"感，位移场也一格一格跳。
 * 改 **64 单位/tile** ⇒ 每纹素 1 单位。源里的 DU/DV 是 256² 配 ~256 单位/tile
 * （≈1 单位/纹素），这样才对齐 —— 折痕落到亚像素，位移变成细密的水面抖动。
 */
const rippleSizeOf = () => Math.max(16, num(g.__vbspWaterRippleSize, 64));

/** 读材质上的水面 extras；不是水面返回 `null`。 */
function readWater(material: THREE.Material): WaterExtras | null {
  const raw = (material.userData as { vbsp_water?: unknown }).vbsp_water;
  if (!raw || typeof raw !== 'object') return null;
  return raw as WaterExtras;
}

/** 三层整数频率正弦叠加的高度场 → 切空间法线；整数频率保证可平铺。 */
function makeRippleTexture(size = 128): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const twoPi = Math.PI * 2;
  const height = (u: number, v: number) =>
    Math.sin(u * 3 + Math.sin(v * 2) * 0.9) * 0.55 +
    Math.sin(v * 5 + Math.sin(u * 3) * 0.6) * 0.3 +
    Math.sin((u + v) * 7) * 0.15;
  const step = twoPi / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * step;
      const v = y * step;
      const dx = (height(u + step, v) - height(u - step, v)) / (2 * step);
      const dy = (height(u, v + step) - height(u, v - step)) / (2 * step);
      const i = (y * size + x) * 4;
      // R/G 存**坡度**（-1..1 映射到 0..1）：片元里直接拿来调制亮度/透明度，
      // B 存高度（备用），A 恒 1。
      data[i] = Math.round((Math.max(-1, Math.min(1, dx * 0.35)) * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((Math.max(-1, Math.min(1, dy * 0.35)) * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((Math.max(-1, Math.min(1, height(u, v) * 0.5)) * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

let ripple: THREE.DataTexture | null = null;
function rippleTexture(): THREE.DataTexture {
  ripple ??= makeRippleTexture();
  return ripple;
}

/**
 * 地图水材质真正引用的失真图 `dev/water_dudv` 的**动画帧**（见 `water-dudv-data.ts`）。
 *
 * 为什么是帧而不是单张：`water.cpp` 里 `BindTexture( SHADER_SAMPLER4, NORMALMAP, BUMPFRAME )`
 * 配 VMT 的 `Proxies → AnimatedTexture`（30fps、29 帧）⇒ 起源水面**是逐帧换图的**；
 * 只平移单帧看起来就是"整张图在滑"（owner 指出），不是涟漪。
 *
 * ⚠️ 帧偏移**必须自己在着色器里算**：three 只对内置贴图槽（`map`/`normalMap`…）应用
 * `texture.offset/repeat` 的 uv 变换，自定义 uniform 采样的贴图**变换不生效** —— 用
 * `Texture.clone()` + `offset/repeat` 会静默地一直采第 0 帧（实测换帧后画面只差 0.6/255）。
 */
let dudv: THREE.DataTexture | null = null;
let dudvFailed = false;
/** 图集里的帧数（0 = 还没解码/失败）。 */
let dudvFrameCount = 0;
const dudvUniform = { value: null as THREE.Texture | null };
const dudvFrameA = { value: 0 };
const dudvFrameB = { value: 0 };
const dudvFrameInv = { value: 1 };
const dudvFrameMix = { value: 0 };

/** 把内嵌的 RG8 条带解码成一维数组（避免 atob 逐字符拼接）。 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function dudvTexture(): THREE.Texture | null {
  if (dudv || dudvFailed) return dudv;
  try {
    const { width, height, frames, rg8Base64 } = WATER_DUDV;
    const data = base64ToBytes(rg8Base64);
    // 竖排图集：宽 = width，高 = height * frames
    const atlas = new THREE.DataTexture(data, width, height * frames, THREE.RGFormat);
    atlas.wrapS = THREE.RepeatWrapping;
    atlas.wrapT = THREE.ClampToEdgeWrapping; // 帧是竖排的，绝不能跨帧回绕
    atlas.magFilter = THREE.LinearFilter;
    atlas.minFilter = THREE.LinearFilter;
    atlas.generateMipmaps = false; // 有 mip 会把相邻帧混进来
    atlas.colorSpace = THREE.NoColorSpace; // 向量数据，不做 sRGB 解码
    atlas.needsUpdate = true;
    dudv = atlas;
    dudvUniform.value = atlas;
    dudvFrameCount = frames;
    dudvFrameInv.value = 1 / frames;
    console.info(`[water] DU/DV 动画帧已载入：${frames} 帧 ${width}²（源 VTF ${WATER_DUDV.sourceFrames} 帧，每 ${WATER_DUDV.frameStep} 帧取一帧）`);
  } catch (e) {
    dudvFailed = true;
    console.warn('[water] DU/DV 帧解码失败 ⇒ 回退程序化坡度图', e);
    dudvUniform.value = rippleTexture();
  }
  return dudv;
}

/** 已注入的水面材质（每帧推进同一个时间 uniform + 涟漪 UV 偏移）。 */
const waterMaterials = new Set<THREE.MeshBasicMaterial>();
/** 材质 → 所在水面块的镜面高度（折射 RT 只隐藏"相机正穿过的那层"，保留水底材质）。 */
const materialHeight = new Map<THREE.Material, number>();
/** 材质 → 水深 uniform 持有者（水深 = 同一水体的顶面与底面高度差）。 */
const materialDepth = new Map<THREE.Material, { depth: { value: number }; use: { value: number } }>();
const timeUniform = { value: 0 };
/** 换帧相位（秒）；片元里用 `vbspWaterFrameMix` 在 A/B 两帧间淡化。 */
const frameUniform = { value: 0 };
let animating = false;

// ── 平面反射（three `examples/jsm/objects/Water.js` 的手法：镜像相机 + RT + 法线扭曲） ──
//
// Water.js 是"一个 mesh 一个 RT + 在 `onBeforeRender` 里渲染一遍场景"。本工程的水面是**世界面
// 合并块**（surf_666 上 286 个槽、分散在几十个块里），逐块渲染不可行 ⇒ 改成**每帧共享一张**：
// 取"离相机最近的水面块"的高度当**水平镜像平面**（BSP 水面法线本来就是竖直的；45° 的
// 瀑布/河流走 `Refract` 通路、没有 `vbsp_water`，不在本通路里），整帧只渲一次 RT。
const MIRROR_SIZE = 1024;
let mirrorRT: THREE.WebGLRenderTarget | null = null;
let mirrorTexture: THREE.Texture | null = null;
const textureMatrix = new THREE.Matrix4();
const virtualCamera = new THREE.PerspectiveCamera();
const mirrorMeshes = new Map<THREE.Mesh, number>(); // mesh → 世界高度（包围球中心 y）
let mirrorRendering = false;
let mirrorDone = false;
const reflOnUniform = { value: 1 };
const mirrorUniform = { value: null as THREE.Texture | null };
const textureMatrixUniform = { value: textureMatrix };
const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

function reflectOff(): boolean {
  return (g as { __vbspWaterReflectOff?: unknown }).__vbspWaterReflectOff === true;
}

// ── 屏幕空间折射 RT（源 `_rt_WaterRefraction` 的对应实现） ──
//
// 源的水面是**不透明**的：它的颜色里已经包含"透过水看到的水底"（折射缓冲），
// 片元里按 `lerp(refract, reflect, fresnel)` 合成。本工程此前靠真 alpha 混合冒充折射 ⇒
// 奶白、没有涟漪（噪声 DU/DV 没有可位移的背景）。这里补上：
//   · 每帧渲一遍**不含水面**的场景到 color+depth RT（只在水面可见时；分辨率可降）
//   · 水面着色器用 DU/DV 位移采样它得到 refr，用 depth 还原水层厚度
//   · 厚度 → `saturate(depth-0.05)`：浅水纯折射、深水混 `$fogcolor`、且浅水几乎不反射
//   · 最终 `lerp(refr, refl, fresnel)`，alpha 写 1（和源一致）
const REFR_SCALE = 0.5; // 折射 RT 相对画布的分辨率（会被 DU/DV 扰动，降分辨率看不出来）
let refrRT: THREE.WebGLRenderTarget | null = null;
/**
 * 深度 RT：把**到相机的视线距离**直接写进颜色通道（`vec3(dist/scale)`）。
 * 不用 `DepthTexture`（本机自建 RT 里恒读回远平面），也不用 `MeshDepthMaterial(RGBADepthPacking)`
 * （被天空覆盖成 1）—— 自己的 `ShaderMaterial` 输出线性距离，8 位精度在 2000 单位范围内
 * 约 8 单位/级，算水厚足够。
 */
let depthRT: THREE.WebGLRenderTarget | null = null;
let depthMat: THREE.ShaderMaterial | null = null;
// 深度 pass 的量程（世界单位）。原 2000 太小：超出量程的水面采样被 clamp，反推命中点会跑到
// 水面之上 ⇒ 竖直深度=0 ⇒ 远处没有蓝色，且超量程的是哪块水面取决于站位。
const DEPTH_RANGE = 16384;
const sceneDistUniform = { value: null as THREE.Texture | null };
const refrUniform = { value: null as THREE.Texture | null };
const refrOnUniform = { value: 0 };
const refrScreen = { value: new THREE.Vector2(1, 1) };
const refrProjInv = { value: new THREE.Matrix4() };
const refrViewInv = { value: new THREE.Matrix4() };
const refrCamPos = { value: new THREE.Vector3() };
const depthScaleUniform = { value: 1200 };
/** 水面高度表（世界 y），升序，最多 8 层：像素自己找下方最近的一层算水厚。 */
const planeA = { value: new THREE.Vector4() };
const planeB = { value: new THREE.Vector4() };
const planeCount = { value: 0 };
let refrDone = false;
let refrRendering = false;

function refractionOff(): boolean {
  // **缺省开**（2026-10-21 第 4 轮）：编译错误已由 harness 硬门禁兜住（出现 shader error 直接失败），
  // 水厚模型经"金丝雀掩码 + blueT 分箱"验证：蓝度随水厚单调增加（36→44→57→82）。
  // 想退回无折射的纯半透明：`__vbspWaterRefrOn=false`。
  return (g as { __vbspWaterRefrOn?: unknown }).__vbspWaterRefrOn === false;
}
/** 水层"全深"对应的世界厚度（源的 `depthValue` 来自折射缓冲 alpha，是归一化屏幕深度；
 *  这里用真实厚度归一化。1200 ≈ "再深也是深水"：400 单位的池子 ⇒ depth≈0.33，
 *  `saturate(d-0.05)` 给 ~0.28 的 `$fogcolor` 混合、菲涅尔门控已拉满）。 */
/**
 * 竖直深度的归一化范围（"多深算最深"）：优先用**相邻水层的最小合理间隔**（= 这张图的池深），
 * 例 surf_666 升序 [-16064, -11968, -11071, 15296, 15312] ⇒ 897。
 * 单层薄膜（boreas 只有 y=197）没有间隔 ⇒ 用 `fallback`。
 * `fallback` 缺省 600：boreas 实测水下地形比水面低约 300~600 单位（mode 5 分箱 0.25/0.5 各一半，
 * 归一化 1200 时），取 600 刚好让最深处落到 depthV≈1。这是**标定值**，不是解析值。
 */
const depthScaleOf = () => Math.max(16, num((g as { __vbspWaterDepthScale?: unknown }).__vbspWaterDepthScale, 400));

/**
 * 竖直深度的归一化范围：取**相邻水层的最小合理间隔**当作这张图的池深。
 * 例 surf_666 升序 [-16064, -11968, -11071, 15296, 15312] ⇒ 897（真实池深）；
 * 上层池 15296/15312 只差 16（同一面被拆开）⇒ 用 64 的下限过滤掉。
 * 单层薄膜（boreas 只有 y=197）没有间隔 ⇒ 返回 `fallback`。
 */
function planeDepthRange(sortedHeights: number[], fallback: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < sortedHeights.length; i++) {
    const gap = sortedHeights[i] - sortedHeights[i - 1];
    if (gap >= 64 && gap <= 4096 && gap < best) best = gap;
  }
  return Number.isFinite(best) ? best : fallback;
}

/** 渲染折射 RT：隐藏水面材质后把同一相机看到的场景渲进 color+depth。 */
function renderRefraction(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
  const canvas = renderer.getDrawingBufferSize(new THREE.Vector2());
  const w = Math.max(64, Math.floor(canvas.x * REFR_SCALE));
  const h = Math.max(64, Math.floor(canvas.y * REFR_SCALE));
  if (!refrRT || refrRT.width !== w || refrRT.height !== h) {
    refrRT?.dispose();
    depthRT?.dispose();
    refrRT = new THREE.WebGLRenderTarget(w, h);
    refrRT.texture.colorSpace = THREE.NoColorSpace;
    refrUniform.value = refrRT.texture;
    // 深度 RT（线性视线距离写进颜色）
    depthRT = new THREE.WebGLRenderTarget(w, h);
    depthRT.texture.colorSpace = THREE.NoColorSpace;
    sceneDistUniform.value = depthRT.texture;
    if (!depthMat) {
      depthMat = new THREE.ShaderMaterial({
        uniforms: { uScale: { value: DEPTH_RANGE } },
        vertexShader: `
          varying float vDist;
          void main() {
            vec4 mv = modelViewMatrix * vec4( position, 1.0 );
            vDist = length( mv.xyz );
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          uniform float uScale;
          varying float vDist;
          void main() {
            // **三通道 24 位**打包：范围 16384 单位（原 2000 太小 —— 超过量程的水面采样被 clamp，
            // 反推的命中点会跑到水面之上 ⇒ 竖直深度取 0 ⇒ 远处完全没有蓝色，且哪部分超量程取决于
            // 站位 ⇒ 表现为"换个视角远处就不蓝了"）。
            // value = r + g/255 + b/65025，覆盖 [0,1]，精度 ≈ 1/1.6e7（16384 单位下 ≈ 0.001）。
            float d = clamp( vDist / uScale, 0.0, 1.0 );
            float s = d * 255.0;
            float r = floor( s ) / 255.0;
            float g = floor( fract( s ) * 255.0 ) / 255.0;
            float b = fract( fract( s ) * 255.0 );
            gl_FragColor = vec4( r, g, b, 1.0 );
          }`,
        side: THREE.FrontSide,
      });
    }
  }
  // 只隐藏**相机正穿过的那层水面**：按"材质所在块的高度 = 最近水面高度"判定。
  // ⚠️ 不能按 `$abovewater` 判：`water_pure_beneath` 这类"水底"材质的 VMT 也写 `$abovewater 1`
  // （实测 boreas 的 `johnshandy/world/water_pure_beneath`），一起藏掉 ⇒ RT 里只剩背景 ⇒ 水面全黑。
  const nearest = nearestWaterHeight(camera);
  // 隐藏的粒度必须是**网格**而不是材质：666 的 `dev_water2` 同时用作池顶与池底，
  // 按材质隐藏会把底面一起藏掉 ⇒ RT 里没有池底、深度 pass 也量不到厚度（实测厚度恒 0）。
  const hidden: THREE.Mesh[] = [];
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return;
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    const list = Array.isArray(mat) ? mat : mat ? [mat] : [];
    if (!list.some((mm) => waterMaterials.has(mm as THREE.MeshBasicMaterial))) return;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (!bb) return;
    const top = bb.max.y; // 这些合并网格都是水平整层 ⇒ bbox.max.y 就是该层高度
    if (nearest !== null && Math.abs(top - nearest) < 1.5) {
      mesh.visible = false;
      hidden.push(mesh);
    }
  });
  const prevTarget = renderer.getRenderTarget();
  refrRendering = true;
  // RT 的"背景"要与主画面接近：本工程的天空是**网格**（不是 `scene.background`），
  // RT 里渲不到 ⇒ 默认清成黑色，位移采样一旦越界就沿轮廓出现黑边噪点。
  // 这里按 `scene.background` 是颜色时用它，否则用天光色兜底。
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  try {
    renderer.setRenderTarget(refrRT);
    const bg = scene.background;
    if (bg instanceof THREE.Color) renderer.setClearColor(bg, 1);
    else renderer.setClearColor(0xdfe9f2, 1);
    renderer.clear();
    renderer.render(scene, camera);
    // 深度 pass：同一相机、同一"隐藏水面"集合，用自带 shader 把视线距离写进颜色。
    if (depthRT && depthMat) {
      const prevOverride = scene.overrideMaterial;
      scene.overrideMaterial = depthMat;
      renderer.setRenderTarget(depthRT);
      renderer.setClearColor(0xffffff, 1); // 空白 = 最远 ⇒ 水厚按上限算（深水）
      renderer.clear();
      renderer.render(scene, camera);
      scene.overrideMaterial = prevOverride;
    }
  } finally {
    // 同镜像 pass：必须 finally 恢复，否则水面材质永远 invisible ⇒ 水面消失
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    refrRendering = false;
    for (const m of hidden) m.visible = true;
  }

  refrOnUniform.value = 1;
  refrScreen.value.set(canvas.x, canvas.y);
  const cam = camera as THREE.PerspectiveCamera;
  refrProjInv.value.copy(cam.projectionMatrix).invert();
  refrViewInv.value.copy(cam.matrixWorld);
  refrCamPos.value.setFromMatrixPosition(cam.matrixWorld);
  (globalThis as { __vbspWaterRefrRenders?: number }).__vbspWaterRefrRenders =
    ((globalThis as { __vbspWaterRefrRenders?: number }).__vbspWaterRefrRenders ?? 0) + 1;
}

/** 离相机最近的水面块的高度（水平镜面）。没有水面返回 `null`。 */
function nearestWaterHeight(camera: THREE.Camera): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  const camY = camera.position.y;
  for (const [mesh, h] of mirrorMeshes) {
    if (!mesh.visible) continue;
    const d = Math.abs(camY - h);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

/** 渲染镜像 RT（每帧一次；在第一个水面 mesh 的 `onBeforeRender` 里调用）。 */
function renderMirror(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, height: number): void {
  if (!mirrorRT) {
    mirrorRT = new THREE.WebGLRenderTarget(MIRROR_SIZE, MIRROR_SIZE);
    mirrorTexture = mirrorRT.texture;
    mirrorUniform.value = mirrorTexture;
  }
  // 水平镜面：相机关于 y=height 镜像，看向对称点，up 取反
  virtualCamera.position.set(camera.position.x, 2 * height - camera.position.y, camera.position.z);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const look = new THREE.Vector3().copy(camera.position).add(dir);
  look.y = 2 * height - look.y;
  virtualCamera.up.set(0, -1, 0);
  virtualCamera.lookAt(look);
  virtualCamera.near = (camera as THREE.PerspectiveCamera).near;
  virtualCamera.far = (camera as THREE.PerspectiveCamera).far;
  virtualCamera.fov = (camera as THREE.PerspectiveCamera).fov ?? virtualCamera.fov;
  virtualCamera.aspect = (camera as THREE.PerspectiveCamera).aspect ?? virtualCamera.aspect;
  virtualCamera.updateMatrixWorld();
  virtualCamera.projectionMatrix.copy((camera as THREE.PerspectiveCamera).projectionMatrix);
  // 共享纹理矩阵：**不含 modelMatrix**（各水位块的 modelMatrix 在顶点着色器里乘）
  textureMatrix.copy(BIAS).multiply(virtualCamera.projectionMatrix).multiply(virtualCamera.matrixWorldInverse);

  const prevTarget = renderer.getRenderTarget();
  mirrorRendering = true;
  // 水面在镜像 pass 里必须隐藏：否则水面会采样"上一帧的镜面纹理"形成**自反馈**，
  // 表现为反射里叠出方格马赛克（owner 报的"方格是真实存在的"就是这个）。
  const hidden: THREE.Material[] = [];
  for (const m of waterMaterials) {
    if (m.visible) {
      m.visible = false;
      hidden.push(m);
    }
  }
  try {
    renderer.setRenderTarget(mirrorRT);
    renderer.clear();
    renderer.render(scene, virtualCamera);
  } finally {
    // ⚠️ 必须 finally：中途抛错会让水面材质永远停在 `visible=false` ⇒ 水面直接消失
    // （2026-10-21 owner 报"水没了"就是这类状态的后果）。
    renderer.setRenderTarget(prevTarget);
    for (const m of hidden) m.visible = true;
    mirrorRendering = false;
  }
  (globalThis as { __vbspWaterMirrorRenders?: number }).__vbspWaterMirrorRenders =
    ((globalThis as { __vbspWaterMirrorRenders?: number }).__vbspWaterMirrorRenders ?? 0) + 1;
}

/** 给水面 mesh 挂 `onBeforeRender`：整帧第一块水面负责渲染镜像 RT。 */
function attachMirrorDriver(mesh: THREE.Mesh, height: number): void {
  mirrorMeshes.set(mesh, height);
  const prev = mesh.onBeforeRender;
  // 签名固定 6 参（three 的 `Object3D.onBeforeRender`）；转发时逐个透传
  mesh.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
    if (typeof prev === 'function') prev.call(mesh, renderer, scene, camera, geometry, material, group);
    if (mirrorRendering || refrRendering) return;
    const gl = renderer as THREE.WebGLRenderer;
    // 折射 RT 先渲（它要隐藏水面材质；镜像 RT 用镜像相机，两者互不影响）
    if (!refrDone && refrOnUniform.value > 0.5) {
      refrDone = true; // 每帧只渲一次
      renderRefraction(gl, scene, camera);
    }
    if (reflOnUniform.value < 0.5 || mirrorDone) return;
    const h = nearestWaterHeight(camera);
    if (h === null) return;
    mirrorDone = true; // 每帧只渲一次（首块水面）
    renderMirror(gl, scene, camera, h);
  };
}

/** 验收诊断（`globalThis.__vbspWaterDebug`）：确认注入真的进去了、时间/换帧真的在走。 */
const dbg = {
  time: -1,
  scroll1: [0, 0, 0, 0],
  dudvReal: false,
  sheen: false,
  injected: 0,
  frames: 0,
  frameIndex: 0,
};

/** 水面唯一的动态：按 `AnimatedTexture` 的帧率换帧（默认 30fps，源 VMT 就是这个值）。 */
function tick(): void {
  const frozen = typeof g.__vbspWaterTime === 'number' ? (g.__vbspWaterTime as number) : null;
  const t = frozen ?? performance.now() / 1000;
  // 兜底自愈：镜像/折射 pass 若因异常（或嵌套）把水面材质留在 `visible=false`，水面就会整个消失。
  // 每帧（不在任何 RT pass 内时）恢复一次，成本只有几个材质。
  if (!refrRendering && !mirrorRendering) {
    for (const m of waterMaterials) if (!m.visible) m.visible = true;
  }
  timeUniform.value = t; // 秒；滚动速率由 `$scroll1/$scroll2` 在着色器里乘上去
  frameUniform.value = t;  // 换帧：A/B 两帧按帧内相位交叉淡化（等价 `$bumpframe` 的整数换帧 + 淡化去跳变）
  const n = dudvFrameCount;
  const rate = frameRateOf();
  if (n > 1 && rate > 0) {
    const phase = t * rate;
    const i = Math.floor(phase) % n;
    dudvFrameA.value = i / n;
    dudvFrameB.value = ((i + 1) % n) / n;
    dudvFrameMix.value = Math.min(1, Math.max(0, phase - Math.floor(phase)));
  } else {
    // 不做帧动画：固定在第 0 帧（`$scroll1/$scroll2` 的 UV 滚动负责"动"）
    dudvFrameA.value = 0;
    dudvFrameB.value = 0;
    dudvFrameMix.value = 0;
  }
  dbg.time = t;
  dbg.frames = n;
  dbg.frameIndex = n > 1 && rate > 0 ? Math.floor(t * rate) % n : 0;
  (globalThis as { __vbspWaterDebug?: unknown }).__vbspWaterDebug = dbg;
  mirrorDone = false; // 新的一帧 ⇒ 允许渲一次镜像/折射 RT
  refrDone = false;
  if (frozen !== null) return; // 冻结：不再排队（确定性 A/B）
  requestAnimationFrame(tick);
}

function startAnimation(): void {
  if (animating) return;
  // 装配若发生在无 rAF 的环境（worker / 测试），只跳过逐帧动画，不抛错。
  if (typeof requestAnimationFrame !== 'function') return;
  animating = true;
  requestAnimationFrame(tick);
}

/** 水面注入：涟漪（基色/不透明度）+ 菲涅尔反射 + 距离雾色。 */
function injectWater(material: THREE.MeshBasicMaterial, w: WaterExtras): void {
  // 兜底色同样是**泛白**（与 Rust 侧 `WATER_COLOR` 同口径；extras 缺 `fog` 时才用到）
  const fog = new THREE.Color().fromArray(w.fog ?? [0.87, 0.91, 0.93]);
  const refract = num(w.refractAmount, 0.6);
  const fogStart = Math.max(0, num(w.fogStart, 0));
  const fogEndRaw = num(w.fogEnd, 0);
  const fogEnd = fogEndRaw > fogStart ? fogEndRaw : fallbackFogEndOf();
  const wave = waveOf() * Math.max(0.25, refract);
  const fogMix = fogMixOf();
  // 涟漪滚动速率：**优先地图自带**的 `$scroll1`/`$scroll2`。
  // 2026-10-19 修正：此前为了在没有换帧时"看起来在动"而放大 4 倍；现在换帧（30fps）已按
  // SDK 生效，故回到地图作者写的原值（owner：平移本来就不该快）。
  // 全局旋钮 `__vbspWaterFlow`（>0 时）整体覆盖。
  const flow = flowOf();
  const scrollScale = flow > 0 ? flow / 0.012 : 1;
  const scroll1 = (w.scroll1 ?? [0.01, 0.01]).map((v) => v * scrollScale) as [number, number];
  const scroll2 = (w.scroll2 ?? [-0.025, 0.025]).map((v) => v * scrollScale) as [number, number];
  // `$scale`（地图自带的水面贴图缩放）：直接乘在平铺密度上
  const scale = Math.max(0.05, ((w.scale?.[0] ?? 1) + (w.scale?.[1] ?? 1)) / 2);
  // `$bumpmap` / `$normalmap` / `$bumptransform`：地图**声明**的失真图与变换。
  // 本工程只内嵌了 `dev/water_dudv` 的动画帧 ⇒ 声明别的图时告警并回退（不静默改行为）。
  const bump = (w.bumpmap ?? '').toString().replace(/\\/g, '/').toLowerCase();
  if (bump && !bump.includes('water_dudv')) {
    console.warn(`[water] 材质声明 $bumpmap="${w.bumpmap}"，本工程未内嵌该失真图 ⇒ 回退 dev/water_dudv`);
  }
  const bumpRotate = (num(w.bumpRotate, 0) * Math.PI) / 180;
  const bumpScaleX = num(w.bumpScale?.[0], 1);
  const bumpScaleY = num(w.bumpScale?.[1], 1);

  // 水面基色 = `$refracttint` 与 `$fogcolor`（sRGB 分支）的混合：源里水面颜色来自折射出的
  // 水下环境（青蓝），`$fogcolor` 正是那条环境色。纯 `$refracttint` 接近白色 ⇒ 会变成奶白。
  // 有折射 RT 时，水面像源一样是**不透明合成**（颜色里已含折射出的水底）；beneath 材质仍半透明。
  const opaque = opaqueDebug();
  // 水面**始终半透明**（2026-10-21 第 4 轮）：目标要"近处近似透明、厚处泛蓝"，
  // 靠 `alpha = mix(nearAlpha, farAlpha, blueT)` 实现；若材质不透明，alpha 被强制 1 ⇒
  // 近处永远是"一块白的"，薄处无法真正透出水底。折射颜色已含水下内容，透明合成没问题。
  material.opacity = 1;
  material.transparent = !opaque;
  material.depthWrite = false;
  // 水面基色：往"深蓝"方向压（owner 目标："水底形如蓝天"）。直接混浅蓝 `$fogcolor`
  // 在亮冰面上只会被冲淡成白，所以取一个更饱和的深蓝做水体色，浅蓝留给远处的蓝调渐变。
  // 水面基色：**饱和青蓝**（数值目标是 owner 游戏截图里的水面均色 `#2a91d3` / `#1399e6`）。
  // `$fogcolor`（`water01` 的 srgb 分支 (120,200,255)）本身太浅，直接混会把水面冲成浅灰。
  const baseColor = new THREE.Color(0.12, 0.52, 0.72);
  material.color.copy(baseColor);
  // 调试：覆盖基色（isolate 判断波纹形状时用明显颜色）
  const colorOverride = g.__vbspWaterColor;
  if (Array.isArray(colorOverride) && colorOverride.length >= 3) {
    material.color.fromArray(colorOverride as [number, number, number]);
  }
  const shadeStrength = shadeStrengthOf();

  material.onBeforeCompile = (shader) => {
    shader.uniforms.vbspWaterTime = timeUniform;
    shader.uniforms.vbspWaterTex = { value: rippleTexture() };
    shader.uniforms.vbspWaterWave = { value: wave };
    // ⚠️ VMT 里的 `$fogcolor` 是 **gamma/sRGB 空间**的数值（boreas 水面 120,200,255 ⇒ 0.47,0.78,1）。
    // 直接当线性值喂给 three，输出时再做 linear→sRGB ⇒ 颜色被提亮成近白（实测偏离目标 30%+）。
    // 先转换到线性空间，出屏才等于材质声明的那个颜色。
    const fogLinear = fog.clone().convertSRGBToLinear();
    shader.uniforms.vbspWaterFog = {
      value: new THREE.Vector3(fogLinear.r, fogLinear.g, fogLinear.b),
    };
    shader.uniforms.vbspWaterFogStart = { value: fogStart };
    shader.uniforms.vbspWaterFogEnd = { value: fogEnd };
    shader.uniforms.vbspWaterFogMix = { value: fogMix };
    // 平面反射（three `Water.js` 手法）：镜像 RT + 共享纹理矩阵 + 法线扭曲 + 菲涅尔混合
    shader.uniforms.vbspWaterMirror = mirrorUniform;
    shader.uniforms.vbspWaterTextureMatrix = textureMatrixUniform;
    shader.uniforms.vbspWaterReflOn = reflOnUniform;
    // 反射 UV 的位移幅度（源的 `scale.xy = $reflectamount`）。owner 反馈"反射过强/光散太分散"
    // ⇒ 幅度从 0.05 降到 0.012，并把反射混合再乘一个可调强度（缺省 0.55）。
    shader.uniforms.vbspWaterDistort = { value: 0.012 * Math.max(0.1, num(w.reflectAmount, 0.8)) };
    shader.uniforms.vbspWaterReflStrength = {
      value: Math.min(1, Math.max(0, num(g.__vbspWaterReflectStrength, 0.12))),
    };
    // 水体色（最终往它收敛）+ 收敛强度
    shader.uniforms.vbspWaterBaseColor = { value: new THREE.Vector3(baseColor.r, baseColor.g, baseColor.b) };
    shader.uniforms.vbspWaterTintStrength = {
      value: Math.min(1, Math.max(0, num(g.__vbspWaterTint, 0.0))),
    };
    // 体积吸收（owner 指出的正确方向）：`absorb` 是每世界单位衰减系数、`thickness` 是水层厚度、
    // `scatter` 是水体散射色（取 owner 游戏截图实测的 #2a91d3 附近）。
    shader.uniforms.vbspWaterAbsorb = { value: Math.max(0, num(g.__vbspWaterAbsorb, 0.004)) };
    shader.uniforms.vbspWaterAbsorbThickness = { value: Math.max(1, num(g.__vbspWaterThickness, 180)) };
    // 深水色：按 owner 游戏截图的实测目标 `#2a91d3` 反推的线性值
    // （0.035→sRGB≈0.22/56、0.30→≈0.62/158、0.60→≈0.81/207，对应 rgb(42,145,211)）。
    shader.uniforms.vbspWaterScatter = { value: new THREE.Vector3(0.035, 0.30, 0.60) };
    shader.uniforms.vbspWaterDeepMix = { value: Math.min(1, Math.max(0, num(g.__vbspWaterDeepMix, 0.95))) };
    // 真实水厚模型的参数（缺省值针对 100–300 单位深的池子）
    shader.uniforms.vbspWaterThickness = { value: Math.max(1, num(g.__vbspWaterThickness, 180)) };
    shader.uniforms.vbspWaterTransFloor = { value: Math.min(1, Math.max(0, num(g.__vbspWaterTransFloor, 0.45))) };
    shader.uniforms.vbspWaterAlphaRef = { value: Math.max(1, num(g.__vbspWaterAlphaRef, 220)) };
    // 光程过渡区间（世界单位）：薄于此 ≈ 全透，厚于彼 ≈ 全蓝
    shader.uniforms.vbspWaterThickLo = { value: Math.max(1, num(g.__vbspWaterThickLo, 80)) };
    shader.uniforms.vbspWaterThickHi = { value: Math.max(2, num(g.__vbspWaterThickHi, 600)) };
    shader.uniforms.vbspWaterSceneDist = sceneDistUniform;
    shader.uniforms.vbspWaterDepthRange = { value: DEPTH_RANGE };
    // 用深度 pass 的真实"到地形距离"当水厚（**缺省开**：目标要的是"水底离水面多远"）。
    // 想退回常数膜厚模型：`__vbspWaterUseDepthPass=false`。
    shader.uniforms.vbspWaterUseDepthPass = { value: g.__vbspWaterUseDepthPass === false ? 0 : 1 };
    // 「水底太蓝了，浅一些」：fogMix 上限 + 中段软化曲线
    // tp-more 那档（owner 选定）：上限 0.45
    shader.uniforms.vbspWaterFogMax = { value: Math.min(1, Math.max(0, num(g.__vbspWaterFogMax, 0.45))) };
    // 「稍微白点、近似透明」：水色下限（tp-more 用的是 0）
    shader.uniforms.vbspWaterFogFloor = {
      value: Math.min(1, Math.max(0, num(g.__vbspWaterFogFloor, 0.0))),
    };
    shader.uniforms.vbspWaterFogCurve = { value: Math.max(0.2, num(g.__vbspWaterFogCurve, 1.35)) };
    // tp-more 那档：折射内容亮度上限 0.78
    shader.uniforms.vbspWaterContentMax = { value: Math.max(0.05, num(g.__vbspWaterContentMax, 0.78)) };
    // 岸边透明带：宽度（世界单位，竖直深度口径）与"岸边反射可见度"。
    // 40 是实测选定值：140 太大（水深才 400，整片都被淡化），40 只影响真正的岸线。
    shader.uniforms.vbspWaterShoreWidth = { value: Math.max(1, num(g.__vbspWaterShoreWidth, 40)) };
    shader.uniforms.vbspWaterShoreRefl = { value: Math.min(1, Math.max(0, num(g.__vbspWaterShoreRefl, 1.0))) };
    // 近处近乎透明（看得清水底）、远处带蓝且更不透（"水底形如蓝天"）
    shader.uniforms.vbspWaterNearAlpha = { value: Math.min(1, Math.max(0, num(g.__vbspWaterNearAlpha, 0.15))) };
    shader.uniforms.vbspWaterFarAlpha = { value: Math.min(1, Math.max(0, num(g.__vbspWaterFarAlpha, 0.97))) };
    // 蓝调/透明度渐变的距离区间（世界单位）：近处几乎全透，800 单位外完全"蓝天"
    shader.uniforms.vbspWaterBlueStart = { value: Math.max(0, num(g.__vbspWaterBlueStart, 60)) };
    shader.uniforms.vbspWaterBlueEnd = { value: Math.max(1, num(g.__vbspWaterBlueEnd, 800)) };
    shader.uniforms.vbspWaterReflTint = { value: new THREE.Vector3().fromArray(w.reflectTint ?? [1, 1, 1]) };
    shader.uniforms.vbspWaterReflMix = { value: Math.min(1, Math.max(0, num(w.reflectAmount, 0.8))) };    // 涟漪滚动速率：优先地图自带的 `$scroll1`/`$scroll2`
    shader.uniforms.vbspWaterScroll1 = { value: new THREE.Vector2(scroll1[0], scroll1[1]) };
    shader.uniforms.vbspWaterScroll2 = { value: new THREE.Vector2(scroll2[0], scroll2[1]) };
    shader.uniforms.vbspWaterRippleScale = { value: (1 / rippleSizeOf()) * scale };
    // `$bumptransform` 的 scale/rotate：作用在主采样 UV 上（SDK 的 `cBumpTexCoordTransform`）
    shader.uniforms.vbspWaterBumpScale = { value: new THREE.Vector2(bumpScaleX, bumpScaleY) };
    shader.uniforms.vbspWaterBumpRotate = { value: bumpRotate };
    // 真·DU/DV 动画帧（起源水面的失真场，`$bumpmap dev/water_dudv`）
    shader.uniforms.vbspWaterDudv = dudvUniform;
    shader.uniforms.vbspWaterFrameA = dudvFrameA;
    shader.uniforms.vbspWaterFrameB = dudvFrameB;
    shader.uniforms.vbspWaterFrameInv = dudvFrameInv;
    shader.uniforms.vbspWaterFrameMix = dudvFrameMix;
    // `__vbspWaterDudvOff`：诊断用 —— 关掉 DU/DV 失真场（slope 归零），
    // 用来把"网格/斜纹是失真场带来的还是别处"分离出来。
    const dudvOff = (g as { __vbspWaterDudvOff?: unknown }).__vbspWaterDudvOff === true;
    shader.uniforms.vbspWaterDudvOn = { value: dudvOff ? 0 : 1 };
    dudvTexture(); // 触发解码（失败时会就地换成兜底图）
    // 屏幕空间折射（源 `_rt_WaterRefraction` 的对应实现）
    shader.uniforms.vbspWaterRefr = refrUniform;
    shader.uniforms.vbspWaterRefrOn = refrOnUniform;
    shader.uniforms.vbspWaterScreen = refrScreen;
    shader.uniforms.vbspWaterProjInv = refrProjInv;
    shader.uniforms.vbspWaterViewInv = refrViewInv;
    shader.uniforms.vbspWaterCamPos = refrCamPos;
    shader.uniforms.vbspWaterRefractTint = { value: new THREE.Vector3().fromArray(w.refractTint ?? [1, 1, 1]) };
    shader.uniforms.vbspWaterRefractAmt = { value: Math.max(0.05, refract) };
    shader.uniforms.vbspWaterDepthScale = depthScaleUniform;
    shader.uniforms.vbspWaterPlanesA = planeA;
    shader.uniforms.vbspWaterPlanesB = planeB;
    shader.uniforms.vbspWaterPlaneCount = planeCount;
    // `$waterdepth`（地图给的每块水深）：优先用作"水层深度"。
    // 拿不到时由 `applyWaterShaders` 用**顶面/底面高度差**补上（同一水体的 `_beneath` 面）。
    const patchDepth = num(w.waterDepth, 0);
    const depthHolder = { depth: { value: patchDepth }, use: { value: patchDepth > 0 ? 1 : 0 } };
    materialDepth.set(material, depthHolder);
    shader.uniforms.vbspWaterPatchDepth = depthHolder.depth;
    shader.uniforms.vbspWaterUsePatchDepth = depthHolder.use;
    shader.uniforms.vbspWaterDefaultDepth = { value: Math.min(1, Math.max(0, num(g.__vbspWaterDefaultDepth, 0.35))) };
    shader.uniforms.vbspWaterAbove = { value: (w.aboveWater ?? true) ? 1 : 0 };
    shader.uniforms.vbspWaterShadeStrength = { value: shadeStrength };
    shader.uniforms.vbspWaterDebugDepth = { value: Math.max(0, num(g.__vbspWaterDebugDepth, 0)) };
    // 1 = 只测 ripple 段（品红）、2 = 只测 env 段（红）；数字方便区分两段是否都执行。
    shader.uniforms.vbspWaterCanary = { value: Math.max(0, num(g.__vbspWaterCanary, 0)) };

    // ── 顶点：自带 uv / 视空间法线与视线 / 视距 / 镜像 UV ──
    //
    // 全部自算，不用 three 的 `vViewPosition` / `vNormal`：`meshbasic_frag` 里前者只在
    // USE_ENVMAP 时才声明、后者在 FLAT_SHADED 时不存在，而水面的 envMap 是**晚到**的
    // （首次编译时常为空）⇒ 依赖它们会直接编译失败（实测 `'vViewPosition' : undeclared identifier`）。
    shader.vertexShader =
      'uniform mat4 vbspWaterTextureMatrix;\n' +
      'varying vec3 vbspWaterN;\nvarying vec3 vbspWaterV;\nvarying float vbspWaterDist;\nvarying vec4 vbspWaterMirrorUv;\nvarying vec3 vbspWaterWorld;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        [
          '#include <project_vertex>',
          '	vec4 vbspWaterWorld4 = modelMatrix * vec4( transformed, 1.0 );',
          '	vbspWaterWorld = vbspWaterWorld4.xyz;',
          '	vbspWaterN = normalMatrix * normal;',
          '	vbspWaterV = - mvPosition.xyz;',
          '	vbspWaterDist = length( mvPosition.xyz );',
          // 镜像 UV：纹理矩阵**不含 modelMatrix**（共享一张 RT）⇒ 这里自己乘世界矩阵
          '	vbspWaterMirrorUv = vbspWaterTextureMatrix * vbspWaterWorld4;',
        ].join('\n'),
      );

    // ── 片元：涟漪 + 雾色（接在 albedo 之后） ──
    const rippleBlock = [
      'uniform float vbspWaterTime;',
      'uniform sampler2D vbspWaterTex;',
      'uniform float vbspWaterWave;',
      'uniform vec3 vbspWaterFog;',
      'uniform float vbspWaterFogStart;',
      'uniform float vbspWaterFogEnd;',
      'uniform float vbspWaterFogMix;',
      'uniform sampler2D vbspWaterMirror;',
      'uniform mat4 vbspWaterTextureMatrix;',
      'uniform float vbspWaterReflOn;',
      'uniform float vbspWaterDistort;',
      'uniform vec3 vbspWaterReflTint;',
      'uniform float vbspWaterReflMix;',
      'uniform float vbspWaterReflStrength;',
      'uniform vec3 vbspWaterBaseColor;',
      'uniform float vbspWaterTintStrength;',
      'uniform float vbspWaterAbsorb;',
      'uniform float vbspWaterAbsorbThickness;',
      'uniform vec3 vbspWaterScatter;',
      'uniform float vbspWaterThickness;',
      'uniform float vbspWaterTransFloor;',
      'uniform float vbspWaterAlphaRef;',
      'uniform float vbspWaterThickLo;',
      'uniform float vbspWaterThickHi;',
      'uniform float vbspWaterDeepMix;',
      'uniform sampler2D vbspWaterSceneDist;',
      'uniform float vbspWaterDepthRange;',
      'uniform float vbspWaterUseDepthPass;',
      'uniform float vbspWaterFogMax;',
      'uniform float vbspWaterFogCurve;',
      'uniform float vbspWaterFogFloor;',
      'uniform float vbspWaterShoreWidth;',
      'uniform float vbspWaterShoreRefl;',
      'uniform float vbspWaterContentMax;',
      'uniform float vbspWaterNearAlpha;',
      'uniform float vbspWaterFarAlpha;',
      'uniform float vbspWaterBlueStart;',
      'uniform float vbspWaterBlueEnd;',
      // ⚠️ 这两行曾经漏了 `uniform`（写成裸的 `vec2 vbspWaterScroll1;`）⇒ 它们成了**恒为 0 的
      // 全局变量**，GLSL 照样编译通过，只是 `scroll * time` 永远是 0 ⇒ 水面完全静止
      // （实测 `__vbspWaterTime=0` 与 `=100` 逐字节相同）。加 uniform 时务必别漏关键字。
      'uniform vec2 vbspWaterScroll1;',
      'uniform vec2 vbspWaterScroll2;',
      'uniform float vbspWaterRippleScale;',
      'uniform vec2 vbspWaterBumpScale;',
      'uniform float vbspWaterBumpRotate;',
      'uniform sampler2D vbspWaterDudv;',
      'uniform float vbspWaterFrameA;',
      'uniform float vbspWaterFrameB;',
      'uniform float vbspWaterFrameInv;',
      'uniform float vbspWaterFrameMix;',
      'uniform float vbspWaterDudvOn;',
      // 屏幕空间折射（源 `_rt_WaterRefraction` 的对应实现）
      'uniform sampler2D vbspWaterRefr;',
      'uniform float vbspWaterRefrOn;',
      'uniform vec2 vbspWaterScreen;',
      'uniform mat4 vbspWaterProjInv;',
      'uniform mat4 vbspWaterViewInv;',
      'uniform vec3 vbspWaterCamPos;',
      'uniform vec3 vbspWaterRefractTint;',
      'uniform float vbspWaterRefractAmt;',
      'uniform float vbspWaterDepthScale;',
      'uniform vec4 vbspWaterPlanesA;',
      'uniform vec4 vbspWaterPlanesB;',
      'uniform float vbspWaterPlaneCount;',
      'uniform float vbspWaterPatchDepth;',
      'uniform float vbspWaterUsePatchDepth;',
      'uniform float vbspWaterDefaultDepth;',
      'uniform float vbspWaterAbove;',
      'uniform float vbspWaterShadeStrength;',
      'uniform float vbspWaterDebugDepth;',
      'uniform float vbspWaterCanary;',
      // 图集行坐标：**先 `fract`**（世界 UV 是要平铺的，会到几十的整数倍；不平铺就会取到
      // 图集里别的帧/别的行 ⇒ 水面出现方格、抖动成乱纹、"定格"，2026-10-20 owner 报的方格就是这个），
      // 再把局部 v 压到 1/frames 并抬到第 frame 行。
      // 自己算是因为 three **只对内置贴图槽应用 offset/repeat**，自定义 uniform 采样的贴图不吃变换。
      'vec2 vbspFrameUv( vec2 uv, float frame ) { vec2 t = fract( uv ); return vec2( t.x, t.y * vbspWaterFrameInv + frame ); }',
      'varying vec3 vbspWaterWorld;',
      'varying vec3 vbspWaterN;',
      'varying vec3 vbspWaterV;',
      'varying float vbspWaterDist;',
      'varying vec4 vbspWaterMirrorUv;',
    ].join('\n');

    const rippleInject = [
      // 注意：**不要**加大括号包起来 —— 下面的反射块要复用这里的变量（同一作用域）。
      //
      // 口径对照 `water_ps2x_helper.h` 的 `DrawWater`：
      // ① 失真图**逐帧换**（`NORMALMAP + BUMPFRAME`，VMT `AnimatedTexture` 30fps）⇒ 这里用
      //    A/B 两帧交叉淡化（去帧跳变），`vbspWaterFrameMix` 由 tick 推进；
      // ② `$scroll1` 一非零就开 `MULTITEXTURE`：`vNormal = 0.33*(vNormal + vNormal1 + vNormal2)`
      //    —— 同一个失真图在**三组不同滚动 UV** 上采样求平均，交叉波面就是这么来的（只平移一层
      //    看起来是"整张图在滑"，owner 指出过）；
      // ③ `vNormal` **只进 `vDependentTexCoords`**（位移折射/反射 UV），不乘进 diffuse。
      // ⚠️ 三组采样坐标必须照抄 SDK 的 `Water_vs20.fxc`（此前写成 uv / uv*1.37 / uv*0.71 —— 全是
      // **同向等比**缩放 ⇒ 叠加出来是"单向等距"的条纹，owner 指出过）：
      //   vBumpTexCoord      = base
      //   f45x = x + y, f45y = y - x                      ← **旋转 45°**
      //   vExtraBumpTexCoord.xy = (f45x, f45y) * 0.1 + scroll1*t   ← 45°、0.1 倍（大尺度涌浪）
      //   vExtraBumpTexCoord.zw = (y, x) * 0.45 + scroll2*t        ← **转置**、0.45 倍（中尺度）
      // 片元再 `0.33 * (n0 + n1 + n2)`：三种尺度/朝向混合，才是各向同性的水波。
      'vec2 vbspWaterDuv = vbspWaterWorld.xz * vbspWaterRippleScale;',
      // 主采样先过 `$bumptransform` 的 scale/rotate（SDK 的 `cBumpTexCoordTransform`）
      'vec2 vbspBase = vec2( vbspWaterDuv.x * vbspWaterBumpScale.x, vbspWaterDuv.y * vbspWaterBumpScale.y );',
      'if ( abs( vbspWaterBumpRotate ) > 0.0001 ) {',
      '	float cs = cos( vbspWaterBumpRotate ); float sn = sin( vbspWaterBumpRotate );',
      '	vbspBase = vec2( vbspBase.x * cs - vbspBase.y * sn, vbspBase.x * sn + vbspBase.y * cs );',
      '}',
      'vec2 vbspF45 = vec2( vbspBase.x + vbspBase.y, vbspBase.y - vbspBase.x );',
      'vec2 vbspUv1 = vbspF45 * 0.1 + vbspWaterScroll1 * vbspWaterTime;',
      'vec2 vbspUv2 = vec2( vbspBase.y, vbspBase.x ) * 0.45 + vbspWaterScroll2 * vbspWaterTime;',
      'vec2 vbspN0 = mix( texture2D( vbspWaterDudv, vbspFrameUv( vbspBase, vbspWaterFrameA ) ).rg, texture2D( vbspWaterDudv, vbspFrameUv( vbspBase, vbspWaterFrameB ) ).rg, vbspWaterFrameMix );',
      'vec2 vbspN1 = mix( texture2D( vbspWaterDudv, vbspFrameUv( vbspUv1, vbspWaterFrameA ) ).rg, texture2D( vbspWaterDudv, vbspFrameUv( vbspUv1, vbspWaterFrameB ) ).rg, vbspWaterFrameMix );',
      'vec2 vbspN2 = mix( texture2D( vbspWaterDudv, vbspFrameUv( vbspUv2, vbspWaterFrameA ) ).rg, texture2D( vbspWaterDudv, vbspFrameUv( vbspUv2, vbspWaterFrameB ) ).rg, vbspWaterFrameMix );',
      'vec2 vbspSlope = ( ( vbspN0 + vbspN1 + vbspN2 ) * 0.3333 - 0.5 ) * 2.0 * vbspWaterDudvOn;',
      // 波纹的**法线着色**：把失真场当高度场求的坡度当法线，打一盏固定方向光（漫射+高光）。
      // 强度由 `vbspWaterShadeStrength` 控制：正常 0.35（压小），
      // `__vbspWaterDebugShade` 时拉到 1（配合 `__vbspWaterOpaque` 单独判断波纹形状像不像水）。
      'vec3 vbspLightDir = normalize( vec3( 0.45, 0.72, 0.53 ) );',
      'vec3 vbspWaveN = normalize( vec3( vbspSlope * 1.7, 1.0 ) );',
      'float vbspDiff = max( dot( vbspWaveN, vbspLightDir ), 0.0 );',
      'float vbspSpec = pow( max( dot( reflect( -vbspLightDir, vbspWaveN ), normalize( vbspWaterV ) ), 0.0 ), 28.0 );',
      'vec3 vbspShaded = diffuseColor.rgb * ( 0.55 + 0.65 * vbspDiff ) + vec3( vbspSpec ) * 0.9;',
      'diffuseColor.rgb = mix( diffuseColor.rgb, vbspShaded, vbspWaterShadeStrength );',
      // ── 水层深度（源：`_rt_WaterRefraction.a`，归一化 0..1）──
      // ⚠️ 必须**先算深度再算位移**：位移公式要用它（水浅位移更小）。此前顺序写反过，
      // 片元编译报 `'vbspWaterDepthValue' : undeclared identifier` ⇒ 水面材质整个不画
      // （2026-10-21 owner 报"水没了"，日志里 `THREE.WebGLProgram: Shader Error` 就是这个）。
      // 优先用**地图自带的 `$waterdepth`**（VBSP 的 depth patch 就是给这个用的）。
      'float vbspDepthRaw = -1.0;',
      'float vbspSceneDist = vbspWaterDist;',
      // ⚠️ 初值**不能是 1.0**（"最深"）：boreas 只有一层水面 ⇒ 找不到下方平面 ⇒ 初值留下 ⇒
      // `$fogcolor` 被混到 95% ⇒ 水面变成一块 #C0C5C7 浅灰（owner 三次报"发白"就是这个）。
      // 拿不到深度时按"浅水"兜底，让折射/基色主导。
      'float vbspWaterDepthValue = vbspWaterDefaultDepth;',
      'if ( vbspWaterUsePatchDepth > 0.5 ) {',
      '	vbspWaterDepthValue = clamp( vbspWaterPatchDepth / vbspWaterDepthScale, 0.0, 1.0 );',
      '} else if ( vbspWaterPlaneCount > 0.5 ) {',
      // 水厚 = 本像素的水面高度 - **它下方最近的那层水面高度**（多面水体积，per-pixel 正确）。
      // 例 surf_666：顶面 -11071、底面 -11968 ⇒ 水厚 897。boreas 只有一层 ⇒ 水厚 0（诚实）。
      '	float vbspLower = -1e9;',
      '	for ( int i = 0; i < 8; i++ ) {',
      '		if ( float( i ) >= vbspWaterPlaneCount ) break;',
      '		float v = i < 4 ? vbspWaterPlanesA[ i ] : vbspWaterPlanesB[ i - 4 ];',
      '		if ( v < vbspWaterWorld.y - 1.0 && v > vbspLower ) vbspLower = v;',
      '	}',
      '	if ( vbspLower > -1e8 ) vbspWaterDepthValue = clamp( ( vbspWaterWorld.y - vbspLower ) / vbspWaterDepthScale, 0.0, 1.0 );',
      '} else if ( vbspWaterRefrOn > 0.5 ) {',
      // 拿不到 `$waterdepth`、也没法从几何推（水面 brush 的上下两面在 BSP 里是同一平面，
      // 实测 boreas 全部水面块都在 y=197）⇒ 用可调的**缺省归一化深度**：
      // 0.35 ⇒ `$fogcolor` 混 0.30、菲涅尔门控已满（以折射为主 + 可见反射）。
      '	vbspWaterDepthValue = vbspWaterDefaultDepth;',
      '}',
      // ── 折射（源 `_rt_WaterRefraction`）：用 DU/DV 位移屏幕 UV 采样"不含水面"的场景 RT ──
      'vec2 vbspScreenUv = gl_FragCoord.xy / vbspWaterScreen;',
      // 源的 `scale *= depthValue`（无 basetexture 分支）：水浅则位移更小。
      // 幅度也要小：owner 反馈"光散过于分散、边缘不该是散点"。
      'vec2 vbspRefrUv = vbspScreenUv + vbspSlope * ( 0.010 * max( 0.25, vbspWaterRefractAmt ) * mix( 0.35, 1.0, vbspWaterDepthValue ) );',
      // 位移采样若落进"没有几何"的区域（RT 背景是黑的），会沿轮廓出现黑边噪点 ⇒
      // 与未位移处比较亮度，明显变暗就回退到未位移样本（常见的 refraction 边缘修正）。
      'vec3 vbspRefrShifted = texture2D( vbspWaterRefr, vbspRefrUv ).rgb;',
      'vec3 vbspRefrBase = texture2D( vbspWaterRefr, vbspScreenUv ).rgb;',
      'if ( dot( vbspRefrShifted, vec3( 0.3333 ) ) < dot( vbspRefrBase, vec3( 0.3333 ) ) * 0.35 ) { vbspRefrShifted = vbspRefrBase; }',
      // RT 里"没有几何"的两类样本都不要当内容：
      //   ① 纯黑（未渲染）；② 接近清屏色 `#dfe9f2`（我们给 RT 设的天光兜底色）。
      // 否则薄水会把这些空白透成白色/黑斑（owner 报的"白 X"与"白板"都属这类）。
      // ⚠️ 用 `vbspWaterBaseColor` 这个 **uniform**，不要用 `diffuseColor.rgb`：
      // 水面材质的 `material.color` 在渲染前会被光照/fullbright 那条路按 lightmap 重设
      // ⇒ 我改 `material.color` 的效果全部被覆盖（这就是"改颜色没反应"的根因，
      // 2026-10-21 用金丝雀测试证实：注入确实控制这些像素，但颜色来自被覆盖后的 diffuse）。
      'vec3 vbspRefrColor = vbspWaterRefrOn > 0.5 ? vbspRefrShifted : vbspWaterBaseColor;',
      'float vbspLum0 = dot( vbspRefrShifted, vec3( 0.3333 ) );',
      'float vbspClearDist = distance( vbspRefrShifted, vec3( 0.874, 0.914, 0.949 ) );',
      'bool vbspNoGeom = ( vbspLum0 < 0.02 ) || ( vbspClearDist < 0.05 );',
      'if ( vbspWaterRefrOn > 0.5 && vbspNoGeom ) { vbspRefrColor = vbspWaterScatter; }',
      // ── 竖直深度 + 视线距离（照抄 SDK `common_ps_fxc.h:213-230` 的 `CalcWaterFogAlpha`）──
      //   flDepthFromWater = 水面 y − 命中点 y              ← 竖直深度
      //   f                = saturate(flDepthFromWater / flDepthFromEye)
      //   alpha            = saturate(f * flProjPosZ * 1/fogRange)   ← **还要乘视线距离**
      // 漏掉最后那一项时：远处命中点跑到水面之上 ⇒ 竖直深度取 0 ⇒ 远处反而没有蓝色（owner 报的
      // "距离我越远越看不到蓝色"）。乘上视线距离后，薄膜在掠射远处也会累积成蓝，符合源的表现。
      'float vbspDepthVert = -1.0;',
      'float vbspHitDist = 0.0;',
      // (a) 有真实水体积：水面层 − 它下方最近的那层（层表，纯竖直差）
      'if ( vbspWaterPlaneCount > 0.5 ) {',
      '	float vbspLower = -1e9;',
      '	for ( int i = 0; i < 8; i++ ) {',
      '		if ( float( i ) >= vbspWaterPlaneCount ) break;',
      '		float v = i < 4 ? vbspWaterPlanesA[ i ] : vbspWaterPlanesB[ i - 4 ];',
      '		if ( v < vbspWaterWorld.y - 1.0 && v > vbspLower ) vbspLower = v;',
      '	}',
      '	if ( vbspLower > -1e8 ) { vbspDepthVert = vbspWaterWorld.y - vbspLower; vbspHitDist = vbspWaterDist; }',
      '}',
      // (b) 零厚度薄膜（如 boreas）：深度 pass 的命中点换回**世界 y**，再取竖直差
      'if ( vbspDepthVert < 0.0 && vbspWaterUseDepthPass > 0.5 && vbspWaterRefrOn > 0.5 ) {',
      '	vec3 vbspDistPack3 = texture2D( vbspWaterSceneDist, vbspScreenUv ).rgb;',
      '	float vbspSceneDist = ( vbspDistPack3.r + vbspDistPack3.g / 255.0 + vbspDistPack3.b / 65025.0 ) * vbspWaterDepthRange;',
      // 量程尽头 / 背景 = 没测到。**测不到就按"深水"处理**：远处本来该是蓝的，
      // 不能因为"这一帧没量到"就退化成透明（那会让颜色随站位变化，owner 报的就是这个）。
      '	bool vbspDistValid = vbspSceneDist > 1.0 && vbspSceneDist < vbspWaterDepthRange * 0.995;',
      '	if ( vbspDistValid ) {',
      '		vec3 vbspRayDir = normalize( vbspWaterWorld.xyz - cameraPosition );',
      '		float vbspHitY = cameraPosition.y + vbspRayDir.y * vbspSceneDist;',
      '		vbspDepthVert = max( 0.0, vbspWaterWorld.y - vbspHitY );',
      '		vbspHitDist = vbspSceneDist;',
      '	} else {',
      '		vbspDepthVert = vbspWaterDepthScale;',
      '		vbspHitDist = max( vbspWaterDist, vbspWaterDepthScale );',
      '	}',
      '}',
      'if ( vbspDepthVert < 0.0 ) vbspDepthVert = 0.0;',
      'if ( vbspHitDist < 1.0 ) vbspHitDist = vbspWaterDist;',
      // 命中点世界 y（体积路径下 = 水面 − 竖直深度，两者一致）
      'float vbspHitY2 = vbspWaterWorld.y - vbspDepthVert;',
      'float vbspDepthFromEye = max( 1.0, cameraPosition.y - vbspHitY2 );',
      'float vbspUnderFrac = clamp( vbspDepthVert / vbspDepthFromEye, 0.0, 1.0 );',
      'float vbspDepthV = clamp( vbspDepthVert / max( 1.0, vbspWaterDepthScale ), 0.0, 1.0 );',
      // 雾量 = **只看竖直深度**（final-b 那版公式，owner 觉得蓝量合适）。
      // 之前那个 `* vbspHitDist`（乘视线距离）会把整片水推成饱和蓝，已删除。
      'float vbspFogAlpha = vbspDepthV;',
      // 折射内容兜底：RT 里没有几何（采到清屏色/纯黑）时，按深度给水色，别给白/黑块。
      'if ( vbspWaterRefrOn > 0.5 && vbspNoGeom ) {',
      '	vbspRefrColor = mix( vbspWaterFog, vbspWaterBaseColor, 0.35 );',
      '}',
      // 折射内容亮度上限：亮冰/亮岩透上来会把水面冲成"白板"（owner：「不要泛太白」）。
      // 按亮度等比压，保色相 —— 只削掉过曝那一截。
      'float vbspLumC = dot( vbspRefrColor, vec3( 0.299, 0.587, 0.114 ) );',
      'vbspRefrColor *= min( 1.0, vbspWaterContentMax / max( vbspLumC, 1e-4 ) );',
      // 源原文：`refract = lerp( refract * tint, $fogcolor, saturate( depth - 0.05 ) )`。
      // 「水底太蓝了，浅一些」⇒ ① `pow` 软化中段（不是线性就冲到满）；② 上限 `fogMax` 不让它饱和成纯蓝。
      // 「稍微白点、近似透明」⇒ 同时给一个**很轻的下限** `fogFloor`：近处不要纯透成亮冰的白，而是
      // 带一点点水色（少量白蓝），近看仍然近似透明。
      'float vbspFogMix = pow( saturate( vbspFogAlpha - 0.05 ), vbspWaterFogCurve );',
      'vbspFogMix = clamp( vbspFogMix, vbspWaterFogFloor, vbspWaterFogMax );',
      'vbspRefrColor = mix( vbspRefrColor * vbspWaterRefractTint, vbspWaterFog, vbspFogMix );',
      // 深水吸收：雾量越大压得越暗一点，避免远处变成一条发亮的蓝雾带。
      'vbspRefrColor *= mix( 1.0, 0.88, vbspFogMix );',
      'diffuseColor.rgb = vbspRefrColor;',
      // ⚠️ **必须同时写 `outgoingLight`**：`<opaque_fragment>` 输出的是 `outgoingLight`，而它在本
      // 材质里由 `reflectedLight.indirectDiffuse` 初始化（lightmap 那套），与 `diffuseColor.rgb`
      // 无关。只写 `diffuseColor.rgb` ⇒ 我算的水色从未上屏（这就是"调了半天颜色没反应"的最后一环，
      // 2026-10-21 用 dump 编译后源码确认）。
      'outgoingLight = vbspRefrColor;',
      // ── 岸边透明带（owner：「岸边全透明只保留反射，离岸才是上面那档透明度」）──
      // 用**竖直深度**当"离岸距离"的代理：岸边水浅（depthVert→0），往里变深。
      //   shoreT=0（岸边）⇒ alpha 只剩反射项 ⇒ 几乎看不见水，只留镜面反射
      //   shoreT=1（离岸）⇒ alpha=1，正常水色（tp-more 那档）
      'float vbspShoreT = smoothstep( 0.0, max( 1.0, vbspWaterShoreWidth ), vbspDepthVert );',
      'float vbspFres0 = pow( clamp( 1.0 - clamp( dot( normalize( vbspWaterN ), normalize( vbspWaterV ) ), 0.0, 1.0 ), 0.0, 1.0 ), 5.0 );',
      'float vbspReflAlpha = clamp( vbspFres0 * vbspWaterReflStrength, 0.0, 1.0 );',
      'if ( vbspWaterRefrOn > 0.5 ) {',
      '	diffuseColor.a = max( vbspShoreT, vbspReflAlpha * vbspWaterShoreRefl );',
      '} else {',
      '	diffuseColor.a = mix( vbspWaterNearAlpha, vbspWaterFarAlpha, vbspDepthV );',
      '}',
      // 旧的"按视距混蓝 / 按视线光程吸收 / 按水厚映射"三版已全部删除：
      // 它们的自变量都与"离水面多远"无关，被 owner 判定为错误方向（见 docs/water-depth-blue-derivation.md）。
      // 金丝雀（ripple 段）：这段若没执行，水面不会变品红 ⇒ 区分"注入没进"与"颜色算法不对"。
      'if ( vbspWaterCanary > 0.5 && vbspWaterCanary < 1.5 ) { diffuseColor.rgb = vec3( 1.0, 0.0, 1.0 ); diffuseColor.a = 1.0; }',
    ].join('\n');

    let frag = shader.fragmentShader.replace(
      '#include <common>',
      '#include <common>\n#include <packing>\n' + rippleBlock,
    );
    // ⚠️ 锚点必须是**运行时真的存在**的那一个：`#include <map_fragment>` 在这批水面材质里
    // 已经不存在（前置的光照/世界过渡阶段把它改造掉了）⇒ 之前 `replace` 静默失败，
    // 整段涟漪/折射/alpha 逻辑从未编译进去（只有 envmap 段生效）。
    // `#include <envmap_fragment>` 已用"金丝雀"验证存在，且此处 `diffuseColor` 与
    // `outgoingLight` 都已声明 ⇒ 两个块一起插在这里。
    if (!frag.includes('#include <envmap_fragment>')) {
      console.warn('[water] 片元里找不到 envmap_fragment 锚点 ⇒ 水面注入可能不生效');
    }

    // ── 反射：菲涅尔调制（正视≈不反射，掠射≈全反射）+ 涟漪扰动反射方向 ──
    const envBlock = [
      // 菲涅尔：照 `DrawWater` —— `fNdotV = saturate(dot(eye, n)); fresnel = pow(1 - fNdotV, 5)`
      '	float vbspFres = pow( clamp( 1.0 - clamp( dot( normalize( vbspWaterN ), normalize( vbspWaterV ) ), 0.0, 1.0 ), 0.0, 1.0 ), 5.0 );',
      // 源的**无 basetexture 分支**：`fFresnel *= saturate((depth - 0.05) * 20)`
      // —— 水浅（水底近）几乎不反射，水深才成镜面。有了折射 RT 的深度就能照抄。
      '	if ( vbspWaterRefrOn > 0.5 ) { vbspFres *= saturate( ( vbspFogAlpha - 0.05 ) * 20.0 ); }',
      // ① three `Water.js` 的平面反射：镜面 UV + 双层滚动法线的扭曲
      '	if ( vbspWaterReflOn > 0.5 ) {',
      '		vec2 vbspMuv = vbspWaterMirrorUv.xy / max( 1e-4, vbspWaterMirrorUv.w );',
      '		vbspMuv = clamp( vbspMuv, vec2( 0.001 ), vec2( 0.999 ) );',
      '		vbspMuv += vbspSlope * vbspWaterDistort;',
      '		vec3 vbspMirror = texture2D( vbspWaterMirror, vbspMuv ).rgb * vbspWaterReflTint;',
      '		float vbspMix = clamp( vbspFres * vbspWaterReflStrength, 0.0, 0.40 );',
      '		outgoingLight = mix( outgoingLight, vbspMirror, vbspMix );',
      // 反射越强越不透（Source 的 `lerp(refract, reflect, fresnel)` 同样是替换而不是叠加）
      '		diffuseColor.a = mix( diffuseColor.a, 1.0, vbspMix );',
      '	}',
      // ② 没有平面反射时退回天空盒 envMap（近白，形同环境光；仅作兜底）
      '	#ifdef USE_ENVMAP',
      '		if ( vbspWaterReflOn < 0.5 ) {',
      '			vec3 vbspReflectVec = reflect( -normalize( vbspWaterV ), normalize( vbspWaterN ) );',
      '			vbspReflectVec = normalize( vbspReflectVec + vec3( vbspSlope * ( vbspWaterWave * 0.35 ), 0.0 ) );',
      '			#ifdef ENVMAP_TYPE_CUBE',
      '				vec4 vbspEnvColor = textureCube( envMap, envMapRotation * vec3( flipEnvMap * vbspReflectVec.x, vbspReflectVec.yz ) );',
      '			#else',
      '				vec4 vbspEnvColor = vec4( 0.0 );',
      '			#endif',
      '			outgoingLight += vbspEnvColor.xyz * reflectivity * vbspFres;',
      '		}',
      '	#endif',
      // 最终"水色收敛"：反射与折射在掠射角都会采到明亮的岩壁/冰面 ⇒ 水面变成灰白板
      // （owner 反复报"发白/不像水"）。这里把最终颜色往**水体色**拉一把，保证任何角度都读出
      // "青绿的水"，同时保留折射/反射带来的明暗层次（只是被水色统一）。
      // 注意：必须改 `outgoingLight`（`<opaque_fragment>` 用的是它；写 `diffuseColor.rgb`
      // 在这之后不会被采纳 —— 第一版就踩了这个，画面完全没变化）。
      '	outgoingLight = mix( outgoingLight, vbspWaterBaseColor, vbspWaterTintStrength );',
      // 调试：`__vbspWaterDebugDepth` 时把中间量直接输出成颜色（R=raw depth, G=厚度/深度尺度,
      // B=视距/深度尺度），用来**量化**深度还原到底错在哪（不靠肉眼猜）。
      '	if ( vbspWaterCanary > 1.5 ) {',
      // 金丝雀：强制纯红不透明。确认"我改的到底是不是屏幕上的水"。
      // 用 2 这个值（而不是 1）以便与 ripple 段的品红金丝雀区分开：1=品红（只在 ripple 段）、
      // 2=红（只在 env 段）—— 两段都会执行，后执行的会盖掉先执行的，所以必须分开取值。
      '		outgoingLight = vec3( 1.0, 0.0, 0.0 );',
      '		diffuseColor.a = 1.0;',
      '	} else if ( vbspWaterDebugDepth > 1.5 && vbspWaterDebugDepth < 2.5 ) {',
      // 2 = 常量绿：验证调试分支确实被执行（若屏幕没变绿 ⇒ 分支没进/被后续 fog 覆盖）
      '		outgoingLight = vec3( 0.0, 1.0, 0.0 );',
      '		diffuseColor.a = 1.0;',
      '	} else if ( vbspWaterDebugDepth > 4.5 ) {',
      // 5 = **雾量场** `vbspFogAlpha`（0=透明，1=最深/最蓝）：与着色同量，分箱统计才有意义
      '		outgoingLight = vec3( vbspFogAlpha );',
      '		diffuseColor.a = 1.0;',
      '	} else if ( vbspWaterDebugDepth > 3.5 ) {',
      // 4 = 直接输出折射 RT（未位移）⇒ 一眼看清"RT 里到底剩了什么"
      '		outgoingLight = texture2D( vbspWaterRefr, vbspScreenUv ).rgb;',
      '		diffuseColor.a = 1.0;',
      '	} else if ( vbspWaterDebugDepth > 2.5 ) {',
      // 3 = 把时间/滚动/位移直接画出来：R=time/4, G=fract(uv1.x), B=length(slope)
      '		outgoingLight = vec3( vbspWaterTime / 4.0, fract( vbspUv1.x ), length( vbspSlope ) );',
      '		diffuseColor.a = 1.0;',
      '	} else if ( vbspWaterDebugDepth > 0.5 ) {',
      '		outgoingLight = vec3( vbspDepthRaw, vbspWaterDepthValue, clamp( vbspWaterDist / vbspWaterDepthScale, 0.0, 1.0 ) );',
      '		diffuseColor.a = 1.0;',
      '	}',
    ].join('\n');
    // 涟漪/扭曲取样点与反射块在同一个作用域（`vbspSlope` 等定义在上面那段注入里）
    // 涟漪/折射（`rippleInject`）+ 反射（`envBlock`）**一起**插在 envmap 锚点处：
    // 前者必须先执行（它算 `vbspSlope` / `vbspRefrColor` / alpha），后者用到那些变量。
    frag = frag.replace('#include <envmap_fragment>', rippleInject + '\n' + envBlock);

    shader.fragmentShader = frag;
    dbg.sheen = frag.includes('vbspWaterRefr'); // 折射 RT 代码是否进程序
    // 把**实际交给 three 编译**的片元源码存一份（验收时能确认注入真的进了程序，而不是只在字符串里）
    (globalThis as { __vbspWaterFrag?: string }).__vbspWaterFrag = frag;
    dbg.scroll1 = [scroll1[0], scroll1[1], scroll2[0], scroll2[1]];
    dbg.dudvReal = dudvFrameCount > 0; // 真图（帧图集）是否就位
    dbg.injected++;
    (material as unknown as { __vbspWaterInject?: boolean }).__vbspWaterInject = true;
  };
  material.needsUpdate = true;
  waterMaterials.add(material);
  startAnimation();
}

/** 体检用：材质 `side` 的可读名（FrontSide / BackSide / DoubleSide）。 */
function materialSideName(m: THREE.Material): string {
  if (!m) return 'none';
  if (m.side === THREE.BackSide) return 'back';
  if (m.side === THREE.DoubleSide) return 'double';
  return 'front';
}

/**
 * 给场景里的水面材质挂上水面注入。返回注入的材质个数。
 *
 * 必须在 `applyLightmapToMeshes`（世界面已路由成材质）与 `optimizeScene` **之后**调用：
 * 水面 `lightofs == -1` ⇒ 走 fullbright 分支，落到一个普通 `MeshBasicMaterial`；
 * 多材质合并块要逐槽注入。
 */
export function applyWaterShaders(root: THREE.Object3D): number {
  const reflOff = reflectOff();
  reflOnUniform.value = reflOff ? 0 : 1;
  const refrOff = refractionOff();
  refrOnUniform.value = refrOff ? 0 : 1;
  depthScaleUniform.value = depthScaleOf();
  if (g.__vbspWaterOff === true) return 0;
  const seen = new Set<THREE.Material>();
  /** 链路检查：每个水面块的镜面高度 vs 几何真实 y 范围（合并块上 `center+position` 是否成立）。 */
  const planes: { y: number; yMin: number; yMax: number; posY: number; mats: string[] }[] = [];
  /** 体检清单①：水下几何/材质 + 朝向。 */
  const beneathInfo: {
    mats: string[];
    y: number;
    yMin: number;
    yMax: number;
    xMin: number;
    xMax: number;
    zMin: number;
    zMax: number;
    normalY: number;
    side: string;
  }[] = [];
  let injected = 0;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (seen.has(m)) continue;
      const w = readWater(m);
      if (!w) continue;
      seen.add(m);
      injectWater(m as THREE.MeshBasicMaterial, w);
      // **在这里**打标记（而不是等 `onBeforeCompile` 里第一帧编译才打）：
      // 后面的 `applyBumpShaders` 要据此让位，它跑在任何一次渲染之前。
      (m as unknown as { __vbspWaterInject?: boolean }).__vbspWaterInject = true;
      injected++;
    }
    // 镜像驱动挂在**水面块**上（块里只要有一槽是水就算），高度取包围球中心
    // ⚠️ 体检与高度表**不受 `__vbspWaterReflectOff` 影响**：水深计算要用它们。
    if (mats.some((m) => readWater(m))) {
      const geom = mesh.geometry;
      if (!geom.boundingSphere) geom.computeBoundingSphere();
      if (!geom.boundingBox) geom.computeBoundingBox();
      const h = (geom.boundingSphere?.center.y ?? 0) + mesh.position.y;
      if (planes.length < 12) {
        planes.push({
          y: h,
          yMin: (geom.boundingBox?.min.y ?? 0) + mesh.position.y,
          yMax: (geom.boundingBox?.max.y ?? 0) + mesh.position.y,
          posY: mesh.position.y,
          mats: mats.filter((m) => readWater(m)).map((m) => m.name).slice(0, 3),
        });
      }
      for (const mm of mats) if (readWater(mm)) materialHeight.set(mm, h);
      // 体检清单①：水下几何/材质清单 —— 记下每个水面块用的材质、朝向（法线 y 均值）、
      // y 范围、双面与否。用来判断 `*_beneath`（`$bottommaterial` 派生的底面）到底在不在画、
      // 朝向对不对（源里它是水体积的底面，从上看应当被水面挡住、从下看才是"水底"）。
      {
        const nrm = geom.getAttribute('normal');
        let ny = 0;
        let sample = 0;
        if (nrm && nrm.count > 0) {
          for (let i = 0; i < nrm.count; i += Math.max(1, Math.floor(nrm.count / 8))) {
            ny += nrm.getY(i);
            sample++;
          }
        }
        beneathInfo.push({
          mats: [...new Set(mats.filter((m) => readWater(m)).map((m) => m.name))],
          y: h,
          yMin: (geom.boundingBox?.min.y ?? 0) + mesh.position.y,
          yMax: (geom.boundingBox?.max.y ?? 0) + mesh.position.y,
          // 水面块的 x/z 包围盒：拿去算"水池中心"，别再瞎猜机位
          xMin: (geom.boundingBox?.min.x ?? 0) + mesh.position.x,
          xMax: (geom.boundingBox?.max.x ?? 0) + mesh.position.x,
          zMin: (geom.boundingBox?.min.z ?? 0) + mesh.position.z,
          zMax: (geom.boundingBox?.max.z ?? 0) + mesh.position.z,
          normalY: sample ? ny / sample : 0,
          side: materialSideName((Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material),
        });
      }
      if (!reflOff) attachMirrorDriver(mesh, h);
    }
  });
  // 水深：VBSP 把水面 brush 的**顶面**与**底面**（`...water` / `..._beneath`）都导出来了
  // （`vbsp/faces.cpp:AssignBottomWaterMaterialToFace` 把 `$bottommaterial` 派给底面）。
  // 同一材质会出现在**多个高度**（例 surf_666 的 `dev/dev_water2` 在 -11071 与 -11968 都有，
  // 相差 897 单位）⇒ 不能"每材质记一个高度"，改成**把整张高度表交给着色器**，
  // 由每个像素自己找它下方最近的那层面（per-pixel 正确，且天然处理多层水）。
  const planeHeights = [...new Set([...materialHeight.values()])].sort((a, b) => a - b).slice(0, 8);
  if (planeHeights.length) {
    const a = new THREE.Vector4();
    const b = new THREE.Vector4();
    for (let i = 0; i < planeHeights.length; i++) {
      if (i < 4) a.setComponent(i, planeHeights[i]);
      else b.setComponent(i - 4, planeHeights[i]);
    }
    planeA.value.copy(a);
    planeB.value.copy(b);
    planeCount.value = planeHeights.length;
    // 竖直深度的归一化范围：用**相邻水层的最小合理间隔**（就是这张图的池深）。
    // 例 surf_666 升序 -16064 / -11968 / -11071 / 15296 / 15312 ⇒ 897 被选中（池深）。
    // 单层薄膜（如 boreas，只有 y=197）⇒ 无间隔，落回缺省值。
    depthScaleUniform.value = planeDepthRange(planeHeights, depthScaleOf());
    console.info(`[water] 水面高度表（世界 y，升序）：${planeHeights.join(' / ')}`);
  }
  if (injected > 0) {
    // 记录算出的水深（顶面-底面高度差），验收时能直接看出"这片水有多深"
    const depths = [...materialDepth.entries()]
      .filter(([, d]) => d.use.value > 0.5)
      .map(([m, d]) => `${m.name}=${d.depth.value.toFixed(0)}`);
    if (depths.length) console.info(`[water] 水深（世界单位）：${[...new Set(depths)].slice(0, 8).join(' ｜ ')}`);
    console.info(
      `[water] 水面注入：${injected} 个材质（涟漪幅度=${waveOf().toFixed(2)} 距离雾终点=${fallbackFogEndOf()}）` +
        (reflOff ? '；平面反射已关（__vbspWaterReflectOff）' : `；平面反射开（${MIRROR_SIZE}² 共享 RT，水平镜面）`),
    );
    // 诊断：把解析到的水面参数摊在 `globalThis` 上（验收脚本据此确认走的是**地图自带参数**
    // 还是兜底泛白值；两者必须能区分，否则无法判断解析链通没通）。
    // 按**材质名去重**（同一材质在多个合并块里会出现多次；此前 slice(0,6) 会把后面的材质名挤掉，
    // 导致"某个水体没被当成水"这种覆盖缺口看不出来）。
    const byName = new Map<string, unknown>();
    for (const m of seen) {
      const w = readWater(m);
      if (w && !byName.has(m.name)) byName.set(m.name, { name: m.name, ...w });
    }
    (globalThis as { __vbspWaterParams?: unknown }).__vbspWaterParams = [...byName.values()];
    (globalThis as { __vbspWaterNames?: unknown }).__vbspWaterNames = [...byName.keys()];
    (globalThis as { __vbspWaterPlanes?: unknown }).__vbspWaterPlanes = planes;
    (globalThis as { __vbspWaterBeneath?: unknown }).__vbspWaterBeneath = beneathInfo.slice(0, 24);
  }
  return injected;
}
