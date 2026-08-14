/**
 * BSP 地图模式 —— 导出光照等更多信息的端到端验证。
 *
 * 流程：
 * 1. 拖入/选择 .bsp → wasm `BspProcessor` 解析；
 * 2. `export_glb_with_pakfile_models_with_lights()`：PAKFILE 模型 + BSP 光照实体
 *    （light/light_spot/light_environment）→ `KHR_lights_punctual` 写入 GLB；
 * 3. GLTFLoader 加载（原生解析 KHR_lights_punctual → three.js 灯光）；
 * 4. `instanciateSharedMeshes`：共享 mesh 的节点 → 空间 cell 分组 InstancedMesh
 *    （实例化绘制应用在导出内容上）；
 * 5. 同一条 SSAO + Bokeh DOF + FXAA 后处理管线渲染。
 */
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { instanciateSharedMeshes, type InstancingStats } from './instancing.js';
import type { Hud } from './hud.js';
import type { PostFX } from './composer.js';

export interface BspLoadReport {
  instancing: InstancingStats;
  lightCount: number;
  lightTypes: string[];
  glbBytes: number;
  bboxSize: [number, number, number];
}

export class BspViewer {
  readonly group = new THREE.Group();
  private readonly loader = new GLTFLoader();
  private wasmReady: Promise<void> | null = null;
  private exportedLights: THREE.Light[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls,
    private readonly hud: Hud,
    private readonly postfx: PostFX,
  ) {}

