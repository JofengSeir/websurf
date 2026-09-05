/**
 * 场景层：renderer / scene / camera / 灯光 / GLB 挂载 / 空间分块合并 / 相机 near/far 自适应。
 * 渲染方法与 game renderer-main 对齐：三点光、近平面贴墙自适应（无雾、far=maxDim×100）。
 * 不持有输入与位姿状态（那些在 fly.ts），只提供挂载与渲染能力。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  BG_COLOR,
  CAMERA_FAR_SCALE,
  CAMERA_INIT_FAR,
  CAMERA_INIT_NEAR,
  CAMERA_NEAR_MIN,
  FOV,
  NEAR_PROBE_DIST,
  NEAR_RATIO,
} from './constants.js';

const OPT_TARGET_CELLS = 512;
const OPT_MIN_CELLS = 300;
const OPT_MAX_CELLS = 800;
const OPT_CELL_MIN = 128;
const OPT_CELL_MAX = 4096;
/** 视锥外保留圈（frustum culling 包围球膨胀系数）：快移/猛转时新入视锥几何已预渲染。 */
const FRUSTUM_PAD = 1.6;

function optCellKey(x: number, y: number, z: number, cellSize: number): string {
  return Math.floor(x / cellSize) + '|' + Math.floor(y / cellSize) + '|' + Math.floor(z / cellSize);
}

