/**
 * 空白预览页的「符文盘 + 加色烟幕」两层（与地图数据无关的近似复刻）。
 *
 * 依据 `.tmp/pcf/RUNE_SPEC.md`：
 * - 符文盘在地图里是 5 个 brush 模型（内盘 r≈346/z=756.6 + 外环 350→571.5/z=788.6 + 3 个小符块），
 *   材质 `end_wiccan.vmt` = UnlitGeneric（fullbright）+ `$translucent` ⇒ alpha 混合，实体 rendercolor
 *   `201 168 255`。贴图 alpha 是白线魔法阵；盘心 UV 落在平铺图案的 (0.9985, 0.8937) 处，
 *   1 个贴图 tile ≈ 1146.7 HU，盘径 1143 HU ≈ 1 tile。
 * - 烟柱在地图里是世界面 `TENDIES_ENDSMOKE`（8 个竖直面，bbox [9496,11880,368 → 10080,12552,3866]，
 *   即相对粒子 origin(9744,12176,725.312) 的 y ∈ [-357, 3141]、宽约 584×672），材质
 *   `tendies_endsmoke.vmt` = UnlitGeneric + `$additive 1` + `$vertexcolor/$vertexalpha` +
 *   `TextureScroll rate 0.25`（贴图 V 向滚动）。
 *
 * 空白预览里没有 brush 几何，所以：
 * - 符文盘用 `.tmp/pcf/rune_disc_bake.png`（按盘面世界平面 UV 烘好的白 RGB + alpha，覆盖盘心 ±600 HU）
 *   切成「内盘 CircleGeometry(346) + 外环 RingGeometry(350, 571.5)」两层，逐顶点重写 UV 采样同一张 bake；
 *   加法混合 + 紫色 tint（rendercolor 201 168 255），外加两层程序化径向光晕补「底部辉光」。
 *   地图里按钮其实静止（logic_auto 只 SetPosition 一圈 3600°），这里给 ±1.5~2.5°/s 的慢转作为预览加戏。
 * - 烟幕用 2 个交叉竖直平面（宽 560、高 3498、加色、opacity 0.5），贴图是 `tendies_smoke.vtf`
 *   解出的白 RGB + alpha（加法下贡献 = 白 × alpha，紫色 tint 交给材质 color），UV 每帧 V 向滚动 0.25/s。
 */

import * as THREE from 'three';

export interface PreviewExtrasOptions {
  /** 柱子底部基准点（预览里 = 粒子系统 origin）。默认 [0, 0, 0]。 */
  origin?: [number, number, number];
  rune?: {
    /** 紫色 tint（地图 rendercolor 201 168 255）。 */
    tint?: number;
    /** 图层不透明度（加法混合下相当于亮度系数）。 */
    opacity?: number;
    /** 外环自转速度（度/秒，正 = 逆时针俯视）。默认 +1.5。 */
    outerSpin?: number;
    /** 内盘自转速度（度/秒）。默认 -2.4。 */
    innerSpin?: number;
    /** 是否渲染贴地辉光层。默认 true。 */
    glow?: boolean;
  };
  smoke?: {
    tint?: number;
    opacity?: number;
    /** 贴图 V 向滚动速率（贴图/秒，地图 TextureScroll 0.25）。默认 0.25。 */
    scrollRate?: number;
    width?: number;
    height?: number;
    /** 平面中心相对 origin 的 y（地图 bbox 368..3866 的中点 1392）。默认 1392。 */
    centerY?: number;
  };
}

export interface PreviewExtras {
  /** 挂到 scene 上即可。 */
  root: THREE.Group;
  /** 每帧推进（旋转 + 贴图滚动 + 光晕呼吸）。 */
  update(dt: number): void;
  /** 整层显隐（截图/调试用）。 */
  setVisible(visible: boolean): void;
  rune: {
    group: THREE.Group;
    inner: THREE.Mesh;
    outer: THREE.Mesh;
    glowOuter: THREE.Mesh;
    glowCore: THREE.Mesh;
    texture: THREE.Texture | null;
  };
  smoke: {
    group: THREE.Group;
    planes: THREE.Mesh[];
    texture: THREE.Texture | null;
  };
}