  /** 加载 .bsp 字节 → wasm 导出（模型+光照）→ 渲染 + 实例化。 */
  async loadBsp(bytes: Uint8Array): Promise<BspLoadReport> {
    this.clear();
    await this.ensureWasm();
    // 沙盘雾（260~900 单位）在世界尺度地图上会把几何全染成雾色 → 清雾
    this.scene.fog = null;

    // 1. wasm 解析 + 导出 GLB（含 KHR_lights_punctual 光照）
    const { BspProcessor } = await import('../pkg/websurf_wasm.js');
    const proc = new BspProcessor(bytes as unknown as Uint8Array);
    const glbBytes = proc.export_glb_with_pakfile_models_with_lights();
    const glb = glbBytes as unknown as Uint8Array;

    // 2. 加载 GLB（GLTFLoader 原生解析 KHR_lights_punctual → 灯光对象）
    const blobUrl = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
    let gltf: GLTF;
    try {
      gltf = await this.loader.loadAsync(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }

    // 导出带 Y+90° 根旋转（wasm 契约），清零避免双旋转
    for (const child of gltf.scene.children) {
      child.rotation.set(0, 0, 0);
    }
    gltf.scene.updateMatrixWorld(true);

    // 3. 收集导出灯光
    const lightTypes = new Set<string>();
    gltf.scene.traverse((o) => {
      if ((o as THREE.Light).isLight) {
        this.exportedLights.push(o as THREE.Light);
        lightTypes.add((o as THREE.Light).constructor.name);
      }
    });

    // 3.5 光照预算：three.js 前向着色器每材质的灯光数量有上限（超出被忽略），
    //     且灯越多每帧开销越大 → 按亮度取 top-N（默认 32，?lights=N 可调）。
    //     DirectionalLight（light_environment）始终保留。
    const budget = Number(new URLSearchParams(location.search).get('lights') ?? 32) || 32;
    if (this.exportedLights.length > budget) {
      const dirs = this.exportedLights.filter((l) => (l as THREE.DirectionalLight).isDirectionalLight);
      const ranked = this.exportedLights
        .filter((l) => !(l as THREE.DirectionalLight).isDirectionalLight)
        .sort((a, b) => b.intensity - a.intensity);
      const kept = [...dirs, ...ranked.slice(0, Math.max(budget - dirs.length, 0))];
      for (const l of this.exportedLights) {
        if (!kept.includes(l)) l.removeFromParent();
      }
      this.exportedLights = kept;
    }
    // ?ambient=1：环境光兜底（导出灯光不足以照亮画面时调试/演示用）
    if (new URLSearchParams(location.search).get('ambient') === '1') {
      const amb = new THREE.AmbientLight(0xffffff, 0.5);
      this.exportedLights.push(amb);
      this.group.add(amb);
      lightTypes.add('AmbientLight(兜底)');
    }

    // 4. 渲染端实例化（共享 mesh 节点 → InstancedMesh）
    const instancing = instanciateSharedMeshes(gltf, 2048);

    // 5. 挂载 + 取景 + DOF 焦点对齐场景中心
    this.group.add(gltf.scene);
    this.scene.add(this.group);
    const bbox = new THREE.Box3().setFromObject(this.group);
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    this.controls.target.copy(center);
    this.camera.near = Math.max(maxDim / 1000, 0.1);
    this.camera.far = maxDim * 20;
    this.camera.position.set(
      center.x + maxDim * 1.2,
      center.y + maxDim * 0.9,
      center.z + maxDim * 1.2,
    );
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.postfx.refreshCamera(); // SSAO 深度归一化依赖 near/far/投影矩阵

    // DOF 焦点 = 相机到中心距离；但 DOF 参数按沙盘尺度调校，世界尺度地图下
    // 会全屏最大模糊 → BSP 模式默认关闭（面板可手动开启，光圈需调小）
    const focus = this.camera.position.distanceTo(center);
    this.postfx.setDofFocus(focus);
    this.postfx.setDofEnabled(false);

    // 无导出灯光时提示（保留场景可看性：弱环境光兜底）
    if (this.exportedLights.length === 0) {
      const amb = new THREE.AmbientLight(0x8899aa, 0.6);
      this.exportedLights.push(amb);
      this.group.add(amb);
      lightTypes.add('AmbientLight(兜底)');
    }

    this.hud.setInstances(instancing.instances);
    this.hud.setNote(
      `BSP 导出光照: ${this.exportedLights.length} 个 (${[...lightTypes].join(', ')})\n` +
        `实例化: ${instancing.groups} 组 / ${instancing.cells} cell / ${instancing.instances} 实例\n` +
        `世界几何合并: ${instancing.chunks} 块 | mesh ${instancing.beforeMeshes} → ${instancing.afterMeshes}\n` +
        `GLB ${(glbBytes.length / 1048576).toFixed(1)} MB`,
    );

    return {
      instancing,
      lightCount: this.exportedLights.length,
      lightTypes: [...lightTypes],
      glbBytes: glbBytes.length,
      bboxSize: [size.x, size.y, size.z],
    };
  }

  /** 场景内是否已有导出灯光（面板/其他逻辑用）。 */
  get hasExportedLights(): boolean {
    return this.exportedLights.length > 0;
  }

  private async ensureWasm(): Promise<void> {
    if (!this.wasmReady) {
      this.wasmReady = (async () => {
        const { initSync } = await import('../pkg/websurf_wasm.js');
        const resp = await fetch('./websurf_wasm_bg.wasm');
        initSync({ module: await resp.arrayBuffer() });
      })();
    }
    await this.wasmReady;
  }

  clear(): void {
    for (const light of this.exportedLights) {
      light.removeFromParent();
    }
    this.exportedLights = [];
    // 释放 GLB 子树 GPU 资源（重复加载地图防泄漏；共享 geometry 只释放一次）
    const geoms = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    const texKeys = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'] as const;
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (m.geometry) geoms.add(m.geometry);
      const list = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of list) {
        if (!mat) continue;
        mats.add(mat);
        for (const key of texKeys) {
          const tex = (mat as unknown as Record<string, unknown>)[key] as THREE.Texture | undefined;
          if (tex?.isTexture) textures.add(tex);
        }
      }
      if ((m as THREE.InstancedMesh).isInstancedMesh) {
        (m as THREE.InstancedMesh).dispose(); // instanceMatrix/instanceColor GPU 缓冲
      }
    });
    for (const g of geoms) g.dispose();
    for (const t of textures) t.dispose();
    for (const mat of mats) mat.dispose();
    this.group.clear();
    this.scene.remove(this.group);
  }

  dispose(): void {
    this.clear();
  }
}
