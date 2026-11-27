/**
 * 折射 / 水下通路：屏幕空间折射 RT、深度/平面还原、水面材质注入、逐帧换帧与门面。
 *
 * 从 ../water.ts 拆出；行为与拆分前逐字一致。范围内的模块级可变状态
 * （waterMaterials / materialHeight / materialDepth / refrUniform / dudv* / timeUniform 等）
 * 只在本文件声明；镜面状态全部来自 ./planar-reflect.js。
 */
import * as THREE from 'three';
import { WATER_DUDV } from '../water-dudv-data.js';
import {
  WATER_ENV_BLOCK,
  WATER_RIPPLE_BLOCK,
  WATER_RIPPLE_INJECT,
  WATER_VERTEX_HEADER,
  WATER_VERTEX_PROJECT,
} from './glsl.js';
import {
  MIRROR_SIZE,
  mirrorMeshes,
  mirrorPlaneOf,
  mirrorRendering,
  mirrorUniform,
  reflectOff,
  reflOnUniform,
  textureMatrix,
  textureMatrixUniform,
} from './planar-reflect.js';

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
  /** #2 导出：该水材质/水体块在 BSP 里的 top-bottom 世界厚度（boreas=0，666>0）。 */
  waterThickness?: number;
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

const g = globalThis as {
  __vbspWaterWave?: unknown;
  __vbspWaterFlow?: unknown;
  __vbspWaterOff?: unknown;
  __vbspWaterTime?: unknown;
  /** 只读 time pin（T-650 v2 V0）：数字 = 钉在该秒；true = 钉在 0。不停 tick/RT。 */
  __vbspWaterTimePin?: unknown;
  __vbspWaterFogMix?: unknown;
  __vbspWaterFallbackFogEnd?: unknown;
  __vbspWaterRippleSize?: unknown;
  __vbspWaterFrameRate?: unknown;
  __vbspWaterOpacity?: unknown;
  __vbspWaterMirrorSize?: unknown;
  /** 外部脚本逃生舱用；生产路径已改走 `RenderFrameContext.waterForcePass`（T-P2-1）。 */
  __vbspWaterForcePass?: 'refr' | 'mirror';
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
  /** T-650 v4 W-A：深水像素合成档（0=关/1=天空镜面/2=厚度稳定雾/3=深渊暗色；暗雾流恒 0）。 */
  __vbspWaterVoidMode?: unknown;
  /** T-650 v4 W-A：深水判定的归一化深度阈值（0..1，缺省 0.5，PS 上可 live 调）。 */
  __vbspWaterDeepV?: unknown;
  /** T-650 v4 W-A2：暗内容曝光倍率（1=现状；黑区岩壁随增大显露）。 */
  __vbspWaterContentLift?: unknown;
  /** 反射强度（缺省 0.28；owner 反馈反射过强）。 */
  __vbspWaterReflectStrength?: unknown;
  __vbspWaterDepthGateOff?: unknown;
  __vbspWaterDepthGate?: unknown;
  __vbspWaterHideAllRefr?: unknown;
  __vbspWaterAlphaFloor?: unknown;
  __vbspWaterAlphaCap?: unknown;
  __vbspWaterRtDecode?: unknown;
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
  /** T-650 v2 R2：折射内容乘性提亮上限（亮雾流缺省 1.35；暗雾流恒 1 = 不提亮）。 */
  __vbspWaterLift?: unknown;
  /** T-650 v2 R3：掠射位移下限（亮雾流缺省 0.35；视线越平位移越收紧；1 = 关闭）。 */
  __vbspWaterGrazAtt?: unknown;
  /** T-650 v2 R4：反射混合权重上限（亮雾流缺省 0.25；暗雾流保持 0.40）。 */
  __vbspWaterReflCap?: unknown;
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
/** 波纹法线着色强度：缺省 0（按 SDK，水面没有 basetexture 时观感全部来自
 *  lerp(refract, reflect, fresnel)；噪声失真图不是法线）。留旋钮做实验用：
 *  `__vbspWaterDebugShade` ⇒ 1。 */
const shadeStrengthOf = () =>
  g.__vbspWaterDebugShade === true ? 1 : num(g.__vbspWaterShade, 0);
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
export const waterMaterials = new Set<THREE.MeshBasicMaterial>();
/** 材质 → 所在水面块的镜面高度（折射 RT 只隐藏"相机正穿过的那层"，保留水底材质）。 */
const materialHeight = new Map<THREE.Material, number>();
/** 材质 → 水深 uniform 持有者（水深 = 同一水体的顶面与底面高度差）。 */
const materialDepth = new Map<THREE.Material, { depth: { value: number }; use: { value: number } }>();
/** 材质 → beneath 深色 uniform 持有者（T-650 v2 R5：真·打空像素的安静回落色；值在装配后回填）。 */
const beneathFogHolders = new Map<THREE.MeshBasicMaterial, { value: THREE.Vector3 }>();
/** `*_beneath` 类水底材质的（高度, $fogcolor 原值）候选表；R5 回落色按"最近下方"配对。 */
const beneathFogCandidates: { y: number; fog: THREE.Color }[] = [];
const timeUniform = { value: 0 };
/** 换帧相位（秒）；片元里用 `vbspWaterFrameMix` 在 A/B 两帧间淡化。 */
const frameUniform = { value: 0 };


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
/**
 * 折射颜色 RT：**单缓冲、同帧写入后立刻采样**。
 *
 * 曾经改成双缓冲（ping-pong）试图消除「写后读」停顿，实测 p95/p99 完全没有变化
 * （8.9/15.25 vs 8.97/15.17），却让水面材质采到**上一轮**的 RT：相机在动时等于用新投影
 * 采样旧画面，反射/折射整体滞后 1~3 帧，表现为水面"拖影"。已回退成单缓冲。
 */
let refrRT: THREE.WebGLRenderTarget | null = null;
/**
 * 深度 RT：把**到相机的视线距离**直接写进颜色通道（`vec3(dist/scale)`）。
 * 不用 `DepthTexture`（本机自建 RT 里恒读回远平面），也不用 `MeshDepthMaterial(RGBADepthPacking)`
 * （被天空覆盖成 1）—— 自己的 `ShaderMaterial` 输出线性距离，8 位精度在 2000 单位范围内
 * 约 8 单位/级，算水厚足够。与颜色 RT 同样单缓冲。
 */
let depthRT: THREE.WebGLRenderTarget | null = null;
let depthMat: THREE.ShaderMaterial | null = null;
// 深度 pass 的量程（世界单位）。原 2000 太小：超出量程的水面采样被 clamp，反推命中点会跑到
// 水面之上 ⇒ 竖直深度=0 ⇒ 远处没有蓝色，且超量程的是哪块水面取决于站位。
const DEPTH_RANGE = 16384;
const sceneDistUniform = { value: null as THREE.Texture | null };
const refrUniform = { value: null as THREE.Texture | null };
export const refrOnUniform = { value: 0 };
const refrScreen = { value: new THREE.Vector2(1, 1) };
const refrProjInv = { value: new THREE.Matrix4() };
const refrViewInv = { value: new THREE.Matrix4() };
const refrCamPos = { value: new THREE.Vector3() };
const depthScaleUniform = { value: 1200 };
/**
 * ① 折射深度的取法：直接采样**颜色 RT 的深度附件**，取代原来那趟
 * 「同一相机 + 同一隐藏水面集合 + overrideMaterial」的整场景 depth pass。
 *
 * 为什么可以等价：color pass 本来就是同一台相机、同一批隐藏水面后渲的整场景，
 * 深度附件记录的就是同一个「视线到水下几何」的距离；旧 pass 用 `length(mv.xyz)`
 * 写 24 位 pack，新路径用 `projectionMatrix⁻¹` 把窗口深度还原成 view 空间点再取模长，
 * 两者都是欧氏距离。背景（清屏 depth=1）在两条路里都判「无效 ⇒ 按深水处理」。
 *
 * 历史坑（注释原话）：早年在自建 RT 上挂 `DepthTexture` 读到恒为远平面 —— 这次是
 * 在**真正渲染这个 RT 的那一趟**之前挂好附件，并用 `depthTexture.needsUpdate`
 * 由 three 自己分配。
 *
 * 2026-11-17：**默认关闭**。实测两条路性能等价（同页交错 A/B：mean 3.132 vs 3.136、
 * p90 3.17~3.19，均在噪声内 —— 因为真正的收益来自折射/镜面隔帧，depth pass 本身很便宜），
 * 而深度附件路径与旧构建有 ~1.9% 的岸线细边像素差（深度精度），旧 pass 与旧构建是
 * 0.017%（逐像素一致）。既然不省时间，就默认用旧 pass 保住「画面与之前一致」。
 * A/B 用 `__vbspWaterDepthTex=true` 打开（会重建 RT）。
 */
const depthTexUniform = { value: null as THREE.Texture | null };
const depthTexOn = { value: 1 };
/** 当前 RT 是否按「深度附件」模式建（`null` = 还没建过）；与开关不一致时重建 RT。 */
let refrDepthTexMode: boolean | null = null;
function depthTexEnabled(): boolean {
  return (g as { __vbspWaterDepthTex?: unknown }).__vbspWaterDepthTex === true;
}
/** 水面高度表（世界 y），升序，最多 8 层：像素自己找下方最近的一层算水厚。 */
const planeA = { value: new THREE.Vector4() };
const planeB = { value: new THREE.Vector4() };
const planeCount = { value: 0 };
// （T-650 v4 后折射/深度 RT 每帧由 renderWaterFramePasses 无条件重渲，旧的 refrDone 每帧一次门已删。）
let refrRendering = false;
const _refrCanvasSize = new THREE.Vector2();
const _refrPrevClear = new THREE.Color();
const _refrHidden: THREE.Mesh[] = [];
/** 装配期登记的「水面 mesh → 顶面 bbox.max.y」，供 `renderRefraction` 直接遍历，避免每帧 traverse 整场景。 */
const waterMeshes = new Map<THREE.Mesh, number>();
/** 装配期缓存的「水面 mesh → 世界 AABB」，供视锥门控精确测试（避免巨型包围球跨层误触发）。 */
const waterBoxes = new Map<THREE.Mesh, THREE.Box3>();
const _waterBox = new THREE.Box3();
/** 装配期预筛的 `*_beneath` 水下底面材质 → 水位高度，避免每帧对全部水材质跑正则。 */
const beneathMaterials = new Map<THREE.MeshBasicMaterial, number>();
/** 装配期预筛的非水体半透明网格 + 世界包围盒底面 y，用于在折射 RT 中跳过水面之上的玻璃/透明物。 */
const aboveRefrCandidates: Array<{ mesh: THREE.Mesh; minY: number }> = [];
/** 当前场景最低一层水面的高度（仅最低层在多面水中会落回 depthRT 测深）。 */
let lowestWaterHeight: number | null = null;

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

/** 是否需要跑第二趟折射 depthRT（单层水或最低层水在视锥内时才需要；多层水高处像素只查 planeA/B）。 */
export function needsRefractionDepthPass(visibleHeights: Set<number> | null): boolean {
  if (planeCount.value <= 1 || lowestWaterHeight === null || visibleHeights === null) return true;
  if (num(g.__vbspWaterDebugDepth, 0) > 0.5) return true;
  return visibleHeights.has(lowestWaterHeight);
}

/** 渲染折射 RT：隐藏水面材质后把同一相机看到的场景渲进 color+depth。 */
export function renderRefraction(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  skipDepthPass = false,
): void {
  const canvas = renderer.getDrawingBufferSize(_refrCanvasSize);
  // 只用于 A/B 取证：`__vbspWaterRefrScale = 0.25` 看「RT 分辨率是不是瓶颈」（改了会触发一次重建）。
  const scale = (g as { __vbspWaterRefrScale?: number }).__vbspWaterRefrScale ?? REFR_SCALE;
  const w = Math.max(64, Math.floor(canvas.x * scale));
  const h = Math.max(64, Math.floor(canvas.y * scale));
  if (
    !refrRT ||
    refrRT.width !== w ||
    refrRT.height !== h ||
    refrDepthTexMode !== depthTexEnabled()
  ) {
    refrRT?.dispose();
    depthRT?.dispose();
    const mkRT = (): THREE.WebGLRenderTarget => {
      const t = new THREE.WebGLRenderTarget(w, h);
      t.texture.colorSpace = THREE.NoColorSpace;
      return t;
    };
    const useDepthTex = depthTexEnabled();
    refrDepthTexMode = useDepthTex;
    refrRT = mkRT();
    if (useDepthTex) {
      // 深度附件必须**在这个 RT 第一次渲染前**挂上（之后挂会读到未初始化的纹理）。
      const dt = new THREE.DepthTexture(w, h);
      dt.format = THREE.DepthFormat;
      dt.type = THREE.UnsignedIntType;
      refrRT.depthTexture = dt;
      depthRT = null;
      depthTexUniform.value = dt;
      depthTexOn.value = 1;
    } else {
      depthRT = mkRT();
      depthTexUniform.value = null;
      depthTexOn.value = 0;
    }
    refrUniform.value = refrRT.texture;
    sceneDistUniform.value = depthRT ? depthRT.texture : null;
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
  _refrHidden.length = 0;
  const hideAll = g.__vbspWaterHideAllRefr === true;
  if (waterMeshes.size > 0) {
    for (const [mesh, top] of waterMeshes) {
      if (!mesh.visible) continue;
      if (hideAll || (nearest !== null && Math.abs(top - nearest) < 1.5)) {
        mesh.visible = false;
        _refrHidden.push(mesh);
      }
    }
  } else {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return;
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      const list = Array.isArray(mat) ? mat : mat ? [mat] : [];
      if (!list.some((mm) => waterMaterials.has(mm as THREE.MeshBasicMaterial))) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      if (!bb) return;
      const top = bb.max.y;
      if (hideAll || (nearest !== null && Math.abs(top - nearest) < 1.5)) {
        mesh.visible = false;
        _refrHidden.push(mesh);
      }
    });
  }
  // 相机在水面上方时，隐藏严格位于该水面之上的非水体半透明网格（如水池上方网格玻璃），
  // 既省去折射/深度 pass 中的半透明 draw，也避免主画面玻璃叠加折射 RT 里的玻璃产生双层泛白。
  if (nearest !== null && camera.position.y > nearest - 0.5) {
    for (let i = 0; i < aboveRefrCandidates.length; i++) {
      const c = aboveRefrCandidates[i];
      if (!c.mesh.visible) continue;
      if (c.minY >= nearest - 0.5) {
        c.mesh.visible = false;
        _refrHidden.push(c.mesh);
      }
    }
  }
  const prevTarget = renderer.getRenderTarget();
  refrRendering = true;
  // RT 的"背景"要与主画面接近：本工程的天空是**网格**（不是 `scene.background`），
  // RT 里渲不到 ⇒ 默认清成黑色，位移采样一旦越界就沿轮廓出现黑边噪点。
  // 这里按 `scene.background` 是颜色时用它，否则用天光色兜底。
  const prevClear = renderer.getClearColor(_refrPrevClear);
  const prevAlpha = renderer.getClearAlpha();
  try {
    // ⚠️ ① 深度附件模式下 `depthRT` 是 null（深度挂在 `refrRT.depthTexture` 上），所以这里
    // **只能**判 `refrRT`；早先写成 `if (refrRT && depthRT)` 会跳过 setRenderTarget，
    // 整趟场景就渲到屏幕上/旧 target 上，refrRT 永远没内容 ⇒ 水面全按「无几何」深水兜底
    // （静态图与基线差 13% 像素、整片水偏蓝）。
    if (refrRT) renderer.setRenderTarget(refrRT);
    // T-650 v4：**无条件清成透明黑**（c61f188 原始设计）。此前当 scene.background 是颜色时
    // （pre-frame 钩子先于 renderSkyPass 执行时必然如此）清成天空色 alpha=1——无几何水域
    // 的 RT 像素因此"看似有内容"（不触发 NoGeom 透明兜底）又被雾罩 ⇒ 一定机位下蓝板复现。
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    // 深度 pass：同一相机、同一"隐藏水面"集合，用自带 shader 把视线距离写进颜色。
    // ① 2026-11-17：默认改为采颜色 RT 的深度附件（见 depthTexUniform 注释），这趟只剩回退路径。
    if (!skipDepthPass && depthRT && depthMat && depthTexOn.value <= 0.5) {
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
    for (let i = 0; i < _refrHidden.length; i++) _refrHidden[i].visible = true;
    _refrHidden.length = 0;
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

/**
 * 只刷新折射用的相机矩阵/屏幕尺寸 uniform（不重渲 RT）。
 *
 * 为什么要有：RT 隔帧更新时，相机每帧都在动，屏幕空间折射查表用的 `refrProjInv/refrViewInv/refrCamPos`
 * 若停留在旧帧，水面会按错位的投影采样（2/3 的帧出现扭曲）。所以 uniform 必须**每帧**更新，
 * 只有 `renderer.render` 那部分才节流。
 */
export function updateRefrUniforms(camera: THREE.Camera, renderer: THREE.WebGLRenderer): void {
  refrOnUniform.value = 1;
  const canvas = renderer.getDrawingBufferSize(_refrCanvasSize);
  refrScreen.value.set(canvas.x, canvas.y);
  const cam = camera as THREE.PerspectiveCamera;
  refrProjInv.value.copy(cam.projectionMatrix).invert();
  refrViewInv.value.copy(cam.matrixWorld);
  refrCamPos.value.setFromMatrixPosition(cam.matrixWorld);
}

const _waterFrustum = new THREE.Frustum();
const _waterProjScreen = new THREE.Matrix4();
const _visibleHeights = new Set<number>();

/**
 * 视锥里出现了哪些水面高度（镜面网格的世界包围球 vs 相机视锥）。
 *
 * 用途：折射/深度/镜面都是**整场景** pass。水面高度可以有多层（surf_666 有 5 层），
 * 而 `mirrorPlanes` 每层每帧都要重渲一次整场景 —— 实测俯仰扫视时水最多的那一段
 * 3.3~3.5ms/帧（29 块主画面却要 5 趟整场景），是垂直扫视掉到 230fps 的主因。
 * 只渲染「真的在画面里」的那几层，看不见的层保留上一帧 RT 即可。
 *
 * 返回 `null` 表示不做门控（没有登记镜面网格时保持旧行为）。
 */
export function visibleWaterHeights(camera: THREE.Camera): Set<number> | null {
  if (mirrorMeshes.size === 0) return null;
  const cam = camera as THREE.PerspectiveCamera;
  cam.updateMatrixWorld();
  _waterProjScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  _waterFrustum.setFromProjectionMatrix(_waterProjScreen);
  _visibleHeights.clear();
  for (const [mesh, h] of mirrorMeshes) {
    if (!mesh.visible) continue;
    let box = waterBoxes.get(mesh);
    if (!box) {
      mesh.updateMatrixWorld();
      const geo = mesh.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      if (!geo.boundingBox) return null;
      box = _waterBox.copy(geo.boundingBox).applyMatrix4(mesh.matrixWorld);
    }
    if (_waterFrustum.intersectsBox(box)) _visibleHeights.add(Math.round(h * 100) / 100);
  }
  return _visibleHeights;
}

/**
 * 每帧折射/深度 RT pass 的**干净入口**（T-650 v4：移出 onBeforeRender 嵌套）。
 * 由 RenderSession.frame 在主渲染**之前**调用——嵌套在主渲染回调里执行时，
 * three 的渲染状态（排序/override/当前目标）会被外层半途状态污染，且随视角
 * 变化（owner 实测：同池不同角度时好时坏；对调两 pass 顺序则内容互换——
 * 深度编码色漏进颜色 RT，见 §12.9）。
 */
/**
 * 水下底面（`*_beneath` / `$bottommaterial` 派生）的可见性门控。
 *
 * 事实：这些面朝下（法线 −y），相机在水面上方时 three 的背面剔除让它们一个像素都不出，
 * 但**每个材质槽仍是一次 draw**（boreas：水面 160 块，每块 1 个 `_beneath` 槽 ⇒ 160 draw）。
 * 做法：按 `materialHeight`（装配时写入的该层水位）与相机 y 直接置 `visible`，与背面剔除等价。
 *
 * 只在相机**低于**该层水位 1 HU 以上时才打开（水下视角需要水底），保留原语义。
 * 材质名判据与 `beneathFogCandidates` 同源（`/beneath/i`），不引入新的分类口径。
 */
export function cullBeneathMaterials(camera: THREE.Camera): void {
  if ((g as { __vbspBeneathCull?: boolean }).__vbspBeneathCull === false) return;
  const camY = camera.position.y;
  for (const [m, h] of beneathMaterials) {
    m.visible = camY < h - 1;
  }
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
const _nearestDir = new THREE.Vector3();
function nearestWaterHeight(camera: THREE.Camera): number | null {
  camera.getWorldDirection(_nearestDir);
  const camY = camera.position.y;
  let below: number | null = null;
  let belowD = Infinity;
  let above: number | null = null;
  let aboveD = Infinity;
  let any: number | null = null;
  let anyD = Infinity;
  for (const [mesh, h] of mirrorMeshes) {
    if (!mesh.visible) continue;
    const d = Math.abs(camY - h);
    if (d < anyD) { anyD = d; any = h; }
    if (h <= camY + 0.001) {
      const dh = camY - h;
      if (dh < belowD) { belowD = dh; below = h; }
    } else {
      const dh = h - camY;
      if (dh < aboveD) { aboveD = dh; above = h; }
    }
  }
  // 诊断 A/B：复现旧口径（纯 |camY-h|），验证“选错层”假设；默认不走。
  if ((g as { __vbspWaterLegacyNearest?: unknown }).__vbspWaterLegacyNearest === true) return any;
  if (_nearestDir.y < -0.05) return below ?? above ?? any;
  if (_nearestDir.y > 0.05) return above ?? below ?? any;
  return any;
}

/** 换图/卸载：释放每层镜像 RT 与本地登记，避免旧图水材质/平面表污染新图。 */
/** 水面统计（诊断用）：登记了多少材质/镜面层、各层高度、各层包围球（世界坐标）。 */
export function waterStats(): {
  materials: number;
  mirrors: number;
  heights: number[];
  spheres: Array<{ h: number; c: [number, number, number]; r: number }>;
  /** 材质去重现状：同名/同贴图/同色/同渲染态的水面材质有几个实例（诊断 draw 数用）。 */
  keys: Array<[string, number]>;
} {
  // 水面 draw ≈ 每个水面材质实例 × 每个几何组一次 ⇒ 材质实例数是 draw 数的下限。
  // 这里把每个实例按「名字|贴图|颜色|side|alphaTest|opacity」归并，直接看出能不能共享。
  const keyCount = new Map<string, number>();
  for (const m of waterMaterials) {
    const map = (m as unknown as { map?: THREE.Texture | null }).map;
    const k = [
      m.name || '(anon)',
      map ? map.uuid.slice(0, 6) : '-',
      m.color.getHexString(),
      String(m.side),
      String(m.alphaTest),
      String(m.opacity),
    ].join('|');
    keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
  }
  const keys = [...keyCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const heights = [...new Set([...mirrorMeshes.values()])].sort((a, b) => a - b);
  const spheres: Array<{ h: number; c: [number, number, number]; r: number }> = [];
  for (const [mesh, h] of mirrorMeshes) {
    const g = mesh.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    const bs = g.boundingSphere;
    if (!bs) continue;
    const c = bs.center.clone().applyMatrix4(mesh.matrixWorld);
    spheres.push({ h, c: [c.x, c.y, c.z], r: bs.radius });
  }
  return { materials: waterMaterials.size, mirrors: mirrorMeshes.size, heights, spheres, keys };
}

/** 给水面 mesh 挂 `onBeforeRender`：按这块 mesh 自己的高度渲染/绑定对应层的镜像 RT。 */
function attachMirrorDriver(mesh: THREE.Mesh, height: number): void {
  mirrorMeshes.set(mesh, height);
  const plane = mirrorPlaneOf(height);
  const prev = mesh.onBeforeRender;
  // 签名固定 6 参（three 的 `Object3D.onBeforeRender`）；转发时逐个透传
  mesh.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
    if (typeof prev === 'function') prev.call(mesh, renderer, scene, camera, geometry, material, group);
    if (mirrorRendering || refrRendering) return;
    // T-650 v4：镜面 RT 的渲染已移至 renderWaterFramePasses（主渲染前干净上下文）；
    // 这里只剩**每块网格的 uniform 绑定**（用本块高度的镜面纹理/矩阵，draw 前赋值即可）。
    mirrorUniform.value = plane.texture;
    textureMatrix.copy(plane.matrix);
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

/** 水面唯一的动态：由渲染主循环每帧同步推进 `AnimatedTexture`（不再另起独立 rAF 循环抢时间片）。 */
export function advanceWaterAnimation(): void {
  const pin = typeof g.__vbspWaterTimePin === 'number'
    ? (g.__vbspWaterTimePin as number)
    : g.__vbspWaterTimePin === true ? 0 : null;
  const frozen = typeof g.__vbspWaterTime === 'number' ? (g.__vbspWaterTime as number) : null;
  if (frozen !== null) return;
  const t = pin !== null ? pin : (typeof performance !== 'undefined' ? performance.now() / 1000 : 0);
  timeUniform.value = t;
  frameUniform.value = t;
  const n = dudvFrameCount;
  const rate = frameRateOf();
  if (n > 1 && rate > 0) {
    const phase = t * rate;
    const i = Math.floor(phase) % n;
    dudvFrameA.value = i / n;
    dudvFrameB.value = ((i + 1) % n) / n;
    dudvFrameMix.value = Math.min(1, Math.max(0, phase - Math.floor(phase)));
  } else {
    dudvFrameA.value = 0;
    dudvFrameB.value = 0;
    dudvFrameMix.value = 0;
  }
  dbg.time = t;
  dbg.frames = n;
  dbg.frameIndex = n > 1 && rate > 0 ? Math.floor(t * rate) % n : 0;
  (globalThis as { __vbspWaterDebug?: unknown }).__vbspWaterDebug = dbg;
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
  // 水体色不能一律用 `$fogcolor`：666 的 `$fogcolor` 是暗棕 (22,20,10)，用它当基色能压住
  // 亮地板；boreas 的 `$fogcolor` 是亮蓝，直接当基色 + 常量 tint 会把“按深度 fog、表层透明、
  // 近岸过渡”整片染蓝。按解析值分开：
  //   · 暗色 fog（峰值 < 0.3）⇒ 用 fog 作基色，tint 0.3、alpha 下限 0.2；
  //   · 亮色/蓝色 fog ⇒ 保留原来的青色基色，tint 0，alpha 走深度/岸边公式（无下限）。
  const fogPeak = Math.max(fog.r, fog.g, fog.b);
  const darkFog = Array.isArray(w.fog) && w.fog.length >= 3 && fogPeak < 0.3;
  if (w.waterThickness !== undefined) {
    const list = ((globalThis as { __vbspWaterVolumeThickness?: unknown[] }).__vbspWaterVolumeThickness ??= []);
    list.push({ name: material.name, thickness: w.waterThickness });
  }
  const baseColor = darkFog ? fog.clone().convertSRGBToLinear() : new THREE.Color(0.12, 0.52, 0.72);
  const tintDefault = darkFog ? 0.04 : 0;
  const alphaFloorDefault = darkFog ? 0.05 : 0;
  // 亮色 fog（boreas）保留原来的反射强度/深度 gate；暗色 fog（666）适度压低泛白与反射强度，水下更通透。
  const reflectDefault = darkFog ? 0.14 : 0.12;
  const depthGateDefault = darkFog ? 0 : 1;
  material.color.copy(baseColor);
  // 调试：覆盖基色（isolate 判断波纹形状时用明显颜色）
  const colorOverride = g.__vbspWaterColor;
  if (Array.isArray(colorOverride) && colorOverride.length >= 3) {
    material.color.fromArray(colorOverride as [number, number, number]);
  }
  const shadeStrength = shadeStrengthOf();

  // ── T-650 v2 五规则参数（全部挂**亮雾流**：暗雾流取中性值 = 行为不变，保护清单 §3.1）──
  // R2 折射内容提亮：乘性、只作用于已有内容（禁常量色叠加 = 已否决的「保底上色」的边界）。
  const lift = darkFog ? 1.0 : Math.max(1, num(g.__vbspWaterLift, 1.35));
  // R3 掠射采样稳定：位移 × att，视线越接近水平越收紧（只动采样坐标，不补偿任何观感量）。
  const grazAtt = darkFog ? 1.0 : Math.min(1, Math.max(0, num(g.__vbspWaterGrazAtt, 0.35)));
  // R4 反射限幅：混合权重 clamp 上限；暗雾流收紧到 0.18 避免浅水反白，亮雾流保持 0.25。
  const reflCap = darkFog
    ? Math.min(1, Math.max(0, num(g.__vbspWaterReflCap, 0.18)))
    : Math.min(1, Math.max(0, num(g.__vbspWaterReflCap, 0.25)));
  // R5 真·打空像素：只在亮雾流启用；回落色缺省 = 本材质 fog 线性值 ×0.25，
  // 装配完成后按「最近下方 beneath 材质的 $fogcolor 原值（按线性使用）」回填。
  const r5on = darkFog ? 0 : 1;
  const fogLin0 = fog.clone().convertSRGBToLinear();
  const beneathFogHolder = { value: new THREE.Vector3(fogLin0.r * 0.25, fogLin0.g * 0.25, fogLin0.b * 0.25) };
  beneathFogHolders.set(material, beneathFogHolder);

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
      value: Math.min(1, Math.max(0, num(g.__vbspWaterReflectStrength, reflectDefault))),
    };
    // 诊断：`__vbspWaterDepthGateOff` ⇒ 不再按“水浅”把 Fresnel 归零；用于确认
    // 浅水/模型容器里“没有反射”是不是 depth gate 造成的。
    // 默认关闭浅水 Fresnel gate：666 模型容器的水只有几 HU 深，gate 会把反射直接乘成 0
    // （owner 2026-10-24 报“水倒影消失”）；`__vbspWaterDepthGate=1` 可复现旧口径。
    shader.uniforms.vbspWaterDepthGate = {
      value: g.__vbspWaterDepthGateOff === true
        ? 0
        : Math.max(0, Math.min(1, num(g.__vbspWaterDepthGate, depthGateDefault))),
    };
    // 暗色 fog（666）：浅水 alpha 下限 0.05、上限 0.50，且启用 RT γ2.2 解码消除二次编码泛白；
    // 亮色 fog（boreas）：下限 0、上限 1.0、RT 不解码，保持原深度泛蓝观感。
    shader.uniforms.vbspWaterAlphaFloor = {
      value: Math.max(0, Math.min(1, num(g.__vbspWaterAlphaFloor, alphaFloorDefault))),
    };
    shader.uniforms.vbspWaterAlphaCap = {
      value: Math.min(1, Math.max(0.05, num(g.__vbspWaterAlphaCap, darkFog ? 0.50 : 1.0))),
    };
    shader.uniforms.vbspWaterRtDecode = {
      value: num(g.__vbspWaterRtDecode, darkFog ? 1 : 0),
    };
    // 水体色（最终往它收敛）+ 收敛强度
    shader.uniforms.vbspWaterBaseColor = { value: new THREE.Vector3(baseColor.r, baseColor.g, baseColor.b) };
    shader.uniforms.vbspWaterTintStrength = {
      value: Math.min(1, Math.max(0, num(g.__vbspWaterTint, tintDefault))),
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
  shader.uniforms.vbspWaterDepthTex = depthTexUniform;
  shader.uniforms.vbspWaterDepthTexOn = depthTexOn;
  shader.uniforms.vbspWaterProjInv = refrProjInv;
    shader.uniforms.vbspWaterDepthRange = { value: DEPTH_RANGE };
    // 用深度 pass 的真实"到地形距离"当水厚（**缺省开**：目标要的是"水底离水面多远"）。
    // 想退回常数膜厚模型：`__vbspWaterUseDepthPass=false`。
    shader.uniforms.vbspWaterUseDepthPass = { value: g.__vbspWaterUseDepthPass === false ? 0 : 1 };
    // 「水底太蓝了，浅一些」：fogMix 上限 + 中段软化曲线。
    // R1（T-650 v2）：雾罩封顶挂亮雾流 —— 亮雾流 0.30（boreas 不变）；暗雾流压至 0.18 减轻灰白浑浊。
    shader.uniforms.vbspWaterFogMax = {
      value: Math.min(1, Math.max(0, num(g.__vbspWaterFogMax, darkFog ? 0.18 : 0.30))),
    };
    // 「稍微白点、近似透明」：水色下限（tp-more 用的是 0）
    shader.uniforms.vbspWaterFogFloor = {
      value: Math.min(1, Math.max(0, num(g.__vbspWaterFogFloor, 0.0))),
    };
    shader.uniforms.vbspWaterFogCurve = { value: Math.max(0.2, num(g.__vbspWaterFogCurve, 1.35)) };
    // tp-more 那档：折射内容亮度上限 0.78
    shader.uniforms.vbspWaterContentMax = { value: Math.max(0.05, num(g.__vbspWaterContentMax, 0.78)) };
    // 岸边透明带：宽度（世界单位，竖直深度口径）与"岸边反射可见度"。
    // 亮雾流 60（owner 2026-10-25 从 w40/60/80 条带选 60：「60的看起来还不错」——比 40 宽 50%，
    // 岸线过渡更缓）；暗雾流保持 40（666 观感刚过 owner 门，零回归；同 FogMax 的分流先例）。
    shader.uniforms.vbspWaterShoreWidth = {
      value: Math.max(1, num(g.__vbspWaterShoreWidth, darkFog ? 40 : 60)),
    };
    shader.uniforms.vbspWaterShoreRefl = { value: Math.min(1, Math.max(0, num(g.__vbspWaterShoreRefl, 1.0))) };
    // 近处近乎透明（看得清水底）、远处带蓝且更不透（"水底形如蓝天"）
    shader.uniforms.vbspWaterNearAlpha = { value: Math.min(1, Math.max(0, num(g.__vbspWaterNearAlpha, 0.15))) };
    shader.uniforms.vbspWaterFarAlpha = { value: Math.min(1, Math.max(0, num(g.__vbspWaterFarAlpha, 0.97))) };
    // 蓝调/透明度渐变的距离区间（世界单位）：近处几乎全透，800 单位外完全"蓝天"
    shader.uniforms.vbspWaterBlueStart = { value: Math.max(0, num(g.__vbspWaterBlueStart, 60)) };
    shader.uniforms.vbspWaterBlueEnd = { value: Math.max(1, num(g.__vbspWaterBlueEnd, 800)) };
    shader.uniforms.vbspWaterReflTint = { value: new THREE.Vector3().fromArray(w.reflectTint ?? [1, 1, 1]) };
    shader.uniforms.vbspWaterReflMix = { value: Math.min(1, Math.max(0, num(w.reflectAmount, 0.8))) };
    // T-650 v4 W-A：深水像素合成（A0 触发集：有效且 depthV≥阈值）；暗雾流恒 0 ⇒ 666 零改动。
    shader.uniforms.vbspWaterVoidMode = {
      value: darkFog ? 0 : Math.min(3, Math.max(0, Math.round(num(g.__vbspWaterVoidMode, 0)))),
    };
    shader.uniforms.vbspWaterDeepV = { value: Math.min(1, Math.max(0, num(g.__vbspWaterDeepV, 0.5))) };
    // T-650 v4 W-A2：暗内容曝光倍率（1=现状；>1 越暗提越多，黑区岩壁显露）。
    shader.uniforms.vbspWaterContentLift = { value: Math.max(1, num(g.__vbspWaterContentLift, 1)) };    // 涟漪滚动速率：优先地图自带的 `$scroll1`/`$scroll2`
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
    // T-650 v2 五规则 uniforms（参数的亮/暗雾流分流见 onBeforeCompile 之前的同步段）。
    shader.uniforms.vbspWaterLift = { value: lift };
    shader.uniforms.vbspWaterGrazAtt = { value: grazAtt };
    shader.uniforms.vbspWaterReflCap = { value: reflCap };
    shader.uniforms.vbspWaterBeneathFog = beneathFogHolder;
    shader.uniforms.vbspWaterR5On = { value: r5on };

    // ── 顶点：自带 uv / 视空间法线与视线 / 视距 / 镜像 UV ──
    //
    // 全部自算，不用 three 的 `vViewPosition` / `vNormal`：`meshbasic_frag` 里前者只在
    // USE_ENVMAP 时才声明、后者在 FLAT_SHADED 时不存在，而水面的 envMap 是**晚到**的
    // （首次编译时常为空）⇒ 依赖它们会直接编译失败（实测 `'vViewPosition' : undeclared identifier`）。
    shader.vertexShader =
      WATER_VERTEX_HEADER +
      shader.vertexShader.replace('#include <project_vertex>', WATER_VERTEX_PROJECT);

    // ── 片元：涟漪 + 雾色（接在 albedo 之后） ──
    let frag = shader.fragmentShader.replace(
      '#include <common>',
      '#include <common>\n#include <packing>\n' + WATER_RIPPLE_BLOCK,
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
    frag = frag.replace('#include <envmap_fragment>', WATER_RIPPLE_INJECT + '\n' + WATER_ENV_BLOCK);
    // 涟漪/扭曲取样点与反射块在同一个作用域（`vbspSlope` 等定义在上面那段注入里）
    // 涟漪/折射（`rippleInject`）+ 反射（`envBlock`）**一起**插在 envmap 锚点处：
    // 前者必须先执行（它算 `vbspSlope` / `vbspRefrColor` / alpha），后者用到那些变量。

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
  (globalThis as { __vbspWaterStats?: unknown }).__vbspWaterStats = waterStats;
  advanceWaterAnimation();
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
    if (!mats.some((m) => readWater(m))) {
      if (mats.some((m) => m && m.transparent === true) && mesh.geometry) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        if (mesh.geometry.boundingBox) {
          mesh.updateMatrixWorld();
          _waterBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
          aboveRefrCandidates.push({ mesh, minY: _waterBox.min.y });
        }
      }
      return;
    }
    {
      const geom = mesh.geometry;
      if (!geom.boundingSphere) geom.computeBoundingSphere();
      if (!geom.boundingBox) geom.computeBoundingBox();
      if (geom.boundingBox) {
        waterMeshes.set(mesh, geom.boundingBox.max.y);
        mesh.updateMatrixWorld();
        waterBoxes.set(mesh, geom.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
      }
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
      for (const mm of mats) {
        if (readWater(mm)) {
          materialHeight.set(mm, h);
          if (/beneath/i.test(mm.name)) beneathMaterials.set(mm as THREE.MeshBasicMaterial, h);
        }
      }
      // R5（T-650 v2）：登记 `*_beneath`（$bottommaterial 派生底面）材质的 $fogcolor 原值候选，
      // 供装配后按「最近下方」给亮雾流水面配对回落色。
      for (const mm of mats) {
        const wb = readWater(mm);
        if (wb && /beneath/i.test(mm.name) && Array.isArray(wb.fog) && wb.fog.length >= 3 && beneathFogCandidates.length < 8) {
          beneathFogCandidates.push({ y: h, fog: new THREE.Color(wb.fog[0], wb.fog[1], wb.fog[2]) });
        }
      }
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
    lowestWaterHeight = Math.round(planeHeights[0] * 100) / 100;
    // 竖直深度的归一化范围：用**相邻水层的最小合理间隔**（就是这张图的池深）。
    // 例 surf_666 升序 -16064 / -11968 / -11071 / 15296 / 15312 ⇒ 897 被选中（池深）。
    // 单层薄膜（如 boreas，只有 y=197）⇒ 无间隔，落回缺省值。
    depthScaleUniform.value = planeDepthRange(planeHeights, depthScaleOf());
    console.info(`[water] 水面高度表（世界 y，升序）：${planeHeights.join(' / ')}`);
  }
  // R5（T-650 v2）：给每个亮雾流水面材质回填「最近下方」beneath 材质的 $fogcolor 原值
  // （按线性使用，实测样例 (10,39,67)）；没有 beneath 材质的图保持缺省（本材质 fog×0.25）。
  for (const [material, holder] of beneathFogHolders) {
    const h = materialHeight.get(material);
    const below = beneathFogCandidates
      .filter((c) => h === undefined || c.y <= h + 1.5)
      .sort((a, b) => b.y - a.y)[0];
    if (below) holder.value.set(below.fog.r, below.fog.g, below.fog.b);
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
    (globalThis as { __vbspWaterShoreField?: unknown }).__vbspWaterShoreField =
      buildShoreDistanceProbe(beneathInfo);
  }
  return injected;
}

/**
 * 数据探针：按水层把水块 XZ 矩形栅格化，再用 BFS 算“水内到边界”的距离。
 * 只暴露统计，不接 shader；验证边界/距离场是否值得作为 foam/shore 的数据源。
 */
function buildShoreDistanceProbe(rects: { y: number; xMin: number; xMax: number; zMin: number; zMax: number }[]) {
  const cell = 128;
  const byLayer = new Map<number, typeof rects>();
  for (const r of rects) {
    if (!(r.xMax > r.xMin && r.zMax > r.zMin)) continue;
    const key = Math.round(r.y);
    const list = byLayer.get(key) ?? [];
    list.push(r);
    byLayer.set(key, list);
  }
  const layers: unknown[] = [];
  for (const [y, list] of byLayer) {
    const minX = Math.min(...list.map((r) => r.xMin));
    const maxX = Math.max(...list.map((r) => r.xMax));
    const minZ = Math.min(...list.map((r) => r.zMin));
    const maxZ = Math.max(...list.map((r) => r.zMax));
    const w = Math.max(1, Math.ceil((maxX - minX) / cell));
    const h = Math.max(1, Math.ceil((maxZ - minZ) / cell));
    const inside = new Uint8Array(w * h);
    for (const r of list) {
      const x0 = Math.max(0, Math.floor((r.xMin - minX) / cell));
      const x1 = Math.min(w - 1, Math.floor((r.xMax - minX) / cell));
      const z0 = Math.max(0, Math.floor((r.zMin - minZ) / cell));
      const z1 = Math.min(h - 1, Math.floor((r.zMax - minZ) / cell));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) inside[z * w + x] = 1;
    }
    // 边界水格 dist=0，向水内 BFS；非水格不参与。
    const dist = new Int32Array(w * h).fill(-1);
    const queue: number[] = [];
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const i = z * w + x;
        if (!inside[i]) continue;
        if (x === 0 || z === 0 || x === w - 1 || z === h - 1 ||
            !inside[i - 1] || !inside[i + 1] || !inside[i - w] || !inside[i + w]) {
          dist[i] = 0;
          queue.push(i);
        }
      }
    }
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      const x = i % w;
      const z = (i / w) | 0;
      const next = dist[i] + 1;
      if (x > 0 && inside[i - 1] && dist[i - 1] < 0) { dist[i - 1] = next; queue.push(i - 1); }
      if (x + 1 < w && inside[i + 1] && dist[i + 1] < 0) { dist[i + 1] = next; queue.push(i + 1); }
      if (z > 0 && inside[i - w] && dist[i - w] < 0) { dist[i - w] = next; queue.push(i - w); }
      if (z + 1 < h && inside[i + w] && dist[i + w] < 0) { dist[i + w] = next; queue.push(i + w); }
    }
    let waterCells = 0;
    let boundaryCells = 0;
    let maxCells = 0;
    let sum = 0;
    for (let i = 0; i < inside.length; i++) {
      if (!inside[i]) continue;
      waterCells++;
      if (dist[i] === 0) boundaryCells++;
      if (dist[i] > maxCells) maxCells = dist[i];
      if (dist[i] > 0) sum += dist[i];
    }
    layers.push({
      y,
      cell,
      width: w,
      height: h,
      waterCells,
      boundaryCells,
      maxDistance: maxCells * cell,
      meanDistance: waterCells > boundaryCells ? (sum / Math.max(1, waterCells - boundaryCells)) * cell : 0,
      bounds: [minX, minZ, maxX, maxZ],
    });
  }
  return { layers };
}

/** 当前是否已有折射颜色 RT（门面用它做「首帧必渲」判断，替代直接读 refrRT）。 */
export function hasRefractionTarget(): boolean {
  return refrRT !== null;
}

/** 换图/卸载：清空材质登记、释放折射/深度 RT、复位折射相关 uniform 与 pass 标志。 */
export function resetRefractionState(): void {
  waterMaterials.clear();
  waterMeshes.clear();
  waterBoxes.clear();
  beneathMaterials.clear();
  aboveRefrCandidates.length = 0;
  lowestWaterHeight = null;
  materialHeight.clear();
  materialDepth.clear();
  beneathFogHolders.clear();
  beneathFogCandidates.length = 0;
  refrRT?.dispose();
  depthRT?.dispose();
  refrRT = null;
  depthRT = null;
  refrDepthTexMode = null;
  depthTexUniform.value = null;
  depthTexOn.value = 1;
  refrUniform.value = null;
  sceneDistUniform.value = null;
  refrRendering = false;
}
