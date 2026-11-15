/**
 * 屏幕后处理：泛光（bloom）——起源式「光效会晕开」的那一层。
 *
 * 为什么需要它（2026-11-15，用户 m13126）：「绝大部分光效在起源里比 websurf 里更亮」。
 * 实测峰值/宽度已对齐（peak 196 vs 194），差距在**亮部外围的软晕面积**——起源是
 * HDR + bloom 后处理，我们之前是直画到画布、亮部在 255 硬截断。
 *
 * 为什么是「叠加式 glow pass」而不是把整个场景渲进离屏缓冲再做后处理：
 * - 本工程的场景材质混了两类：自绘 ShaderMaterial（`lightmap-shader.ts`，按「直接输出
 *   canvas」调过）和 three 内置材质（粒子/激光，输出线性值）。渲进同一个离屏缓冲后，
 *   任何统一的一次 tone/色彩空间变换都会错其中一类（实测整屏发灰 99.95% 像素变化）。
 * - 所以主场景**照旧直画**，只把加色光效单独渲到黑底缓冲（按渲染层 `GLOW_LAYER` 筛）、
 *   模糊成两级晕，最后**加法叠加**到已画好的画面上。这样无论自绘材质怎么调，主画面
 *   一个像素都不变，只有光效周围多出软晕。
 * - 光效是 three 内置材质（MeshBasicMaterial + AdditiveBlending），渲染到
 *   `NoColorSpace` 的缓冲时输出线性值 ⇒ 叠加前做一次线性→sRGB，与直画路径的
 *   `outputColorSpace = SRGBColorSpace` 对齐。
 *
 * 关闭（`strength = 0`）时不跑任何额外 pass，渲染路径与改造前完全一致。
 */
import * as THREE from 'three';

/** 光效专用渲染层：加色光效 mesh 会被切到这一层，泛光 pass 只画它。 */
export const GLOW_LAYER = 2;

/** 泛光参数。 */
export interface BloomParams {
  /** 叠加强度（0 关闭）。 */
  strength: number;
  /** 近晕权重（1/2 分辨率那一级）。 */
  nearWeight: number;
  /** 远晕权重（1/4 分辨率那一级）。 */
  farWeight: number;
}

/**
 * 默认参数：默认开启（0.3）。
 *
 * 取值依据（2026-11-15，boreas 符文坑 `cand_c` 机位，predicate 见 `.tmp/gn_*.png`）：
 * 0.1/0.2/0.35/0.5 四档里 ROI meanL 65.8 → 67.4/69.0/71.3/73.6、fracL250 0.008 →
 * 0.015/0.022/0.039/0.052；0.35 时光晕已明显但边缘仍干净，取 0.3 略保守。
 */
export const DEFAULT_BLOOM_PARAMS: BloomParams = { strength: 0.3, nearWeight: 0.55, farWeight: 0.45 };

/**
 * 亮部提取阈值（线性）。
 *
 * 光效缓冲里只有加色光效，但宽幅烟幕/雾层单像素贡献只有 ~0.03；不筛的话模糊后
 * 会把整屏抬亮。0.3 能滤掉雾层、保留光柱核心与细激光/火花。
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

/** 亮部提取（只保留明显亮于阈值的部分；宽而暗的雾层不会整屏泛白）。 */
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

/** 叠加：把两级晕（线性）编码到显示空间后**加法**叠到画面。 */
const OVERLAY_FRAGMENT = /* glsl */ `
uniform sampler2D tBloomNear;
uniform sampler2D tBloomFar;
uniform float uNearWeight;
uniform float uFarWeight;
uniform float uStrength;
varying vec2 vUv;

vec3 linearToSrgb(vec3 c) {
	return pow(c, vec3(1.0 / 2.2));
}

void main() {
	vec3 bloom = texture2D(tBloomNear, vUv).rgb * uNearWeight
		+ texture2D(tBloomFar, vUv).rgb * uFarWeight;
	gl_FragColor = vec4(linearToSrgb(clamp(bloom, 0.0, 1.0)) * uStrength, 1.0);
}
`;

/**
 * 泛光后处理实例。
 *
 * 用法（`render-session.ts`）：
 * ```ts
 * // 主场景照旧直画到画布（renderSkyPass）
 * fx.renderGlow(scene, camera);  // 只把加色光效渲到黑底缓冲
 * fx.overlay();                  // 模糊 + 加法叠加到画布
 * ```
 */