export class ViewerScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  /** 已挂载的 BSP 模型根（重复加载时先 dispose 旧的）。 */
  private modelRoot: THREE.Object3D | null = null;
  private readonly gltfLoader = new GLTFLoader();

  // ── 近平面贴墙自适应（同步 game renderer-main；防贴墙/贴地近平面裁剪）──
  /** 地图加载后的场景默认 near（maxDim/1000，下限 CAMERA_NEAR_MIN）。 */
  private defaultNear = CAMERA_INIT_NEAR;
  /** 探测距离（HU）；↑ 更斜掠射也能命中。 */
  private nearProbeDist = NEAR_PROBE_DIST;
  /** near 收缩系数；↓ 更保守更不易裁墙。 */
  private nearRatio = NEAR_RATIO;
  private nearCheckToggle = false;
  private readonly _nearOrigin = new THREE.Vector3();
  private readonly _nearSphere = new THREE.Sphere();
  private readonly _nearDirF = new THREE.Vector3();
  private readonly _nearDirR = new THREE.Vector3();
  private readonly _nearRaycaster = new THREE.Raycaster();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG_COLOR);

    this.camera = new THREE.PerspectiveCamera(
      FOV,
      canvas.clientWidth / Math.max(canvas.clientHeight, 1),
      CAMERA_INIT_NEAR,
      CAMERA_INIT_FAR,
    );
    this.camera.position.set(0, 0, 0);

    // 灯光与 game renderer-main 相同的三点光组合（渲染观感一致）
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    this.scene.add(new THREE.HemisphereLight(0xb0c4de, 0x404030, 0.4));
    const dirLight = new THREE.DirectionalLight(0xfff4e0, 0.5);
    dirLight.position.set(100, 200, 100);
    this.scene.add(dirLight);
  }

  hasModel(): boolean {
    return this.modelRoot !== null;
  }

  /** 已挂载的地图根节点（拾取/量测用；无地图时为 null）。 */
  get model(): THREE.Object3D | null {
    return this.modelRoot;
  }

  /** 当前地图世界包围盒（无地图时返回 null）。 */
  worldBox(): THREE.Box3 | null {
    if (!this.modelRoot) return null;
    return new THREE.Box3().setFromObject(this.modelRoot);
  }

  resize(canvas: HTMLCanvasElement): void {
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.camera.aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    // 近平面贴墙自适应（每 2 帧，同 game）：贴墙/贴地收缩 near 防近平面裁剪透视
    this.nearCheckToggle = !this.nearCheckToggle;
    if (this.nearCheckToggle && this.modelRoot) {
      this.updateNearPlane();
    }
    this.renderer.render(this.scene, this.camera);
  }

  add(obj: THREE.Object3D): void {
    this.scene.add(obj);
  }

  remove(obj: THREE.Object3D): void {
    this.scene.remove(obj);
  }

  /** 挂载 GLB（替换旧地图），并做分块合并 + 相机 near/far 自适应。 */
  async mountGlb(glbBytes: ArrayBuffer): Promise<void> {
    const copy = new Uint8Array(glbBytes.byteLength);
    copy.set(new Uint8Array(glbBytes));
    const url = URL.createObjectURL(new Blob([copy], { type: 'model/gltf-binary' }));
    let gltf: GLTF;
    try {
      gltf = await this.gltfLoader.loadAsync(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    if (this.modelRoot) {
      disposeObject(this.modelRoot);
      this.scene.remove(this.modelRoot);
      this.modelRoot = null;
    }

    const root = new THREE.Group();
    resetRootRotations(gltf);
    root.add(gltf.scene);
    this.scene.add(root);
    this.modelRoot = root;

    // 渲染减负：空间分块合并（GLB 数千~数万 primitive Mesh → ~数百块）
    this.optimizeScene();
    this.fitCamera();
  }

  /**
   * 相机 near/far 按地图尺寸自适应（与 game loadScene 同法；无雾）。
   * - near 默认 = maxDim/1000（下限 CAMERA_NEAR_MIN），贴墙由 updateNearPlane 进一步收缩
   * - far = maxDim × CAMERA_FAR_SCALE（基本无远裁剪；原 diag×2 + 65536 截断会裁掉超大地图远景）
   */
  fitCamera(): void {
    const box = this.worldBox();
    if (!box) return;
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    this.defaultNear = Math.max(maxDim / 1000, CAMERA_NEAR_MIN);
    this.camera.near = this.defaultNear;
    this.camera.far = Math.max(maxDim * CAMERA_FAR_SCALE, CAMERA_INIT_FAR);
    this.camera.updateProjectionMatrix();
  }

  /**
   * 近平面自适应（同步 game renderer-main.updateNearPlane）：以相机为原点，向
   * 相机局部系 6 方向（前/后/左/右/上/下——game 为 4 水平方向，查看器自由飞行
   * 会贴地/贴顶，补垂直两向）探测 NEAR_PROBE_DIST 内最近的几何，动态设置 near。
   * - 贴近几何 → near = 最近距离 × nearRatio（下限 CAMERA_NEAR_MIN），不被近平面裁剪
   * - 空旷 → 恢复场景默认 defaultNear
   * 性能：包围球粗筛候选（仅 BSP 模型子树）后做 raycaster，每 2 帧一次。
   */
  private updateNearPlane(): void {
    if (!this.modelRoot) return;
    const camera = this.camera;
    const probe = this.nearProbeDist;
    this._nearOrigin.copy(camera.position);

    // 1. 包围球粗筛（BSP 模型子树）
    const candidates: THREE.Mesh[] = [];
    this.modelRoot.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
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

    // 2. 相机局部基向量 + 6 方向探测最近几何
    let minD = Infinity;
    if (candidates.length > 0) {
      const q = camera.quaternion;
      this._nearDirF.set(0, 0, -1).applyQuaternion(q);
      const right = this._nearDirR.set(1, 0, 0).applyQuaternion(q);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const dirs = [
        this._nearDirF,
        this._nearDirF.clone().negate(),
        right.clone(),
        right.clone().negate(),
        up,
        up.clone().negate(),
      ];
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

    // 3. 设定 near（贴近几何收缩，空旷恢复默认）
    const target = isFinite(minD)
      ? Math.max(minD * this.nearRatio, CAMERA_NEAR_MIN)
      : this.defaultNear;
    if (Math.abs(camera.near - target) > 0.001) {
      camera.near = target;
      camera.updateProjectionMatrix();
    }
  }

  /**
   * 空间分块合并（移植自 test/dual-mode-harness worker-b.ts，已验证）。
   * GLTFLoader 每 primitive 一个 THREE.Mesh：surf 地图 GLB 可达 ~3.4 万 Mesh，
   * 分块合并把数万 Mesh → ~数百空间块（块内按材质子合并）。
   * 遍历范围收敛到 BSP 模型子树（与 game optimizeScene 的 bspRoot 一致）——
   * 回放轨迹/量测辅助对象挂在场景层，不参与分块合并。
   */
  private optimizeScene(): void {
    if (!this.modelRoot) return;
    this.scene.updateMatrixWorld(true);
    const infos: Array<{ mesh: THREE.Mesh; cx: number; cy: number; cz: number }> = [];
    const keptMeshes: THREE.Mesh[] = [];
    const worldBox = new THREE.Box3();
    const box = new THREE.Box3();
    const center = new THREE.Vector3();
    this.modelRoot.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (!m.isMesh) return;
      if (!m.geometry || !m.geometry.attributes.position) return;
      if (Array.isArray(m.material) || !m.material) {
        const baked = m.geometry.clone();
        baked.applyMatrix4(m.matrixWorld);
        m.geometry.dispose();
        m.geometry = baked;
        m.position.set(0, 0, 0);
        m.rotation.set(0, 0, 0);
        m.scale.set(1, 1, 1);
        m.updateMatrix();
        keptMeshes.push(m);
        return;
      }
      const g = m.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      if (!g.boundingBox) return;
      box.copy(g.boundingBox).applyMatrix4(m.matrixWorld);
      worldBox.union(box);
      box.getCenter(center);
      infos.push({ mesh: m, cx: center.x, cy: center.y, cz: center.z });
    });

    if (infos.length === 0) {
      if (keptMeshes.length > 0 && this.modelRoot) {
        this.scene.remove(this.modelRoot);
        const root = new THREE.Group();
        for (const m of keptMeshes) root.add(m);
        this.scene.add(root);
        this.modelRoot = root;
      }
      return;
    }

    const diag = Math.max(worldBox.getSize(new THREE.Vector3()).length(), 1);
    let cellSize = Math.min(Math.max(diag / Math.cbrt(OPT_TARGET_CELLS), OPT_CELL_MIN), OPT_CELL_MAX);
    const countCells = (size: number): number => {
      const set = new Set<string>();
      for (const it of infos) set.add(optCellKey(it.cx, it.cy, it.cz, size));
      return set.size;
    };
    for (let i = 0; i < 6; i++) {
      const n = countCells(cellSize);
      if (n >= OPT_MIN_CELLS && n <= OPT_MAX_CELLS) break;
      const scale = Math.min(Math.max(Math.cbrt(n / OPT_TARGET_CELLS), 0.55), 1.8);
      cellSize = Math.min(Math.max(cellSize * scale, OPT_CELL_MIN), OPT_CELL_MAX);
    }

    const cells = new Map<string, typeof infos>();
    for (const it of infos) {
      const key = optCellKey(it.cx, it.cy, it.cz, cellSize);
      let arr = cells.get(key);
      if (!arr) {
        arr = [];
        cells.set(key, arr);
      }
      arr.push(it);
    }

    const optRoot = new THREE.Group();
    for (const arr of cells.values()) {
      if (arr.length === 1) {
        const m = arr[0].mesh;
        const baked = m.geometry.clone();
        baked.applyMatrix4(m.matrixWorld);
        m.geometry.dispose();
        m.geometry = baked;
        m.position.set(0, 0, 0);
        m.rotation.set(0, 0, 0);
        m.scale.set(1, 1, 1);
        m.updateMatrix();
        optRoot.add(m);
        continue;
      }
      const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
      for (const it of arr) {
        const m = it.mesh;
        const baked = m.geometry.clone();
        baked.applyMatrix4(m.matrixWorld);
        let list = byMat.get(m.material as THREE.Material);
        if (!list) {
          list = [];
          byMat.set(m.material as THREE.Material, list);
        }
        list.push(baked);
      }
      const mergedGeoms: THREE.BufferGeometry[] = [];
      const mats: THREE.Material[] = [];
      for (const [mat, geoms] of byMat) {
        const mg = mergeGeometries(geoms, false);
        if (mg) {
          for (const g of geoms) g.dispose();
          mergedGeoms.push(mg);
          mats.push(mat);
        } else {
          for (const g of geoms) {
            mergedGeoms.push(g);
            mats.push(mat);
          }
        }
      }
      if (mergedGeoms.length === 0) {
        for (const it of arr) it.mesh.geometry.dispose();
        continue;
      }
      if (mergedGeoms.length === 1) {
        optRoot.add(new THREE.Mesh(mergedGeoms[0], mats[0]));
      } else {
        const final = mergeGeometries(mergedGeoms, true);
        if (final) {
          for (const g of mergedGeoms) if (g !== final) g.dispose();
          optRoot.add(new THREE.Mesh(final, mats));
        } else {
          optRoot.add(new THREE.Mesh(mergedGeoms[0], mats[0]));
        }
      }
      for (const it of arr) it.mesh.geometry.dispose();
    }
    for (const m of keptMeshes) optRoot.add(m);

    // 视锥外保一圈：块包围球半径 ×FRUSTUM_PAD（烘焙后须重算包围球，否则剔除按旧局部空间判定）
    for (const child of optRoot.children) {
      const g = (child as THREE.Mesh).geometry;
      if (!g) continue;
      g.computeBoundingSphere();
      const sphere = g.boundingSphere;
      if (sphere) sphere.radius *= FRUSTUM_PAD;
    }

    if (this.modelRoot) this.scene.remove(this.modelRoot);
    this.scene.add(optRoot);
    this.modelRoot = optRoot;
  }
}

/** 释放模型几何/材质/纹理（防重复加载泄漏）。 */
export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      if (!mat) continue;
      const map = (mat as unknown as { map?: THREE.Texture | null }).map;
      if (map?.isTexture) map.dispose();
      mat.dispose();
    }
  });
}

/** 清除 GLB 根子节点旋转（与 game renderer-main resetRootRotations 同法）。 */
function resetRootRotations(gltf: GLTF): void {
  for (const child of gltf.scene.children) {
    if (child.rotation.x !== 0 || child.rotation.y !== 0 || child.rotation.z !== 0) {
      child.rotation.set(0, 0, 0);
      child.updateMatrixWorld();
    }
  }
  gltf.scene.updateMatrixWorld(true);
}
