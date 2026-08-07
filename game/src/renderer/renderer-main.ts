/**
 * 主线程渲染器（最小化版）— 三源决策零等待渲染。
 *
 * 每帧：
 * 1. 三源决策：权威就绪（V_A 变化）→ S_new（并清预测 seq）；否则预测新 → S_pred；否则 S_last
 * 2. 相机同步（pos + eyeHeight）
 * 3. LOD/PVS 剔除 → 渲染
 *
 * 无 LERP/外推（被 Worker-B 预测取代）；无 lightmap/雾/碰撞可视化/准星射线。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { RuntimeConfig } from '../config.js';
import type { SceneDataMessage } from '../worker/worker-types.js';
import type { ShmState, PhysState } from '../worker/shared-state.js';
import { PvsManager } from '../world/pvs-manager.js';

const FOV = 75;
const DEG2RAD = Math.PI / 180;

/** LOD 级别。 */
const LOD_NEAR = 0;
const LOD_FAR = 2;
const LOD_PVS_HIDDEN = -1;

export class RendererMain {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private pvsManager: PvsManager | null = null;

  private rafId = 0;
  private running = false;

  // ── 三源决策状态 ───────────────────────────────────────────
  private lastVa = -1;
  private lastSeqPred = 0;
  private lastState: PhysState | null = null;
  /** 当前权威代际（V3 预测代际校验基准）。 */
  private curGen = 0;
  /** 连续消费预测帧数（V9 防发散，≤3）。 */
  private continuousPred = 0;
  /** mesh → { center, radius }（LOD 用）。 */
  private lodItems: Array<{ mesh: THREE.Mesh; center: THREE.Vector3; radius: number; cluster: number }> = [];
  /** 剔除距离（场景加载后校准）。 */
  private cullDistance = 12800;


  constructor(private readonly shared: ShmState) {}

  onSceneLoaded: ((deathThresholdY: number) => void) | null = null;

  init(canvas: HTMLCanvasElement, width: number, height: number, dpr: number, _config: RuntimeConfig): void {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(dpr, 2));
    this.renderer.setSize(width, height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, width / Math.max(height, 1), 0.1, 100000);
    this.camera.position.set(0, 100, 0);