export class BloomPostFx {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly baseScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly baseQuad: THREE.Mesh;
  private readonly blurQuad: THREE.Mesh;
  private readonly blurMaterial: THREE.ShaderMaterial;
  private readonly brightMaterial: THREE.ShaderMaterial;
  private readonly overlayMaterial: THREE.ShaderMaterial;
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
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: BLOOM_THRESHOLD } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: BRIGHT_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.overlayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tBloomNear: { value: this.nearTarget.texture },
        tBloomFar: { value: this.farTarget.texture },
        uNearWeight: { value: params.nearWeight },
        uFarWeight: { value: params.farWeight },
        uStrength: { value: params.strength },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: OVERLAY_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      // 叠在已画好的画面上：加法混合 + 不写深度。
      blending: THREE.AdditiveBlending,
      transparent: true,
    });
    this.baseQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurMaterial);
    this.baseQuad.frustumCulled = false;
    this.baseScene.add(this.baseQuad);
    this.blurQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.overlayMaterial);
    this.blurQuad.frustumCulled = false;
    this.blurScene.add(this.blurQuad);
  }

  private readonly blurScene = new THREE.Scene();

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
    (this.overlayMaterial.uniforms.uNearWeight as { value: number }).value = this.params.nearWeight;
    (this.overlayMaterial.uniforms.uFarWeight as { value: number }).value = this.params.farWeight;
    (this.overlayMaterial.uniforms.uStrength as { value: number }).value = this.params.strength;
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
    this.glowTarget.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.nearTarget.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.nearScratch.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.farTarget.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.farScratch.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
  }

  /** 只画加色光效到黑底缓冲（相机层筛选；画完还原相机层与背景/雾）。 */
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
    this.renderer.setRenderTarget(null);
  }

  /** 亮部提取 + 两级模糊，最后加法叠加到画布。 */
  overlay(): void {
    if (!this.enabled) return;
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    // 光效缓冲 → 亮部提取 + 1/2
    (this.brightMaterial.uniforms.tDiffuse as { value: THREE.Texture }).value = this.glowTarget.texture;
    this.baseQuad.material = this.brightMaterial;
    this.renderer.setRenderTarget(this.nearTarget);
    this.renderer.render(this.baseScene, this.quadCamera);
    // 近晕模糊
    this.blur(this.nearTarget);
    // 1/4 远晕
    (this.blurMaterial.uniforms.tDiffuse as { value: THREE.Texture }).value = this.nearTarget.texture;
    (this.blurMaterial.uniforms.uDirection as { value: THREE.Vector2 }).value.set(0, 0);
    this.renderer.setRenderTarget(this.farTarget);
    this.renderer.render(this.baseScene, this.quadCamera);
    this.blur(this.farTarget);
    // 叠加到画布（加法混合；不清理已画好的画面）
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.blurScene, this.quadCamera);
    this.renderer.autoClear = prevAutoClear;
  }

  private blur(target: THREE.WebGLRenderTarget): void {
    (this.blurMaterial.uniforms.tDiffuse as { value: THREE.Texture }).value = target.texture;
    (this.blurMaterial.uniforms.uDirection as { value: THREE.Vector2 }).value.set(1 / target.width, 0);
    this.baseQuad.material = this.blurMaterial;
    this.renderer.setRenderTarget(this.nearScratch);
    this.renderer.render(this.baseScene, this.quadCamera);
    (this.blurMaterial.uniforms.tDiffuse as { value: THREE.Texture }).value = this.nearScratch.texture;
    (this.blurMaterial.uniforms.uDirection as { value: THREE.Vector2 }).value.set(0, 1 / target.height);
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.baseScene, this.quadCamera);
  }

  dispose(): void {
    this.glowTarget.dispose();
    this.nearTarget.dispose();
    this.nearScratch.dispose();
    this.farTarget.dispose();
    this.farScratch.dispose();
    this.blurMaterial.dispose();
    this.brightMaterial.dispose();
    this.overlayMaterial.dispose();
    (this.baseQuad.geometry as THREE.BufferGeometry).dispose();
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
