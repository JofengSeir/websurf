/**
 * 电影级后处理管线（EffectComposer）：
 *
 * 1. RenderPass 渲染场景 → SnapshotPass 快照 beauty（SSAOPass r165 无 beautyRenderTarget）
 * 2. SSAO（屏幕空间环境光遮蔽）——小方块夹角处的浓重真实阴影（消除"塑料感"的关键）。
 *    SSAOPass 只输出遮蔽层（OUTPUT.Blur），再由自写合成 pass 按 `AO 强度` 混合进画面
 *    （默认 SSAOPass 内部合并不支持强度调节）。
 * 3. Bokeh DOF（景深）——focus 为相机空间距离（世界单位），聚焦场景中心，
 *    营造"微缩沙盘模型（Diorama）"玩具感。
 * 4. FXAA —— 快速抗锯齿（composer 管线绕过 canvas MSAA）。
 * 5. OutputPass —— ACES tone mapping + sRGB 输出（r152+ composer 管线必需）。
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/** 快照 pass：把当前 readBuffer（beauty）拷进独立 RT，供 AO 合成 pass 采样。 */
class SnapshotPass extends Pass {
  readonly target: THREE.WebGLRenderTarget;
  private readonly fsQuad: FullScreenQuad;

  constructor(w: number, h: number) {
    super();
    this.target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
    this.fsQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
        vertexShader: CopyShader.vertexShader,
        fragmentShader: CopyShader.fragmentShader,
        depthTest: false,
        depthWrite: false,
      }),
    );
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    (this.fsQuad.material as THREE.ShaderMaterial).uniforms['tDiffuse'].value = readBuffer.texture;
    renderer.setRenderTarget(this.target);
    this.fsQuad.render(renderer);
  }

  override setSize(w: number, h: number): void {
    this.target.setSize(w, h);
  }

  dispose(): void {
    this.target.dispose();
    this.fsQuad.dispose();
  }
}

