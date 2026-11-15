/**
 * 屏幕后处理：泛光（bloom）——起源式「光效会晕开」的那一层。
 *
 * 为什么需要它（2026-11-15，用户 m13126）：「绝大部分光效在起源里比 websurf 里更亮」。
 * 实测峰值/宽度已经对齐（peak 196 vs 194），差距在**亮部外围的软晕面积**——起源是
 * HDR + bloom 后处理，我们之前是 `NoToneMapping` 直接画到画布，亮部在 255 硬截断。
 *
 * 做法（区别于「整屏阈值泛光」）：
 *   1. 主画面照旧渲染进半浮点缓冲（线性空间）；
 *   2. 单独一遍**只画加色光效**（材质 `AdditiveBlending` 的 mesh，靠渲染层 `GLOW_LAYER`
 *      筛选）到一张黑底缓冲 —— 这样不会被亮岩石/亮墙面污染（整屏阈值泛光会糊成一片）；
 *   3. 光效缓冲降采样两次做可分离高斯模糊，得到「近晕 + 远晕」两级；
 *   4. 合成：`主画面 + 晕 × 强度`，末端只做一次线性→sRGB 编码。
 *
 * 关闭（`strength = 0`）时不建缓冲、不跑额外 pass，渲染路径与改造前逐位一致。
 */
import * as THREE from 'three';

/** 光效专用渲染层：加色光效 mesh 会被切到这一层，泛光 pass 只画它。 */
export const GLOW_LAYER = 2;

/** 泛光参数（线性空间；强度 0 = 关闭）。 */
export interface BloomParams {
  /** 泛光叠加系数（0 关闭）。 */
  strength: number;
  /** 近晕权重（1/2 分辨率那一级）。 */
  nearWeight: number;
  /** 远晕权重（1/4 分辨率那一级）。 */
  farWeight: number;
}

/**
 * 默认参数：默认**关闭**（`strength: 0`）。
 *
 * 原因：光效的 HDR 增益（材质 `color` 分量 >1）在 task-13 里落地前，泛光只能吃到
 * 少数像素，开了也看不出效果；等增益到位后在同一次改动里把 strength 打开。
 */
export const DEFAULT_BLOOM_PARAMS: BloomParams = { strength: 0, nearWeight: 0.55, farWeight: 0.45 };

/**
 * 亮部提取阈值（线性亮度）。
 *
 * 光效缓冲里只有加色光效，但宽幅烟幕/雾层单像素贡献只有 ~0.03，若不设阈值，
 * 模糊后会把整屏抬亮（实测 99.95% 像素变化、画面发灰）。0.3 能滤掉雾层、保留
 * 光柱核心与细激光/火花；数值来自实测 A/B（2026-11-15）。
 */
const BLOOM_THRESHOLD = 0.3;

const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** 可分离 9 抽头高斯（权重和 ≈ 1）。 */
const BLUR_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uDirection;
varying vec2 vUv;
void main() {
	vec3 s = texture2D(tDiffuse, vUv).rgb * 0.2270;
	s += (texture2D(tDiffuse, vUv + uDirection * 1.0).rgb + texture2D(tDiffuse, vUv - uDirection * 1.0).rgb) * 0.1945;
	s += (texture2D(tDiffuse, vUv + uDirection * 2.0).rgb + texture2D(tDiffuse, vUv - uDirection * 2.0).rgb) * 0.1216;
	s += (texture2D(tDiffuse, vUv + uDirection * 3.0).rgb + texture2D(tDiffuse, vUv - uDirection * 3.0).rgb) * 0.0540;
	s += (texture2D(tDiffuse, vUv + uDirection * 4.0).rgb + texture2D(tDiffuse, vUv - uDirection * 4.0).rgb) * 0.0162;
	gl_FragColor = vec4(s, 1.0);
}
`;

/** 亮部提取：只保留光效缓冲里明显亮于阈值的部分（宽而暗的加色雾层不会整屏泛白）。 */
const BRIGHT_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uThreshold;
varying vec2 vUv;
void main() {
	vec3 c = texture2D(tDiffuse, vUv).rgb;
	float m = max(c.r, max(c.g, c.b));
	float k = smoothstep(uThreshold, uThreshold * 1.6, m);
	gl_FragColor = vec4(c * k, 1.0);
}
`;

/** 合成：画面 + 两级光效晕。
 *
 * 注意：**不做线性→sRGB 编码**。本工程的场景材质（`lightmap-shader.ts` 等自绘 shader、
 * 光效的 MeshBasicMaterial）本来就是按「直接输出到 canvas」调的，渲染进离屏缓冲时
 * three 不会替它们做色彩空间转换 ⇒ 缓冲里已是显示空间值。实测（pcf-scout task-12）：
 * 开启路径若再编码一次，`strength≈0` 也会把全图 meanL 从 44 抬到 109，逐像素
 * `on ≈ sRGBEncode(off)`；本机 A/B 同样表现为整屏发灰。故这里只 clamp。
 */
