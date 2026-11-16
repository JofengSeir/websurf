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

/**
 * 运行期调试/测量用覆盖（默认值 = 正式行为，不改参数时与旧版完全一致）。
 *
 * 只为 task-29（终点机位双槽帧）做 A/B 归因/试验用；正常游玩不会设置这些全局。
 * - `__vbspBloomDiv`：光晕缓冲分辨率除数（默认 2；实测 GPU 填充是双槽帧主因，可试 4）。
 * - `__vbspBloomCadence`：强制光效层重画间隔（默认按帧预算等级自动：2 = 隔帧，降级档 4）。
 * - `__vbspBloomBudgetCadence = false`：关闭「按 `__vbspBudgetLevel` 自动降级 cadence」
 *   （A/B 用，强制回到默认的隔帧节奏）。
 * - `__vbspBloomSkipDepth`：跳过光效层的深度预渲（仅测量用：相机静止时深度沿用上一帧）。
 */
const globalScope = globalThis as Record<string, unknown>;

function envPositiveNumber(name: string, fallback: number): number {
  const value = globalScope[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function envFlag(name: string): boolean {
  return globalScope[name] === true;
}

/** 显式 `= false` 时返回 true（供「默认开启、可关」的 A/B 开关用）。 */
function envDisabled(name: string): boolean {
  return globalScope[name] === false;
}

/**
 * 帧预算控制器（task-33 方案 C1，`render-session.ts` 每帧写入）当前降级等级：
 * 0=不降级，1=bloom 光晕降频，2=再叠加水面镜面降频。
 *
 * 只读；res-session 是唯一写入方。缺失/非法值按 0 处理（控制器未加载时保持默认画质）。
 */
function budgetLevel(): number {
  const level = globalScope['__vbspBudgetLevel'];
  if (typeof level !== 'number' || !Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(2, Math.floor(level)));
}

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
  /** 已应用的光晕分辨率除数（`__vbspBloomDiv` 覆盖时用于触发重建）。 */
  private appliedGlowDiv = 2;
  private params: BloomParams;
  /** 深度预渲用的「只写深度」材质（光效层需要墙体深度才能被遮挡）。 */
  private readonly depthOnlyMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    blending: THREE.NoBlending,
    fog: false,
  });
  private readonly prevMask = new THREE.Layers();
  /** 深度代理专用场景（只放那张合并网格，预渲一趟 1 次 draw）。 */
  private readonly prepassScene = new THREE.Scene();
  /** 静态深度代理；有它就代替「整场景 overrideMaterial 预渲」。 */
  private depthProxyMesh: THREE.Mesh | null = null;
  /**
   * 光效层（含深度预渲）隔帧渲染：偶数帧重画，奇数帧复用上一帧的缓冲。
   *
   * 光晕是低频信号，160Hz 更新已经看不出差别；但这条链在视距 18000 时是 bloom 的主要
   * 开销（深度代理 1 draw + 光效层 80~140 draw + CPU 提交 ~0.7ms）。隔帧后平均省一半，
   * 观感差异只在快速移动时的一帧延迟（`.tmp` 下同机位 A/B 截图逐像素一致）。
   *
   * 帧预算控制器（task-33 C1）升到 1 级时改为每 4 帧一次（见 `renderGlow` 注释），A/B
   * 开关 `__vbspBloomBudgetCadence=false`。
   */
  private glowTick = 0;

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
    const glowDiv = Math.max(1, Math.round(envPositiveNumber('__vbspBloomDiv', 2)));
    if (w === this.width && h === this.height && glowDiv === this.appliedGlowDiv) return;
    this.width = w;
    this.height = h;
    this.appliedGlowDiv = glowDiv;
    // 光晕是低频信号，默认用半个分辨率（远处一层再降一半，两级模糊叠加）。
    // 终点机位实测双槽帧是 **GPU 填充**瓶颈（136 draw 的光效层 + 深度代理），降分辨率
    // 直接省填充；模糊半径按分辨率缩放，保持屏幕空间光晕范围不变（见 `blur()`）。
    const farDiv = glowDiv * 2;
    this.glowTarget.setSize(Math.max(1, w / glowDiv), Math.max(1, h / glowDiv));
    this.nearTarget.setSize(Math.max(1, w / glowDiv), Math.max(1, h / glowDiv));
    this.nearScratch.setSize(Math.max(1, w / glowDiv), Math.max(1, h / glowDiv));
    this.farTarget.setSize(Math.max(1, w / farDiv), Math.max(1, h / farDiv));
    this.farScratch.setSize(Math.max(1, w / farDiv), Math.max(1, h / farDiv));
  }

  /**
   * 只画加色光效到黑底缓冲（相机层筛选；画完还原相机层与背景/雾）。
   *
   * **先做一遍深度预渲**：光效层单独渲染时缓冲里没有墙体的深度，否则隔着岩壁也能看到
   * 光柱/光球（用户报的「光效穿透实体、很远也看得到」）。所以先用只写深度的材质把整场景
   * 画一遍（跳过光效 mesh 本身，免得透明层互相写深度），再画光效层，让光效被实体正确遮挡。
   */
  renderGlow(scene: THREE.Scene, camera: THREE.Camera, glowMeshes: readonly THREE.Object3D[] = []): void {
    if (!this.enabled) return;
    // 隔帧：奇数帧直接复用上一帧画好的光效缓冲（见 glowTick 注释）。
    //
    // task-33 方案 C1 降级点①（本文件）：帧预算控制器升到 level>=1 时，把光效层从
    // 「隔帧（2）」降到「每 4 帧一次」；`overlay()` 仍每帧执行（只复用更旧的光晕缓冲）。
    // 依据（`.tmp/perf/frame_budget` 方案 L1，唯一有同构建 A/B 证据的一级）：
    // bloom 全关时 6.2ms 双槽帧占比 slow6 77.9%→53.3%、约省 0.35ms/帧；降到 1/4 是
    // 「保留光晕、只牺牲快速移动时的更新率」的折中。A/B：`__vbspBloomBudgetCadence=false`
    // 关掉按等级降级；`__vbspBloomCadence` 数值仍可强制指定（仅测量用）。
    const budgetCadence = envDisabled('__vbspBloomBudgetCadence')
      ? 2
      : budgetLevel() >= 1 ? 4 : 2;
    const cadence = Math.max(1, Math.round(envPositiveNumber('__vbspBloomCadence', budgetCadence)));
    if (this.glowTick++ % cadence !== 0) return;
    const skipDepth = envFlag('__vbspBloomSkipDepth');
    const background = scene.background;
    const fog = scene.fog;
    this.prevMask.mask = camera.layers.mask;
    scene.background = null;
    scene.fog = null;

    // ① 深度预渲：先把实体深度写进光效缓冲，后面的光效层才能被墙正确遮挡。
    //    有两套实现：
    //    - 有静态深度代理（`setDepthProxy`，正常载图后都有）：只用 1 次 draw 画代理，
    //      深度内容与「整场景预渲」一致，但省掉 400+ 次 draw；
    //    - 没代理（例如别处单独用本类）：退回旧路径，整场景 overrideMaterial 画一遍。
    camera.layers.mask = 0xffffffff;
    this.renderer.setRenderTarget(this.glowTarget);
    this.renderer.autoClear = true;
    // 跳过深度预渲时必须保留上一帧深度：相机静止时深度内容仍然有效。
    this.renderer.clear(true, !skipDepth, false);
    if (!skipDepth && this.depthProxyMesh) {
      this.renderer.render(this.prepassScene, camera);
    } else if (skipDepth) {
      // 测量路径：跳过整张地图的深度预渲，光效层直接吃上一帧留下的深度。
    } else {
      const hidden: THREE.Object3D[] = [];
      for (const obj of glowMeshes) {
        if (obj.visible) {
          obj.visible = false;
          hidden.push(obj);
        }
      }
      const override = scene.overrideMaterial;
      scene.overrideMaterial = this.depthOnlyMaterial;
      this.renderer.render(scene, camera);
      scene.overrideMaterial = override;
      for (const obj of hidden) obj.visible = true;
    }

    // ② 光效层：只画 GLOW_LAYER，深度测试相对上面①写好的实体深度。
    //    必须先关 autoClear：render() 默认会清色/深度，一清就把①的预渲深度抹掉，
    //    遮挡等于没做（实测 bloom on/off 在岩壁后仍有 2–4% 差异）。
    camera.layers.set(GLOW_LAYER);
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.render(scene, camera);
    this.renderer.autoClear = prevAutoClear;
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
    // 步长按分辨率除数缩放：div 越大同样像素数的模糊在屏幕空间越宽，乘 2/div 保持光晕半径。
    const stepScale = 2 / Math.max(1, this.appliedGlowDiv);
    (this.blurMaterial.uniforms.tDiffuse as { value: THREE.Texture }).value = target.texture;
    (this.blurMaterial.uniforms.uDirection as { value: THREE.Vector2 }).value.set((1 / target.width) * stepScale, 0);
    this.baseQuad.material = this.blurMaterial;
    this.renderer.setRenderTarget(this.nearScratch);
    this.renderer.render(this.baseScene, this.quadCamera);
    (this.blurMaterial.uniforms.tDiffuse as { value: THREE.Texture }).value = this.nearScratch.texture;
    (this.blurMaterial.uniforms.uDirection as { value: THREE.Vector2 }).value.set(0, (1 / target.height) * stepScale);
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.baseScene, this.quadCamera);
  }

  /**
   * 设置/替换静态深度代理（建图后调一次；换图时再传新的，`null` 表示退回整场景预渲）。
   * 代理网格会被放进内部专用场景，**不要**再挂到主场景里，否则会被正式渲染一遍。
   */
  setDepthProxy(mesh: THREE.Mesh | null): void {
    if (this.depthProxyMesh === mesh) return;
    if (this.depthProxyMesh) {
      this.prepassScene.remove(this.depthProxyMesh);
      this.depthProxyMesh.geometry.dispose();
      const material = this.depthProxyMesh.material as THREE.Material;
      material.dispose();
    }
    this.depthProxyMesh = mesh;
    if (mesh) this.prepassScene.add(mesh);
  }

  dispose(): void {
    this.setDepthProxy(null);
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
 * 例外：mesh 上标了 `userData.vbspNoGlow` 的不参与（例如细激光要「实」不要泛光）。
 * 装配完成后调用一次即可（`render-session.ts`）；命中 mesh 会填进 `out`（供深度预渲跳过），
 * 返回命中的 mesh 数，便于日志核对。
 */
export function markGlowMeshes(root: THREE.Object3D, out?: THREE.Object3D[]): number {
  let count = 0;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.userData.vbspNoGlow) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const additive = mats.some((m) => m && (m as THREE.Material).blending === THREE.AdditiveBlending);
    if (!additive) return;
    mesh.layers.enable(GLOW_LAYER);
    out?.push(mesh);
    count += 1;
  });
  return count;
}