    // 固定三点光（替代原 LightManager）
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);
    const hemi = new THREE.HemisphereLight(0xb0c4de, 0x404030, 0.4);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xfff4e0, 0.5);
    dir.position.set(100, 200, 100);
    this.scene.add(dir);

    // 背景
    this.scene.background = new THREE.Color(0x222222);
  }

  /** 加载 Worker 传来的场景（GLB + spawn + pvs）。 */
  async loadScene(data: SceneDataMessage): Promise<void> {
    if (!this.scene || !this.camera) return;
    this.disposeScene();

    // 1. GLB → Scene
    const gltf = await this.loadGlb(data.glb);
    const scene = new THREE.Scene();
    scene.userData.isBspModel = true;
    this.resetRootRotations(gltf);
    scene.add(gltf.scene);
    scene.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(scene);
    const size = bbox.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    this.scene.add(scene);

    // 2. 相机 far
    this.camera.near = Math.max(maxDim / 1000, 0.05);
    this.camera.far = maxDim * 100;
    this.camera.updateProjectionMatrix();

    // 3. PVS + LOD 注册
    this.pvsManager = new PvsManager(data.pvsJson);
    this.lodItems.length = 0;
    scene.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      const geom = mesh.geometry as THREE.BufferGeometry;
      if (!geom.boundingSphere) geom.computeBoundingSphere();
      const bs = geom.boundingSphere!;
      mesh.userData.lodLevel = LOD_NEAR;
      // faceIndex → cluster（extras.faceIndex 由 WASM 导出写入）
      const faceIdx = (mesh.userData.faceIndex ?? -1) as number;
      const cluster = this.pvsManager!.getFaceCluster(faceIdx);
      this.lodItems.push({
        mesh,
        center: bs.center.clone().applyMatrix4(mesh.matrixWorld),
        radius: bs.radius,
        cluster,
      });
    });

    // 4. 视距剔除距离：对角线 × 0.5
    this.cullDistance = Math.max(maxDim * 0.5, 1000);


    // 5. 回传死亡阈值（场景最低 Y - 1000）
    this.onSceneLoaded?.(bbox.min.y);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.rafId = requestAnimationFrame(this.boundTick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  disposeScene(): void {
    if (this.scene) {
      for (let i = this.scene.children.length - 1; i >= 0; i--) {
        const child = this.scene.children[i];
        if (child.userData?.isBspModel) {
          this.disposeObject(child);
          this.scene.remove(child);
        }
      }
    }
    this.pvsManager = null;
    this.lodItems.length = 0;
    this.lastVa = -1;
    this.lastSeqPred = 0;
    this.lastState = null;
    this.curGen = 0;
    this.continuousPred = 0;
  }

  private disposeObject(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        if (!mat) continue;
        const tex = (mat as unknown as Record<string, unknown>).map as THREE.Texture | undefined;
        if (tex?.isTexture) tex.dispose();
        mat.dispose();
      }
    });
  }

  private readonly boundTick = this.tick.bind(this);

  private tick(now: number): void {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.boundTick);
    if (!this.renderer || !this.scene || !this.camera) return;

    // 1. 三源决策
    const state = this.decideState(now);
    if (state) {
      this.camera.rotation.set(state.pitch * DEG2RAD, state.yaw * DEG2RAD, 0, 'YXZ');
      this.camera.position.set(state.pos.x, state.pos.y + state.eyeHeight, state.pos.z);
    }

    const camPos = this.camera.position;

    // 2. LOD/PVS 剔除
    if (this.lodItems.length > 0) {
      const pvs = this.pvsManager;
      if (pvs) pvs.update(camPos);
      for (const item of this.lodItems) {
        const dist = item.center.distanceTo(camPos);
        let level = LOD_NEAR;
        if (dist > this.cullDistance) {
          level = LOD_FAR;
        } else if (pvs && pvs.enabled && item.cluster >= 0 && !pvs.isVisible(item.cluster)) {
          level = LOD_PVS_HIDDEN;
        }
        if (item.mesh.userData.lodLevel !== level) {
          item.mesh.userData.lodLevel = level;
          item.mesh.visible = level === LOD_NEAR;
        }
      }
    }

    // 3. 渲染（快照就绪后无条件渲染，帧率跟随 rAF）
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 三源决策（时序图）：
   * - V_A 已刷新 → 权威 S_new，清预测 seq，更新本地记录
   * - 否则预测 seq 有效且新 → S_pred
   * - 否则回退 S_last
   */
  /**
   * 三源决策（终版，对齐审查 V2/V3/V9）：
   * - V_A 已刷新 → 权威 S_new（双缓冲 (V_A-1)&1 无撕裂），重置连续预测计数
   * - 否则 → 预测：仅当 gen_P == 当前 gen_A（代际校验，V3）且连续预测 ≤ 3 帧（V9）
   * - 否则 → 回退 S_last
   */
  private decideState(now: number): PhysState | null {
    const auth = this.shared.readAuthoritative();
    if (auth && auth.va !== this.lastVa) {
      this.lastVa = auth.va;
      this.curGen = auth.gen;
      this.continuousPred = 0; // V9：权威就绪重置连续预测计数
      this.lastSeqPred = 0;
      this.lastState = { ...auth.state, timeMs: now };
      // 权威就绪 → notify Worker-B（时序图：更新基线 + notify，不操作预测序列号）
      this.shared.notifyPrediction();
      return this.lastState;
    }
    // 路径 B：尝试消费预测（代际校验 V3 + 连续预测限帧 V9）
    this.continuousPred++;
    const pred = this.shared.readPredicted();
    const genOk = pred && pred.gen === this.curGen; // V3：仅接受当前代际的预测
    if (pred && pred.seq !== 0 && pred.seq > this.lastSeqPred && genOk && this.continuousPred <= 3) {
      this.lastSeqPred = pred.seq;
      this.lastState = { ...pred.state, timeMs: now };
      return this.lastState;
    }
    // 预测无效/代际不匹配/连续超限 → 回退 S_last 并重置连续计数（V9）
    this.continuousPred = 0;
    return this.lastState;
  }

  resize(width: number, height: number): void {
    if (!this.renderer || !this.camera) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  setCullDistance(dist: number): void {
    this.cullDistance = dist;

  }

  // ── GLB 加载 ───────────────────────────────────────────────

  private readonly gltfLoader = new GLTFLoader();

  private async loadGlb(glbBytes: ArrayBuffer): Promise<GLTF> {
    const buffer = new Uint8Array(glbBytes.byteLength);
    buffer.set(new Uint8Array(glbBytes));
    const blob = new Blob([buffer], { type: 'model/gltf-binary' });
    const url = URL.createObjectURL(blob);
    try {
      return await this.gltfLoader.loadAsync(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private resetRootRotations(gltf: GLTF): void {
    for (const child of gltf.scene.children) {
      if (child.rotation.x !== 0 || child.rotation.y !== 0 || child.rotation.z !== 0) {
        child.rotation.set(0, 0, 0);
        child.updateMatrixWorld();
      }
    }
    gltf.scene.updateMatrixWorld(true);
  }
}