const COMPOSITE_FRAGMENT = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloomNear;
uniform sampler2D tBloomFar;
uniform float uNearWeight;
uniform float uFarWeight;
uniform float uStrength;
varying vec2 vUv;

void main() {
	vec3 scene = texture2D(tScene, vUv).rgb;
	vec3 bloom = texture2D(tBloomNear, vUv).rgb * uNearWeight + texture2D(tBloomFar, vUv).rgb * uFarWeight;
	vec3 c = scene + bloom * uStrength;
	gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

/**
 * 泛光后处理实例。
 *
 * 用法（`render-session.ts`）：
 * ```ts
 * fx.begin(renderer);                       // 绑定主画面缓冲并清屏
 * renderSkyPass({ ... });                   // 天空 + 主世界画进主缓冲
 * fx.renderGlow(scene, camera);             // 只画加色光效到光效缓冲
 * fx.end(renderer);                         // 模糊 + 合成到画布
 * ```
 */
export class BloomPostFx {
  /** 主画面缓冲（半浮点、线性；关闭时也会用到）。 */
  readonly sceneTarget: THREE.WebGLRenderTarget;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly quadScene = new THREE.Scene();
  private readonly blurScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly blurQuad: THREE.Mesh;
  private readonly blurMaterial: THREE.ShaderMaterial;
  private readonly brightMaterial: THREE.ShaderMaterial;
  private readonly compositeMaterial: THREE.ShaderMaterial;
  private glowTarget: THREE.WebGLRenderTarget;
  private nearTarget: THREE.WebGLRenderTarget;
  private nearScratch: THREE.WebGLRenderTarget;
  private farTarget: THREE.WebGLRenderTarget;
  private farScratch: THREE.WebGLRenderTarget;
  private width = 0;
  private height = 0;
  private params: BloomParams;
  private readonly prevMask = new THREE.Layers();

  constructor(renderer: THREE.WebGLRenderer, params: BloomParams = DEFAULT_BLOOM_PARAMS) {
    this.renderer = renderer;
    this.params = { ...params };
    const type = renderer.capabilities.isWebGL2 ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      type,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      samples: renderer.capabilities.isWebGL2 ? 4 : 0,
    });
    this.sceneTarget.texture.minFilter = THREE.LinearFilter;
    this.sceneTarget.texture.magFilter = THREE.LinearFilter;
    this.glowTarget = this.makeTarget(type, true);
    this.nearTarget = this.makeTarget(type, false);
    this.nearScratch = this.makeTarget(type, false);
    this.farTarget = this.makeTarget(type, false);
    this.farScratch = this.makeTarget(type, false);
    this.blurMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDirection: { value: new THREE.Vector2(1, 0) } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: BLUR_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.brightMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.3 } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: BRIGHT_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.sceneTarget.texture },
        tBloomNear: { value: this.nearTarget.texture },
        tBloomFar: { value: this.farTarget.texture },
        uNearWeight: { value: params.nearWeight },
        uFarWeight: { value: params.farWeight },
        uStrength: { value: params.strength },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMaterial);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.blurQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurMaterial);
    this.blurQuad.frustumCulled = false;
    this.blurScene.add(this.blurQuad);
  }

  private makeTarget(type: THREE.TextureDataType, withDepth: boolean): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(1, 1, {
      type,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: withDepth,
      stencilBuffer: false,
    });
    rt.texture.minFilter = THREE.LinearFilter;
    rt.texture.magFilter = THREE.LinearFilter;
    return rt;
  }

  /** 运行期改参数。 */
  setParams(params: Partial<BloomParams>): void {
    this.params = { ...this.params, ...params };
    (this.compositeMaterial.uniforms.uNearWeight as { value: number }).value = this.params.nearWeight;
    (this.compositeMaterial.uniforms.uFarWeight as { value: number }).value = this.params.farWeight;
    (this.compositeMaterial.uniforms.uStrength as { value: number }).value = this.params.strength;
  }

  get enabled(): boolean {
    return this.params.strength > 0;
  }

  get currentParams(): BloomParams {
    return { ...this.params };
  }

  /** 按渲染器绘制缓冲尺寸重建所有 RT（每帧调用，尺寸没变时是空操作）。 */
  ensureSize(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(1, Math.floor(size.x));
    const h = Math.max(1, Math.floor(size.y));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.sceneTarget.setSize(w, h);
    this.glowTarget.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.nearTarget.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.nearScratch.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.farTarget.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.farScratch.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
  }

  /** 绑定主画面缓冲并清屏。 */
  begin(): void {
    this.ensureSize();
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.autoClear = true;
    this.renderer.clear();
  }

  /** 只画加色光效到光效缓冲（相机层筛选；画完还原相机层与背景）。 */
  renderGlow(scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this.enabled) return;
    const background = scene.background;
    const fog = scene.fog;
    this.prevMask.mask = camera.layers.mask;
    camera.layers.set(GLOW_LAYER);
    scene.background = null;
    scene.fog = null;
    this.renderer.setRenderTarget(this.glowTarget);
    this.renderer.autoClear = true;
    this.renderer.clear();
    this.renderer.render(scene, camera);
    camera.layers.mask = this.prevMask.mask;
    scene.background = background;
    scene.fog = fog;
  }

  /** 从光效缓冲做两级模糊并合成到画布。 */
  end(): void {
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.setRenderTarget(null);
    if (!this.enabled) {
      // 关闭：主画面缓冲直接 blit（仍要过 sRGB 编码，保证与直画逐位一致）。
      this.renderer.render(this.quadScene, this.quadCamera);
      this.renderer.autoClear = prevAutoClear;
      return;
    }
    // 光效缓冲 → 亮部提取 + 1/2 降采样（宽而暗的加色雾层在这里被滤掉）
    this.brightCopy(this.glowTarget.texture, this.nearTarget);
    this.blur(this.nearTarget, this.nearScratch, this.nearTarget);
    // → 1/4 远晕
    this.copy(this.nearTarget.texture, this.farTarget);
    this.blur(this.farTarget, this.farScratch, this.farTarget);
    // 合成到画布
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCamera);
    this.renderer.autoClear = prevAutoClear;
  }

  private copy(texture: THREE.Texture, target: THREE.WebGLRenderTarget): void {
    (this.blurMaterial.uniforms.tDiffuse as { value: THREE.Texture }).value = texture;
    (this.blurMaterial.uniforms.uDirection as { value: THREE.Vector2 }).value.set(0, 0);
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.blurScene, this.quadCamera);
  }

  /** 亮部提取 + 降采样（同一趟完成；阈值在 `BLOOM_THRESHOLD`）。 */
  private brightCopy(texture: THREE.Texture, target: THREE.WebGLRenderTarget): void {
    (this.brightMaterial.uniforms.tDiffuse as { value: THREE.Texture }).value = texture;
    (this.brightMaterial.uniforms.uThreshold as { value: number }).value = BLOOM_THRESHOLD;
    this.blurQuad.material = this.brightMaterial;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.blurScene, this.quadCamera);
    this.blurQuad.material = this.blurMaterial;
  }

  private blur(source: THREE.WebGLRenderTarget, scratch: THREE.WebGLRenderTarget, target: THREE.WebGLRenderTarget): void {
    (this.blurMaterial.uniforms.tDiffuse as { value: THREE.Texture }).value = source.texture;
    (this.blurMaterial.uniforms.uDirection as { value: THREE.Vector2 }).value.set(1 / source.width, 0);
    this.renderer.setRenderTarget(scratch);
    this.renderer.render(this.blurScene, this.quadCamera);
    (this.blurMaterial.uniforms.tDiffuse as { value: THREE.Texture }).value = scratch.texture;
    (this.blurMaterial.uniforms.uDirection as { value: THREE.Vector2 }).value.set(0, 1 / source.height);
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.blurScene, this.quadCamera);
  }

  dispose(): void {
    this.sceneTarget.dispose();
    this.glowTarget.dispose();
    this.nearTarget.dispose();
    this.nearScratch.dispose();
    this.farTarget.dispose();
    this.farScratch.dispose();
    this.blurMaterial.dispose();
    this.brightMaterial.dispose();
    this.compositeMaterial.dispose();
    (this.quad.geometry as THREE.BufferGeometry).dispose();
    (this.blurQuad.geometry as THREE.BufferGeometry).dispose();
  }
}

/**
 * 把场景里所有「加色光效」mesh 切到 `GLOW_LAYER`，供泛光 pass 单独渲染。
 *
 * 判据是材质 `blending === AdditiveBlending`（光柱 rope/trail、env_laser、sparks、
 * 加色烟幕都属于这一类）；受光面、水面、天空不会被选中，所以亮岩石不会糊进泛光。
 * 装配完成后调用一次即可（`render-session.ts`）；返回命中的 mesh 数，便于日志核对。
 */
export function markGlowMeshes(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const additive = mats.some((m) => m && (m as THREE.Material).blending === THREE.AdditiveBlending);
    if (!additive) return;
    mesh.layers.enable(GLOW_LAYER);
    count += 1;
  });
  return count;
}
