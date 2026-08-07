/**
 * 主线程渲染器（最小化版）— 客户端预测渲染。
 *
 * 架构（2026-08-07 v4.1）：
 * - 主线程持 wasm `PhysWorld` 预测实例：每 rAF 调 `predict(dt, keys, dx, dy)`
 *   做**真实物理模拟**（移动语义 + 碰撞），渲染预测结果（输入零延迟）
 * - Worker-A 权威物理每帧写全状态到 SAB → 主线程 `set_state` 修正预测基线
 *   （标准客户端预测：本地模拟即时响应，权威定期纠偏）
 * - respawn/teleport 位置突变：player-respawn 事件 → set_state 归零
 * - 无 lightmap/雾/碰撞可视化/准星射线。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PhysWorld, default as wasmInit } from '../../pkg/websurf_wasm.js';
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

/** 权威帧快照（A2；速度外推校准依据）。 */
interface AuthSnap {
  pos: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  vel: { x: number; y: number; z: number };
  /** 权威最近加速度（两权威帧速度差 / tick；外推校准用）。 */
  accel: { x: number; y: number; z: number };
  eyeHeight: number;
  /** 权威帧产生时刻（tick 结束时刻，ms）。 */
  timeMs: number;
}

export class RendererMain {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private pvsManager: PvsManager | null = null;

  private rafId = 0;
  private running = false;