const RUNE_TEXTURE_URL = '/web/preview-assets/end_wiccan.png';
const SMOKE_TEXTURE_URL = '/web/preview-assets/tendies_smoke.png';

/** `rune_disc_bake.png` 覆盖以盘心为原点的 ±600 HU 窗口（RUNE_SPEC §5.1）。 */
const RUNE_BAKE_HALF_HU = 600;

const RUNE_INNER_RADIUS = 346;
const RUNE_OUTER_RADIUS_INNER = 350;
const RUNE_OUTER_RADIUS_OUTER = 571.5;
const RUNE_INNER_Y = 0.6;
const RUNE_OUTER_Y = 0.9;

/**
 * 把平面的局部 HU 坐标映射到 bake 贴图 UV：
 * bake 是「以盘心为原点、世界 X 向右、世界 Y 向下」的窗口，覆盖 ±600 HU；
 * three 默认 flipY=true（图片第 0 行在 v=1），所以：
 *   u = 0.5 - localY / 1200（世界 +Y 在图片里往下）
 *   v = 0.5 + localX / 1200
 * 见 RUNE_SPEC §5.1；若以后把 bake 的 flipY 关掉，只需把 v 改成 0.5 - localX / 1200。
 */
function remapRuneUv(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const uv = new THREE.Float32BufferAttribute(position.count * 2, 2);
  const span = RUNE_BAKE_HALF_HU * 2;
  for (let i = 0; i < position.count; i++) {
    uv.setXY(i, 0.5 - position.getY(i) / span, 0.5 + position.getX(i) / span);
  }
  geometry.setAttribute('uv', uv);
}

