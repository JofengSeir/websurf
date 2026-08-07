/**
 * 主线程渲染器（最小化版）— 主线程预测渲染。
 *
 * 架构（2026-08-07）：预测移入主线程，与渲染同频（rAF）。
 * - 权威 Worker-A 只同步「角度/速度/眼高/着地」基本信息（无位置）
 * - 主线程每帧：按权威速度对位置做积分外推（渲染帧 > 物理帧，填补空隙）；
 *   角度在权威帧间 LERP 插值
 * - 无 lightmap/雾/碰撞可视化/准星射线。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { RuntimeConfig } from '../config.js';
import type { SceneDataMessage } from '../worker/worker-types.js';
import type { ShmState } from '../worker/shared-state.js';
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

  // ── 主线程预测状态 ─────────────────────────────────────────
  /** 主线程积分位置（初始 = 出生点；权威不同步位置）。 */
  private pos = { x: 0, y: 0, z: 0 };
  /** 上次权威帧时间戳（角度 LERP 用）。 */
  private prevAuth: { yaw: number; pitch: number; timeMs: number } | null = null;
  private curAuth: { yaw: number; pitch: number; timeMs: number } | null = null;
  /** 最近权威速度/眼高/着地（位置外推用）。 */
  private vel = { x: 0, y: 0, z: 0 };
  private eyeHeight = 54;
  private onGround = false;
  private lastVa = -1;
  /** 渲染帧推进（dt 上限防异常）。 */
  private lastTickMs = 0;
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
    this.prevAuth = null;
    this.curAuth = null;
    this.vel = { x: 0, y: 0, z: 0 };
    this.eyeHeight = 54;
    this.onGround = false;
  }

  /** 设置初始位置/朝向（scene-data 出生点；权威不同步位置，主线程从此积分）。 */
  setInitialState(spawn: { x: number; y: number; z: number; yawDeg: number }): void {
    this.pos = { x: spawn.x, y: spawn.y, z: spawn.z };
    const yawRad = spawn.yawDeg * DEG2RAD;
    this.prevAuth = { yaw: yawRad, pitch: 0, timeMs: performance.now() };
    this.curAuth = { yaw: yawRad, pitch: 0, timeMs: performance.now() };
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

    // 1. 主线程预测：权威角度/速度校准 + 位置速度积分（渲染帧 > 物理帧，填补空隙）
    this.predict(now);
    this.camera.rotation.set(this.curPitchRad(), this.curYawRad(), 0, 'YXZ');
    this.camera.position.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);

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
   * 主线程预测（每渲染帧调用）：
   * - 权威新帧（V_A 变化）→ 更新速度/眼高/着地，角度插值基线推进（prev←cur, cur←新）
   * - 位置 = 上次位置 + 权威速度 × 渲染帧 dt（线性积分，无碰撞，接受误差）
   */
  private predict(now: number): void {
    // 渲染帧 dt（上限 0.1s 防异常）
    const dt = this.lastTickMs === 0 ? 0 : Math.min((now - this.lastTickMs) / 1000, 0.1);
    this.lastTickMs = now;

    // 读权威基本信息（角度/速度/眼高/着地；Rust 输出为度 → 存弧度）
    const auth = this.shared.readAuthoritative();
    if (auth && auth.va !== this.lastVa) {
      this.lastVa = auth.va;
      const s = auth.state;
      if (this.curAuth) this.prevAuth = { ...this.curAuth, timeMs: now };
      this.curAuth = { yaw: s.yaw * DEG2RAD, pitch: s.pitch * DEG2RAD, timeMs: now };
      this.vel = s.vel;
      this.eyeHeight = s.eyeHeight;
      this.onGround = s.onGround;
    }

    // 位置外推：pos += vel * dt（权威不同步位置，主线程积分）
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;
  }

  /** 当前渲染用 yaw（弧度）：权威帧间 LERP。 */
  private curYawRad(): number {
    if (!this.prevAuth || !this.curAuth) return this.curAuth?.yaw ?? 0;
    const span = this.curAuth.timeMs - this.prevAuth.timeMs;
    const alpha = span > 0 ? Math.min(Math.max((performance.now() - this.prevAuth.timeMs) / span, 0), 1) : 1;
    return this.lerpAngle(this.prevAuth.yaw, this.curAuth.yaw, alpha);
  }

  /** 当前渲染用 pitch（弧度）：权威帧间 LERP。 */
  private curPitchRad(): number {
    if (!this.prevAuth || !this.curAuth) return this.curAuth?.pitch ?? 0;
    const span = this.curAuth.timeMs - this.prevAuth.timeMs;
    const alpha = span > 0 ? Math.min(Math.max((performance.now() - this.prevAuth.timeMs) / span, 0), 1) : 1;
    return this.prevAuth.pitch + (this.curAuth.pitch - this.prevAuth.pitch) * alpha;
  }

  /** 最短角距插值。 */
  private lerpAngle(a: number, b: number, t: number): number {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
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