/** AO 合成 shader：beauty × AO 遮蔽（tDiffuse = SSAOPass 输出的遮蔽层；intensity=1 全量，<1 减弱）。 */
const AoCombineShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tBeauty: { value: null as THREE.Texture | null },
    intensity: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tBeauty;
    uniform float intensity;
    varying vec2 vUv;
    void main() {
      float ao = texture2D(tDiffuse, vUv).r; // 1=无遮蔽，<1 变暗
      vec3 beauty = texture2D(tBeauty, vUv).rgb;
      float occ = mix(1.0, ao, intensity);
      gl_FragColor = vec4(beauty * occ, 1.0);
    }
  `,
};

export class PostFX {
  readonly composer: EffectComposer;
  readonly ssao: SSAOPass;
  readonly bokeh: BokehPass;
  private readonly fxaa: ShaderPass;
  private readonly aoCombine: ShaderPass;
  private readonly beauty: SnapshotPass;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  /** FXAA shader 材质（恢复时换回）。 */
  private readonly fxaaMaterial: THREE.ShaderMaterial;
  /** 纯拷贝材质（FXAA 关闭时代替，保持 swap 链完整）。 */
  private readonly copyMaterial: THREE.ShaderMaterial;
  private aoIntensity = 1.2;
  private dofMaxblur = 0.015;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    w: number,
    h: number,
  ) {
    this.renderer = renderer;
    this.camera = camera;
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));

    // beauty 快照（SSAOPass 输出遮蔽层后 readBuffer 不再含 beauty）
    this.beauty = new SnapshotPass(w, h);
    this.composer.addPass(this.beauty);

    // SSAO：只输出（模糊后的）遮蔽层 → aoCombine 按强度合成
    this.ssao = new SSAOPass(scene, camera, w, h);
    this.ssao.output = SSAOPass.OUTPUT.Blur;
    this.ssao.kernelRadius = 1.5; // 世界单位（与小方块尺寸同量级 → 夹角浓重阴影）
    this.ssao.minDistance = 0.00001; // 归一化深度差下限（相机 far=1000 时 0.3 单位缝隙的增量 ~1e-5）
    this.ssao.maxDistance = 0.01;
    this.composer.addPass(this.ssao);

    this.aoCombine = new ShaderPass(AoCombineShader);
    this.aoCombine.uniforms['tBeauty'].value = this.beauty.target.texture;
    this.composer.addPass(this.aoCombine);

    // Bokeh DOF：焦点/光圈/最大模糊由面板滑杆控制（焦点默认跟随相机→场景中心）
    this.bokeh = new BokehPass(scene, camera, { focus: 110, aperture: 0.005, maxblur: this.dofMaxblur });
    this.composer.addPass(this.bokeh);

    this.fxaa = new ShaderPass(FXAAShader);
    this.fxaaMaterial = this.fxaa.material as THREE.ShaderMaterial;
    this.copyMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.fxaa.uniforms['resolution'].value.set(1 / w, 1 / h);
    this.composer.addPass(this.fxaa);

    this.composer.addPass(new OutputPass());
  }

  /** 渲染一帧。 */
  render(): void {
    this.composer.render();
  }

  resize(w: number, h: number): void {
    this.composer.setSize(w, h);
    // FXAA 关闭时材质为 CopyShader（无 resolution uniform），需判空
    const res = (this.fxaa.uniforms as unknown as Record<string, { value: THREE.Vector2 } | undefined>)['resolution'];
    res?.value.set(1 / w, 1 / h);
  }

  /** 相机 near/far/投影变化后调用（SSAO 深度归一化依赖相机参数）。 */
  refreshCamera(): void {
    const s = this.ssao;
    const su = s.ssaoMaterial.uniforms as unknown as Record<string, { value: number | THREE.Matrix4 }>;
    su['cameraNear'].value = this.camera.near;
    su['cameraFar'].value = this.camera.far;
    (su['cameraProjectionMatrix'].value as THREE.Matrix4).copy(this.camera.projectionMatrix);
    (su['cameraInverseProjectionMatrix'].value as THREE.Matrix4).copy(this.camera.projectionMatrixInverse);
    const du = s.depthRenderMaterial.uniforms as unknown as Record<string, { value: number }>;
    du['cameraNear'].value = this.camera.near;
    du['cameraFar'].value = this.camera.far;
  }

  // ── 面板控制 ───────────────────────────────────────────────
  // 注意：一律不 disable pass —— EffectComposer 跳过 pass 会破坏 readBuffer/
  // writeBuffer swap 链（后续 pass 读到陈旧目标）。关闭 = 效果归零（仍走管线）。

  setSsaoEnabled(on: boolean): void {
    this.aoCombine.uniforms['intensity'].value = on ? this.aoIntensity : 0;
  }

  /** AO 强度（0~3：遮蔽层混合系数）。 */
  setAoIntensity(v: number): void {
    this.aoIntensity = v;
    this.aoCombine.uniforms['intensity'].value = v;
  }

  /** AO 采样半径（世界单位；与小方块尺寸同量级时夹角阴影最浓）。 */
  setAoRadius(v: number): void {
    this.ssao.kernelRadius = v;
  }

  setDofEnabled(on: boolean): void {
    this.setDofMaxblur(on ? this.dofMaxblur : 0); // maxblur=0 → 无模糊（pass 保持启用）
  }

  /** DOF 最大模糊（0=关闭模糊）。 */
  setDofMaxblur(v: number): void {
    this.dofMaxblur = v;
    (this.bokeh.uniforms as unknown as Record<string, { value: number }>)['maxblur'].value = v;
  }

  /** DOF 焦点（世界单位 = 相机到焦平面的距离）。 */
  setDofFocus(v: number): void {
    (this.bokeh.uniforms as unknown as Record<string, { value: number }>)['focus'].value = v;
  }

  /** DOF 光圈（0.001~0.05，越大景深越浅）。 */
  setDofAperture(v: number): void {
    (this.bokeh.uniforms as unknown as Record<string, { value: number }>)['aperture'].value = v;
  }

  setFxaaEnabled(on: boolean): void {
    // 换材质而非 disable（swap 链保持完整）。注意 ShaderPass.render 会执行
    // `material.uniforms = this.uniforms`——必须同步替换 uniforms 对象，
    // 否则 CopyShader 的 opacity 拿不到值（默认 0）→ 全黑输出。
    const pass = this.fxaa;
    pass.material = on ? this.fxaaMaterial : this.copyMaterial;
    pass.uniforms = (pass.material as THREE.ShaderMaterial).uniforms;
  }
}