/**
 * 把场景里的实体几何合并成一张「只写深度」的代理网格，专供 bloom 光效层的遮挡预渲。
 *
 * 为什么需要：光效层单独渲染时缓冲里没有墙体深度，否则隔着岩壁也能看到光柱/光球
 * （用户报的「光效穿透实体」）。旧做法是每帧用 overrideMaterial 把整个场景再画一遍，
 * 视距 18000 时可见 400+ 块 ⇒ 400+ 次 draw、单独实测 1.94ms/帧，是 bloom 的大头。
 * 合并成一张静态代理后，预渲只剩 1 次 draw，且深度内容与原来一致（同样的三角形、
 * 同样的世界变换），观感不变。
 *
 * 注意：加色混合的光效自己不收进来（它们本来就不该写深度、也不该互相遮挡）；
 * 代理按「所有块都画」处理——PVS 剔掉的块本来就藏在实体后面，用它们挡光效与真实
 * 遮挡等价，不会出现「隔墙看到光」。
 */
export function buildDepthProxy(root: THREE.Object3D): { mesh: THREE.Mesh; vertices: number; triangles: number } | null {
  root.updateWorldMatrix(true, true);
  interface DepthPart {
    geometry: THREE.BufferGeometry;
    matrix: THREE.Matrix4;
    base: number;
  }
  const parts: DepthPart[] = [];
  let vertexCount = 0;
  let indexCount = 0;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // 光效层（加色混合）不进深度代理，否则它们会互相挡成实心块。
    if (mats.some((m) => m && (m as THREE.Material).blending === THREE.AdditiveBlending)) return;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute('position');
    if (!position || position.count === 0) return;
    const index = geometry.getIndex();
    parts.push({ geometry, matrix: mesh.matrixWorld.clone(), base: vertexCount });
    vertexCount += position.count;
    indexCount += index ? index.count : position.count;
  });
  if (vertexCount === 0 || indexCount === 0) return null;
  const positions = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  const v = new THREE.Vector3();
  let vOff = 0;
  let iOff = 0;
  for (const part of parts) {
    const position = part.geometry.getAttribute('position') as THREE.BufferAttribute;
    const matrix = part.matrix;
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(matrix);
      positions[vOff++] = v.x;
      positions[vOff++] = v.y;
      positions[vOff++] = v.z;
    }
    const index = part.geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) indices[iOff++] = part.base + index.getX(i);
    } else {
      for (let i = 0; i < position.count; i++) indices[iOff++] = part.base + i;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  const material = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    blending: THREE.NoBlending,
    fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  // 深度要覆盖整张地图，不能跟着视锥剔除，否则远处块不在深度里、光效会透出来。
  mesh.frustumCulled = false;
  mesh.name = 'glow-depth-proxy';
  return { mesh, vertices: vertexCount, triangles: indexCount / 3 };
}
