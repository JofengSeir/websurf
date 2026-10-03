/**
 * 近平面贴墙自适应控制器：防贴墙时 near 裁掉墙面、透视看到地图外。
 *
 * 2026-10-02 自 apps/game/src/renderer/renderer-main.ts 的 updateNearPlane 私有方法与（现居渲染共享层，
 * game 经 tsconfig include 收编）nearProbeDist / nearRatio / defaultNear 字段及五个复用探测对象原样抽出（逻辑零改动；
 * camera / scene 由调用方每次传入，不再读渲染器类字段）。由 renderer-main 的 `tick`
 * 每 2 帧调用一次 `update`（节流开关留在调用方）。
 */
import * as THREE from 'three';

/** near 允许的最小值（收缩与默认值都不得低于它）。 */
const CAMERA_NEAR_MIN = 0.05;
/** 探测距离默认值（HU）：`update` 的射线长度上限与包围球粗筛半径都由它推出。 */
const NEAR_PROBE_DIST_DEFAULT = 100;
/** near 收缩系数默认值：命中几何时 near = 命中距离 × 本值。 */
const NEAR_RATIO_DEFAULT = 0.3;

/** `update` 的可选参数：`roots` 给出候选收集的根子树（省略时按 game 口径取 `scene.children` 里带 `isBspModel` 标记的根）；`vertical` 为 true 时补上/下两个垂直探测方向（自由飞行相机要贴地/贴顶，viewer 用）。 */
export interface NearPlaneOptions {
  roots?: THREE.Object3D[];
  vertical?: boolean;
}

export class NearPlaneController {
  /** 探测距离（HU，`setParams` 可改；面板「近平面探测距离」量程 16..128）。 */
  private nearProbeDist = NEAR_PROBE_DIST_DEFAULT;
  /** near 收缩系数（`setParams` 可改，只接受 (0, 1]；面板量程 0.1..1）。 */
  private nearRatio = NEAR_RATIO_DEFAULT;
  /** 场景默认 near（`setDefaultNear` 由 loadScene 按 maxDim/1000 落账）；探测无命中时恢复它。 */
  private defaultNear = 0.1;
  /** 复用的探测对象（避免每帧分配）：射线起点、粗筛用包围球、相机前/右方向、raycaster。 */
  private readonly _nearOrigin = new THREE.Vector3();
  private readonly _nearSphere = new THREE.Sphere();
  private readonly _nearDirF = new THREE.Vector3();
  private readonly _nearDirR = new THREE.Vector3();
  private readonly _nearRaycaster = new THREE.Raycaster();

  /** 场景默认 near：maxDim/1000，下限 CAMERA_NEAR_MIN（loadScene 算 near/far 用）。 */
  static defaultNearForScene(maxDim: number): number {
    return Math.max(maxDim / 1000, CAMERA_NEAR_MIN);
  }

  /** 落账场景默认 near（探测无命中时 `update` 恢复到它）。 */
  setDefaultNear(v: number): void {
    this.defaultNear = v;
  }

  /** 面板实时调整探测距离与收缩系数：两项都只在传入正数时写，ratio 还需 ≤ 1；下一帧探测生效。 */
  setParams(probeDist?: number, ratio?: number): void {
    if (probeDist !== undefined && probeDist > 0) {
      this.nearProbeDist = probeDist;
    }
    if (ratio !== undefined && ratio > 0 && ratio <= 1) {
      this.nearRatio = ratio;
    }
  }

  /**
   * 近平面自适应：以 (px, py, pz) 为射线起点，沿相机局部系的前/后/左/右四个水平方向在
   * `nearProbeDist` 内探测最近的 BSP mesh；命中则把 `camera.near` 收到
   * max(命中距离 × nearRatio, CAMERA_NEAR_MIN)，无命中恢复 `defaultNear`。
   * 粗筛：包围球中心到起点的距离 < 探测距离 × 2 + 球半径 的 mesh 才进入射线检测。
   * 只写 `camera.near`（变化超过 0.001 才更新投影矩阵）；由 `tick` 每 2 帧调用一次。
   */
  update(camera: THREE.PerspectiveCamera | null, scene: THREE.Object3D | null, px: number, py: number, pz: number, opts?: NearPlaneOptions): void {
    if (!camera || !scene) return;
    const probe = this.nearProbeDist;
    this._nearOrigin.set(px, py, pz);

    // 1. 包围球粗筛（game：scene.children 里带 isBspModel 标记的根；viewer：opts.roots 直通，
    //    通常是地图 modelRoot 子树——不要求 isBspModel 标记）
    const candidates: THREE.Mesh[] = [];
    const collectRoots = opts?.roots ?? Array.from(scene.children).filter((r) => r.userData?.isBspModel);
    for (const root of collectRoots) {
      root.traverse((obj) => {
        if (!(obj as THREE.Mesh).isMesh) return;
        const mesh = obj as THREE.Mesh;
        const geom = mesh.geometry as THREE.BufferGeometry | null;
        if (!geom) return;
        if (!geom.boundingSphere) geom.computeBoundingSphere();
        const bs = geom.boundingSphere;
        if (!bs) return;
        this._nearSphere.copy(bs).applyMatrix4(mesh.matrixWorld);
        if (this._nearSphere.center.distanceTo(this._nearOrigin) < probe * 2 + this._nearSphere.radius) {
          candidates.push(mesh);
        }
      });
    }

    // 2. 相机局部基向量 + 4 水平正交方向探测最近几何；opts.vertical 为 true 时补上/下两向
    //    （自由飞行相机会贴地/贴顶——viewer 用；game 只探水平，保持 4 向）
    let minD = Infinity;
    if (candidates.length > 0) {
      const q = camera.quaternion;
      this._nearDirF.set(0, 0, -1).applyQuaternion(q);
      const right = this._nearDirR.set(1, 0, 0).applyQuaternion(q);
      const dirs = [
        this._nearDirF,
        this._nearDirF.clone().negate(),
        right.clone(),
        right.clone().negate(),
      ];
      if (opts?.vertical) {
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
        dirs.push(up, up.clone().negate());
      }
      for (const dir of dirs) {
        this._nearRaycaster.set(this._nearOrigin, dir);
        this._nearRaycaster.near = 0;
        this._nearRaycaster.far = probe;
        const hits = this._nearRaycaster.intersectObjects(candidates, false);
        if (hits.length > 0 && hits[0].distance < minD) {
          minD = hits[0].distance;
        }
      }
    }

    // 3. 设定 near（贴墙收缩，空旷恢复默认）
    const target =
      isFinite(minD)
        ? Math.max(minD * this.nearRatio, CAMERA_NEAR_MIN)
        : this.defaultNear;
    if (Math.abs(camera.near - target) > 0.001) {
      camera.near = target;
      camera.updateProjectionMatrix();
    }
  }
}
