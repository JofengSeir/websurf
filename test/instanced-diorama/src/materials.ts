/**
 * 程序化 PBR 材质工厂 —— 写实体素材质的物理区分（零外部资源，画布生成纹理）。
 *
 * 材质区分（参考要求）：
 * - 金属：高金属性 (metalness=1.0)、低粗糙度 → 镜面反射 + 环境反射（RoomEnvironment 影棚环境）
 * - 玻璃：透射 + 折射（MeshPhysicalMaterial transmission/ior/thickness）→ 真实透明感
 * - 木头 / 砖块：全漫反射（metalness=0）、高粗糙度 → 哑光、无镜面高光
 * - 地面：大瓷砖（grout 缝隙提供 SSAO 细节）+ 高粗糙度
 */
import * as THREE from 'three';

/** 确定性伪随机（可复现布局）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 画布 → 纹理（RepeatWrapping + sRGB + 各向异性）。 */
function canvasTexture(
  w: number,
  h: number,
  paint: (ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number) => void,
  seed = 1,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  paint(ctx, w, h, mulberry32(seed));
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** 木纹：深色底 + 纵向随机明暗年轮条纹 + 节点。 */
const woodTexture = canvasTexture(
  256, 256,
  (ctx, w, h, rng) => {
    ctx.fillStyle = '#7c4f24';
    ctx.fillRect(0, 0, w, h);
    // 年轮：纵向条纹，宽度/明暗随机
    for (let x = 0; x < w; x += 2) {
      const shade = 0.75 + rng() * 0.5;
      const v = Math.round(shade * 255);
      ctx.fillStyle = `rgb(${Math.round(v * 0.72)},${Math.round(v * 0.46)},${Math.round(v * 0.2)})`;
      ctx.fillRect(x, 0, 2, h);
    }
    // 偶尔的深色节点
    for (let i = 0; i < 5; i++) {
      const cx = rng() * w;
      const cy = rng() * h;
      const r = 4 + rng() * 10;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(30,16,6,0.9)');
      g.addColorStop(1, 'rgba(30,16,6,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
  },
  7,
);

/** 砖墙：灰浆底 + 交错砖块，每块微色调差异。 */
const brickTexture = canvasTexture(
  256, 256,
  (ctx, w, h, rng) => {
    ctx.fillStyle = '#6d6863'; // 灰浆
    ctx.fillRect(0, 0, w, h);
    const bw = 60, bh = 28; // 砖尺寸
    for (let row = 0; row * bh < h; row++) {
      const off = row % 2 === 0 ? 0 : bw / 2;
      for (let x = -bw; x < w + bw; x += bw) {
        const shade = 0.82 + rng() * 0.35;
        const r = Math.round(166 * shade), g = Math.round(96 * shade), b = Math.round(70 * shade);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        const px = x + off;
        ctx.fillRect(px + 2, row * bh + 2, bw - 4, bh - 4);
        // 轻微颗粒
        ctx.fillStyle = `rgba(0,0,0,${0.05 + rng() * 0.1})`;
        for (let i = 0; i < 6; i++) {
          ctx.fillRect(px + 2 + rng() * (bw - 8), row * bh + 2 + rng() * (bh - 8), 3, 3);
        }
      }
    }
  },
  13,
);

/** 地面大瓷砖：浅灰砖 + 深色 grout 缝（SSAO 在缝内形成真实凹槽阴影）。 */
const tileTexture = canvasTexture(
  512, 512,
  (ctx, w, h, rng) => {
    ctx.fillStyle = '#6e747c'; // grout
    ctx.fillRect(0, 0, w, h);
    const tw = 128, th = 128;
    for (let y = 0; y < h; y += th) {
      for (let x = 0; x < w; x += tw) {
        const shade = 0.82 + rng() * 0.28;
        const v = Math.round(178 * shade);
        ctx.fillStyle = `rgb(${v},${Math.round(v * 0.98)},${Math.round(v * 1.02)})`;
        ctx.fillRect(x + 4, y + 4, tw - 8, th - 8);
        // 颗粒噪点
        for (let i = 0; i < 40; i++) {
          const n = 0.06 + rng() * 0.1;
          ctx.fillStyle = `rgba(${rng() > 0.5 ? 0 : 255},${rng() > 0.5 ? 0 : 255},${rng() > 0.5 ? 0 : 255},${n})`;
          ctx.fillRect(x + 4 + rng() * (tw - 8), y + 4 + rng() * (th - 8), 2, 2);
        }
      }
    }
  },
  23,
);

/** 一组物理区分明确的 PBR 材质（全部共享，供实例化绘制复用）。 */
export interface PbrMaterials {
  /** 金属：高金属性、低粗糙度（银/金/铜实例色变化见 diorama）。 */
  metal: THREE.MeshStandardMaterial;
  /** 玻璃：透射 + 折射（transmission/ior/thickness），真实透明感。 */
  glass: THREE.MeshPhysicalMaterial;
  /** 木头：全漫反射、高粗糙度 + 木纹贴图。 */
  wood: THREE.MeshStandardMaterial;
  /** 砖块：全漫反射、高粗糙度 + 砖纹贴图。 */
  brick: THREE.MeshStandardMaterial;
  /** 地面/台面：瓷砖 + 高粗糙度，接收阴影。 */
  ground: THREE.MeshStandardMaterial;
}

export function makePbrMaterials(): PbrMaterials {
  const wood = new THREE.MeshStandardMaterial({
    map: woodTexture,
    metalness: 0.0,
    roughness: 0.9,
    envMapIntensity: 0.4,
  });
  wood.map!.repeat.set(3, 3);

  const brick = new THREE.MeshStandardMaterial({
    map: brickTexture,
    metalness: 0.0,
    roughness: 0.95,
    envMapIntensity: 0.3,
  });
  brick.map!.repeat.set(2, 2);

  const ground = new THREE.MeshStandardMaterial({
    map: tileTexture,
    metalness: 0.0,
    roughness: 0.85,
    envMapIntensity: 0.35,
  });
  ground.map!.repeat.set(12, 9);

  return {
    metal: new THREE.MeshStandardMaterial({
      color: 0xffffff, // 基色纯白：金属色完全由实例色（银/金/铜）决定，避免乘法变暗
      metalness: 1.0,
      roughness: 0.22,
      envMapIntensity: 1.2,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0.0,
      roughness: 0.05,
      transmission: 1.0, // 透射：渲染背侧场景 + 折射
      ior: 1.5, // 玻璃折射率
      thickness: 0.8, // 折射位移厚度
      attenuationColor: 0xbfe0ff, // 轻微青蓝衰减 → 玻璃质感
      attenuationDistance: 3.0,
      envMapIntensity: 1.6,
      specularIntensity: 1.0,
    }),
    wood,
    brick,
    ground,
  };
}