/** 圆形径向渐变贴图（用于贴地辉光；紫色 tint 在材质里给）。 */
function createRadialGlowTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  const c = size / 2;
  const gradient = ctx.createRadialGradient(c, c, 0, c, c, c);
  gradient.addColorStop(0, 'rgba(255,255,255,1.0)');
  gradient.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  gradient.addColorStop(0.55, 'rgba(255,255,255,0.18)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 0..1 区间的 smoothstep；edge0 > edge1 时得到反向斜坡（用于边缘羽化）。 */
function smoothstep01(x: number, edge0: number, edge1: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function loadTexture(
  url: string,
  onReady: (texture: THREE.Texture) => void,
  setup?: (texture: THREE.Texture) => void,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(
    url,
    () => onReady(texture),
    undefined,
    (error) => console.error('[preview-extras] texture load failed:', url, error),
  );
  texture.colorSpace = THREE.SRGBColorSpace;
  setup?.(texture);
  return texture;
}

export function createPreviewExtras(options: PreviewExtrasOptions = {}): PreviewExtras {
  const origin = new THREE.Vector3(...(options.origin ?? [0, 0, 0]));

  const runeOptions = {
    tint: options.rune?.tint ?? 0xc9a8ff,
    opacity: options.rune?.opacity ?? 0.9,
    outerSpin: options.rune?.outerSpin ?? 1.5,
    innerSpin: options.rune?.innerSpin ?? -2.4,
    glow: options.rune?.glow ?? true,
  };
  const smokeOptions = {
    tint: options.smoke?.tint ?? 0xd6caff,
    opacity: options.smoke?.opacity ?? 0.45,
    scrollRate: options.smoke?.scrollRate ?? 0.25,
    width: options.smoke?.width ?? 560,
    height: options.smoke?.height ?? 3498,
    centerY: options.smoke?.centerY ?? 1392,
  };

  const root = new THREE.Group();
  root.name = 'preview-extras';
  root.position.copy(origin);

  // ---------------- 符文盘 ----------------
  const runeGroup = new THREE.Group();
  runeGroup.name = 'rune-disc';

  const runeTexture = loadTexture(RUNE_TEXTURE_URL, () => {
    innerMaterial.opacity = runeOptions.opacity * 0.85;
    outerMaterial.opacity = runeOptions.opacity;
  });

  const makeRuneMaterial = (opacity: number): THREE.MeshBasicMaterial =>
    new THREE.MeshBasicMaterial({
      map: runeTexture,
      color: runeOptions.tint,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });

  const innerMaterial = makeRuneMaterial(runeOptions.opacity * 0.85);
  const outerMaterial = makeRuneMaterial(runeOptions.opacity);

  const innerGeometry = new THREE.CircleGeometry(RUNE_INNER_RADIUS, 96);
  remapRuneUv(innerGeometry);
  innerGeometry.rotateX(-Math.PI / 2); // 局部 +Z 法线 → 世界 +Y，局部 X/Y 平面 → 世界 X/Z 平面
  const inner = new THREE.Mesh(innerGeometry, innerMaterial);
  inner.name = 'rune-inner';
  inner.position.y = RUNE_INNER_Y;
  runeGroup.add(inner);

  const outerGeometry = new THREE.RingGeometry(RUNE_OUTER_RADIUS_INNER, RUNE_OUTER_RADIUS_OUTER, 128, 1);
  remapRuneUv(outerGeometry);
  outerGeometry.rotateX(-Math.PI / 2);
  const outer = new THREE.Mesh(outerGeometry, outerMaterial);
  outer.name = 'rune-outer';
  outer.position.y = RUNE_OUTER_Y;
  runeGroup.add(outer);

  // 贴地辉光：程序化径向渐变，模拟地图里盘面周围被紫色灯光照亮的底部光晕。
  const glowTexture = createRadialGlowTexture();
  const glowOuter = new THREE.Mesh(
    new THREE.CircleGeometry(980, 64),
    new THREE.MeshBasicMaterial({
      map: glowTexture,
      color: 0x9a6bff,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    }),
  );
  glowOuter.name = 'rune-glow-outer';
  glowOuter.rotation.x = -Math.PI / 2;
  glowOuter.position.y = 1.2;

  const glowCore = new THREE.Mesh(
    new THREE.CircleGeometry(340, 64),
    new THREE.MeshBasicMaterial({
      map: glowTexture,
      color: 0xc3a2ff,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    }),
  );
  glowCore.name = 'rune-glow-core';
  glowCore.rotation.x = -Math.PI / 2;
  glowCore.position.y = 1.6;

  if (runeOptions.glow) {
    runeGroup.add(glowOuter, glowCore);
  }
  root.add(runeGroup);

  // ---------------- 加色烟幕 ----------------
  const smokeGroup = new THREE.Group();
  smokeGroup.name = 'smoke-column';

  const smokeMaps: THREE.Texture[] = [];
  const smokePlanes: THREE.Mesh[] = [];
  const smokeTexture = new THREE.TextureLoader().load(
    SMOKE_TEXTURE_URL,
    () => {
      for (let i = 0; i < smokePlanes.length; i++) {
        const plane = smokePlanes[i];
        const material = plane.material as THREE.MeshBasicMaterial;
        const texture = i === 0 ? smokeTexture : smokeTexture.clone();
        if (i > 0) {
          // 第二片用克隆贴图：重复率/初相不同，配合同向但更慢的滚动，减少两片完全同相的「条带感」。
          texture.needsUpdate = true;
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.repeat.set(1.0, 1.1);
          texture.offset.set(0, 0.36);
        }
        material.map = texture;
        material.opacity = smokeOptions.opacity;
        material.needsUpdate = true;
        smokeMaps.push(texture);
      }
    },
    undefined,
    (error) => console.error('[preview-extras] smoke texture load failed:', error),
  );
  smokeTexture.colorSpace = THREE.SRGBColorSpace;
  smokeTexture.wrapS = THREE.RepeatWrapping;
  smokeTexture.wrapT = THREE.RepeatWrapping;
  // 竖直方向约 1.6 个贴图周期（贴图已做成 V 向无缝的云团 tile，滚动起来是连续上升的烟幕）。
  // 周期太少会看出重复的云团块，太多则像「层叠横带」；1.6 是两者折中。
  smokeTexture.repeat.set(1.0, 1.6);

  /**
   * 烟幕面片：常规 UV（第二片沿 U 错开）+ RGBA 顶点色做四周羽化（alpha=0 的边看不见硬边）。
   * 贴图 alpha 由 MeshBasicMaterial 的 map.a 提供，顶点色 alpha 再乘一次 ⇒ 加法混合下
   * 贡献 = color × map.rgb × map.a × opacity × vertexAlpha。
   */
  const makeSmokeGeometry = (uShift: number): THREE.PlaneGeometry => {
    const geometry = new THREE.PlaneGeometry(smokeOptions.width, smokeOptions.height, 24, 8);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
    const color = new THREE.Float32BufferAttribute(position.count * 4, 4);
    for (let i = 0; i < position.count; i++) {
      const u = position.getX(i) / smokeOptions.width + 0.5;
      const v = position.getY(i) / smokeOptions.height + 0.5;
      const fadeX = smoothstep01(u, 0, 0.14) * (1 - smoothstep01(u, 0.86, 1));
      const fadeY = smoothstep01(v, 0, 0.06) * (1 - smoothstep01(v, 0.9, 1));
      color.setXYZW(i, 1, 1, 1, fadeX * fadeY);
      uv.setXY(i, uv.getX(i) + uShift, uv.getY(i));
    }
    geometry.setAttribute('uv', uv);
    geometry.setAttribute('color', color);
    return geometry;
  };

  for (let i = 0; i < 2; i++) {
    const material = new THREE.MeshBasicMaterial({
      map: smokeTexture,
      color: smokeOptions.tint,
      transparent: true,
      // 贴图加载完成前保持不可见，避免空贴图时渲染成两个纯色加法矩形（加载回调里再设为 smokeOptions.opacity）。
      opacity: 0.001,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexColors: true,
      toneMapped: false,
      fog: false,
    });
    const plane = new THREE.Mesh(makeSmokeGeometry(i === 0 ? 0 : 0.31), material);
    plane.name = `smoke-plane-${i}`;
    plane.position.set(0, smokeOptions.centerY, 0);
    if (i === 1) plane.rotation.y = Math.PI / 2;
    smokePlanes.push(plane);
    smokeGroup.add(plane);
  }
  root.add(smokeGroup);

  // ---------------- 动画 ----------------
  const outerSpinRad = THREE.MathUtils.degToRad(runeOptions.outerSpin);
  const innerSpinRad = THREE.MathUtils.degToRad(runeOptions.innerSpin);
  let elapsed = 0;

  const update = (dt: number): void => {
    elapsed += dt;
    outer.rotation.y = elapsed * outerSpinRad;
    inner.rotation.y = elapsed * innerSpinRad;

    // TextureScroll 0.25/s：offset.y 减小 = 图案在屏幕上向上飘；第二片更慢形成视差。
    for (let i = 0; i < smokeMaps.length; i++) {
      const rate = i === 0 ? smokeOptions.scrollRate : smokeOptions.scrollRate * 0.62;
      smokeMaps[i].offset.y -= rate * dt;
    }

    if (runeOptions.glow) {
      (glowCore.material as THREE.MeshBasicMaterial).opacity = 0.2 + 0.03 * Math.sin(elapsed * 1.7);
      (glowOuter.material as THREE.MeshBasicMaterial).opacity = 0.15 + 0.02 * Math.sin(elapsed * 0.9 + 1.1);
    }
  };

  const setVisible = (visible: boolean): void => {
    root.visible = visible;
  };

  // 让内盘与外环以盘面法线（世界 +Y）为轴反向慢转；geometry 已烘平，mesh.rotation.y 即绕法线。
  return {
    root,
    update,
    setVisible,
    rune: {
      group: runeGroup,
      inner,
      outer,
      glowOuter,
      glowCore,
      texture: runeTexture,
    },
    smoke: {
      group: smokeGroup,
      planes: smokePlanes,
      texture: smokeTexture,
    },
  };
}