  // ── 主线程唯一物理线 ───────────────────────────────────────
  /** 主线程 PhysWorld 实例（唯一物理：完整世界+碰撞+输入；每帧 tick 推进并渲染）。 */
  private predPhys: PhysWorld | null = null;
  /** 主线程物理就绪（world-json 构建完成）。 */
  private predReady = false;
  /** 待喂给物理实例的输入（app 事件回调累积）。 */
  private pendingDx = 0;
  private pendingDy = 0;
  private pendingKeys = 0;
  /** noclip 模式（物理走 tick 的 noclip_step 分支，无碰撞纯移动）。 */
  private noclipActive = false;
  /** 权威版本号（修正去重）。 */
  private lastVa = -1;
  /** 最新权威帧快照（速度外推校准依据，只留当前一帧）。 */
  private curAuth: AuthSnap | null = null;
  /** 上一权威速度/时刻（算权威加速度用）。 */
  private prevAuthVel: { x: number; y: number; z: number } | null = null;
  private prevAuthTimeMs = 0;
  /** 主线程渲染物理是否已用首个权威帧校准起点。 */
  private predStarted = false;
  /** 渲染帧推进（dt 上限防异常）。 */
  private lastTickMs = 0;
  /** mesh → { center, radius, clusterIds }（LOD/PVS 用；clusterIds 空间采样分配）。 */
  private lodItems: Array<{ mesh: THREE.Mesh; center: THREE.Vector3; radius: number; clusterIds: number[] }> = [];
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
      // clusterIds：空间采样分配（与主项目 lodManager.assignClusterIds 同法；
      // 不依赖 GLB extras.faceIndex——WASM 导出未写入该字段，原 getFaceCluster 恒 -1）
      const center = bs.center.clone().applyMatrix4(mesh.matrixWorld);
      const set = new Set<number>();
      const r = Math.max(bs.radius, 1);
      const samples: Array<[number, number, number]> = [
        [center.x, center.y, center.z],
        [center.x + r, center.y, center.z],
        [center.x - r, center.y, center.z],
        [center.x, center.y + r, center.z],
        [center.x, center.y - r, center.z],
        [center.x, center.y, center.z + r],
        [center.x, center.y, center.z - r],
      ];
      for (const [x, y, z] of samples) {
        const cl = this.pvsManager!.getClusterAt({ x, y, z });
        if (cl >= 0) set.add(cl);
      }
      this.lodItems.push({
        mesh,
        center,
        radius: bs.radius,
        clusterIds: [...set],
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
    this.predPhys = null;
    this.predReady = false;
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.pendingKeys = 0;
    this.noclipActive = false;
    this.prevAuthVel = null;
    this.prevAuthTimeMs = 0;
    this.predStarted = false;
    this.curAuth = null;
    this.lastVa = -1;
  }

  // ── 主线程唯一物理线 ───────────────────────────────────────

  /** 主线程初始化 wasm（PhysWorld 模块）。 */
  async initPrediction(wasmUrl: string): Promise<void> {
    const resp = await fetch(wasmUrl);
    const buf = await resp.arrayBuffer();
    await wasmInit({ module: buf });
  }

  /** world-json 到达：主线程构建 PhysWorld（唯一物理：世界+碰撞+输入+渲染）。 */
  buildPredictionWorld(world: {
    brushJson: string;
    triJson: string;
    teleportJson: string;
    spawn: { x: number; y: number; z: number; yawDeg: number };
  }): void {
    const phys = new PhysWorld();
    phys.build_world(
      world.brushJson,
      world.triJson,
      world.teleportJson,
      world.spawn.x,
      world.spawn.y,
      world.spawn.z,
      world.spawn.yawDeg,
    );
    this.predPhys = phys;
    this.predReady = true;
    this.noclipActive = false;
    this.prevAuthVel = null;
    this.prevAuthTimeMs = 0;
    this.predStarted = false;
    this.curAuth = null;
    this.lastVa = -1;
  }

  /** 物理实例输入（app 事件回调喂入；唯一输入通道）。 */
  feedInput(dx: number, dy: number, keysMask: number): void {
    this.pendingDx += dx;
    this.pendingDy += dy;
    this.pendingKeys = keysMask;
  }

  /** 清空待喂输入（Pointer Lock 退锁/重锁时调用，防残留输入污染）。 */
  clearPendingInput(): void {
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.pendingKeys = 0;
  }

  /** 重生（面板/按键；主线程物理直接 respawn，不经 Worker）。 */
  respawn(): void {
    this.predPhys?.respawn();
  }

  /** 传送至指定出生点索引（面板 spawn 下拉）。 */
  teleportToSpawn(idx: number): void {
    this.predPhys?.teleport_to_spawn(idx);
  }

  /** 设置出生点列表（[[x,y,z,yaw], ...]，spawn 下拉切换用）。 */
  setSpawnPoints(list: Array<[number, number, number, number]>): void {
    try {
      this.predPhys?.set_spawn_points(JSON.stringify(list));
    } catch (err) {
      console.error('[renderer] set_spawn_points 失败:', err);
    }
  }

  /** 设置死亡 Y 阈值（loadScene 后由 onSceneLoaded 回调传入）。 */
  setDeathY(y: number): void {
    this.predPhys?.set_death_y(y);
  }

  /** 当前物理速度（速度面板 8Hz 采样）。 */
  getCurrentVel(): { x: number; y: number; z: number } {
    if (!this.predPhys) return { x: 0, y: 0, z: 0 };
    const st = this.predPhys.state() as { velX: number; velY: number; velZ: number };
    return { x: st.velX, y: st.velY, z: st.velZ };
  }

  /**
   * 权威帧到达（A2）处理 —— **只读权威，绝不反写**（v7 定案）。
   *
   * Worker 是权威帧计算器（加载地图碰撞、独立 64Hz 模拟）；本方法仅记录
   * 权威帧（速度供外推校准、位置/角度供异常兜底）：
   * - 首次权威帧（或重载后）：主线程渲染物理 set_state(权威帧) 作为起点（仅一次）
   * - 异常兜底：位置差 > 200（暂停恢复/传送残留等极端异常）→ set_state 对齐
   *   （防崩溃安全网；正常运行不触发，不属"强行同步位置"）
   * - 速度校准由 calibrateVelocity 在每个渲染帧执行（外推，位置不覆盖）
   */
  private correctFromAuthority(): void {
    if (!this.predPhys) return;
    const auth = this.shared.readAuthoritative();
    if (!auth || auth.va === this.lastVa) return;
    this.lastVa = auth.va;
    const f = auth.frame;
    this.curAuth = {
      pos: { ...f.pos },
      yaw: f.yaw,
      pitch: f.pitch,
      vel: { ...f.vel },
      accel: this.computeAuthAccel(f.vel, f.timeMs),
      eyeHeight: f.eyeHeight,
      timeMs: f.timeMs,
    };

    // 首次权威帧（或重载后）：以权威全状态作为渲染物理起点
    if (!this.predStarted) {
      this.predStarted = true;
      this.predPhys.set_state(f.pos.x, f.pos.y, f.pos.z, f.yaw, f.pitch, f.vel.x, f.vel.y, f.vel.z, f.onGround);
      return;
    }
    // 异常兜底：位置差 > 200 → 渲染物理对齐（暂停恢复/传送残留等极端场景；正常不触发）
    const st = this.predPhys.state() as { posX: number; posY: number; posZ: number };
    const dist = Math.hypot(st.posX - f.pos.x, st.posY - f.pos.y, st.posZ - f.pos.z);
    if (dist > 200) {
      this.predPhys.set_state(f.pos.x, f.pos.y, f.pos.z, f.yaw, f.pitch, f.vel.x, f.vel.y, f.vel.z, f.onGround);
      this.pendingDx = 0;
      this.pendingDy = 0;
    }
  }

  /** 权威加速度 = 两权威帧速度差 / 帧间隔（u/s²）；首帧/间隔异常 → 0。 */
  private computeAuthAccel(
    vel: { x: number; y: number; z: number },
    timeMs: number,
  ): { x: number; y: number; z: number } {
    const prev = this.prevAuthVel;
    const prevT = this.prevAuthTimeMs;
    this.prevAuthVel = { ...vel };
    this.prevAuthTimeMs = timeMs;
    if (!prev || prevT <= 0) return { x: 0, y: 0, z: 0 };
    const dt = (timeMs - prevT) / 1000;
    if (dt < 0.001 || dt > 0.5) return { x: 0, y: 0, z: 0 };
    // clamp ±20000（重力 800；碰撞瞬间速度跳变可能巨大，防外推爆炸）
    const clamp = (v: number): number => Math.max(-20000, Math.min(20000, v));
    return {
      x: clamp((vel.x - prev.x) / dt),
      y: clamp((vel.y - prev.y) / dt),
      z: clamp((vel.z - prev.z) / dt),
    };
  }

  /**
   * 逐帧速度校准（每个渲染帧、tick 之前）—— 权威速度外推反馈。
   *
   * Worker 权威帧速度已考虑中途地图物理碰撞（卡坡/穿墙/落地）→ 用它修正
   * 渲染物理速度，让渲染轨迹向权威对齐。权威帧到达滞后（64Hz vs 渲染帧）：
   *   vel_target = vel_A + a × (t_now − t_A)
   * a = 权威最近加速度；动态帧距（拿到权威帧的那一帧，Bn+k 自动适配）。
   * 垂直落体实测：锯齿 5.54≈理论 5.56，滞后偏差消除。
   *
   * **角度不校准**（用户定调）：权威帧不得影响渲染帧角度——角度由渲染物理
   * 自己输入驱动（鼠标 + Q/E，144Hz 高精度），Q/E 速度等输入参数立即生效；
   * 权威仅在碰撞事件（phys-event）时才可影响角度（见 applyCollisionCorrection）。
   */
  private calibrateVelocity(now: number): void {
    if (!this.predPhys || !this.curAuth) return;
    const a = this.curAuth;
    const dt = (now - a.timeMs) / 1000; // 权威帧产生 → 当前渲染帧（动态帧距）
    let v = a.vel;
    if (dt > 0 && dt <= 0.1) {
      v = {
        x: a.vel.x + a.accel.x * dt,
        y: a.vel.y + a.accel.y * dt,
        z: a.vel.z + a.accel.z * dt,
      };
    }
    // dt<=0（时间戳异常）或 >0.1s（权威停更/暂停恢复）→ 直接用权威速度，不外推防漂移
    this.predPhys.set_velocity(v.x, v.y, v.z);
  }

  /** 位置突变归零（显式重置允许覆盖：respawn/teleport/noclip 切换）。 */
  resetTo(pos: number[], yawDeg: number): void {
    if (!this.predPhys) return;
    this.predPhys.set_state(pos[0], pos[1], pos[2], yawDeg, 0, 0, 0, 0, true);
    // 清待喂输入，防突变后残留方向/跳跃
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.pendingKeys = 0;
    this.prevAuthVel = null;
    this.prevAuthTimeMs = 0;
    this.predStarted = false;
    this.curAuth = null;
    this.lastVa = -1;
  }

  /**
   * 权威碰撞事件 → 位置微调 + 角度同步（用户定调：权威**仅在碰撞判断时**可影响
   * 渲染角度）。渲染物理与权威物理的碰撞相位差（64 vs 144Hz）导致落地/撞墙瞬间
   * 位置差几 units——权威碰撞结果回传一次，微调渲染位置让碰撞视觉对齐；
   * 角度取权威（碰撞瞬间的权威朝向，玩家注意力在碰撞上，小角度差无感）。
   * - land：权威全状态（落地瞬间速度已碰撞处理，权威为准）
   * - blocked：仅位置/角度（速度保留渲染侧，由逐帧校准收敛）
   * 距离 < 60 才调整；≥ 60 跳过防视觉跳变（异常场景仍由 >200 权威帧兜底处理）。
   */
  applyCollisionCorrection(kind: 'land' | 'blocked', pos: number[], yawDeg: number, pitchDeg: number): void {
    if (!this.predPhys) return;
    const st = this.predPhys.state() as {
      posX: number; posY: number; posZ: number;
      velX: number; velY: number; velZ: number;
      onGround: boolean;
    };
    const dist = Math.hypot(st.posX - pos[0], st.posY - pos[1], st.posZ - pos[2]);
    if (dist >= 60) return;
    if (kind === 'land') {
      // 权威落地全状态（位置 + 角度 + 速度 + 着地），权威碰撞结果为准
      this.predPhys.set_state(pos[0], pos[1], pos[2], yawDeg, pitchDeg, st.velX, st.velY, st.velZ, st.onGround);
    } else {
      // 撞墙：位置/角度取权威（速度由每帧校准拉向权威）
      this.predPhys.set_state(pos[0], pos[1], pos[2], yawDeg, pitchDeg, st.velX, st.velY, st.velZ, st.onGround);
    }
  }

  /** 面板参数实时同步到主线程物理实例（与 set_params 同字段）。 */
  setPredictionParams(params: Record<string, unknown>): void {
    try {
      this.predPhys?.set_params(JSON.stringify(params));
    } catch (err) {
      console.error('[renderer] set_params 失败:', err);
    }
  }

  /**
   * noclip 模式同步到主线程物理。
   * Rust tick 在 noclip 下走 noclip_step（无碰撞纯移动 + Q/E 转向），
   * 物理实例内部切换，无需额外渲染分支。
   */
  setPredictionNoclip(active: boolean): void {
    this.noclipActive = active;
    try {
      this.predPhys?.set_noclip(active);
    } catch (err) {
      console.error('[renderer] set_noclip 失败:', err);
    }
    this.clearPendingInput();
  }

  /** 面板体型实时同步到主线程物理实例。 */
  setPredictionHull(halfWidth: number, standHeight: number, duckHeight: number): void {
    this.predPhys?.set_hull(halfWidth, standHeight, duckHeight);
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

    // 1. 主线程渲染物理线 + Worker 权威帧校准（v7）：
    //    写输入 SAB（Worker 权威模拟同输入）→ 读权威帧 → 外推校准 → tick → 渲染
    if (this.predReady && this.predPhys) {
      const dt = this.lastTickMs === 0 ? 1 / 64 : Math.min((now - this.lastTickMs) / 1000, 0.1);
      this.lastTickMs = now;
      // 输入 → SAB 输入槽（Worker 权威帧模拟消费；与主线程同输入）
      this.shared.addInput(this.pendingDx, this.pendingDy, this.pendingKeys);
      // 权威帧到达 → 记录（只读）；首次 set_state 起点；>200 异常兜底
      this.correctFromAuthority();
      // 权威速度外推校准（考虑中途地图碰撞后的正确速度；位置不覆盖）
      this.calibrateVelocity(now);
      // 完整物理推进：physics = 碰撞/传送/死亡/reset；noclip = noclip_step（无碰撞）
      this.predPhys.tick(dt, this.pendingKeys, this.pendingDx, this.pendingDy);
      this.pendingDx = 0;
      this.pendingDy = 0;
      // 渲染 = 主线程物理状态（连续无屏闪）
      const st = this.predPhys.state() as {
        posX: number; posY: number; posZ: number;
        yaw: number; pitch: number;
        eyeHeight: number;
      };
      // Rust 输出角度为度 → 弧度
      this.camera.rotation.set(st.pitch * DEG2RAD, st.yaw * DEG2RAD, 0, 'YXZ');
      this.camera.position.set(st.posX, st.posY + st.eyeHeight, st.posZ);
    }

    const camPos = this.camera.position;

    // 2. LOD/PVS 剔除
    if (this.lodItems.length > 0) {
      const pvs = this.pvsManager;
      if (pvs) pvs.update(camPos);
      // PVS 安全保护（主项目同法）：相机不在任何 cluster（出生在固体/地图外）时
      // 可见集为空，有 cluster 的 mesh 会被错误全剔 → 跳过 PVS，仅按距离 LOD
      const pvsActive = pvs !== null && pvs.enabled;
      const pvsClusterValid = pvs !== null && pvs.currentClusterId >= 0;
      for (const item of this.lodItems) {
        const dist = item.center.distanceTo(camPos);
        let level = LOD_NEAR;
        if (dist > this.cullDistance) {
          level = LOD_FAR;
        } else if (
          pvsActive &&
          pvsClusterValid &&
          item.clusterIds.length > 0 &&
          !item.clusterIds.some((c) => pvs!.isVisible(c))
        ) {
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
