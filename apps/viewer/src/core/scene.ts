/**
 * 场景层：renderer / scene / camera / 灯光 / GLB 挂载 / 空间分块合并 / near-far 自适应。
 *
 * 顺序敏感的不变量：
 * 1. `mountGlb` 内必须**先施加静态光照再做分块合并**——合并按材质实例分组，合并后再换材质
 *    会让分组失效，并丢掉逐 primitive 的 hasLightmap 与 UV1（TEXCOORD_1）映射；
 * 2. 静态光照参数只在构造时写入共享 uniform 一次，此后仅 `setLightingMode` 会再改；
 * 3. `modelRoot` 是唯一的地图根句柄：`worldBox`、`updateNearPlane`、`optimizeScene`
 *    以及换图时的释放都以它为范围。
 *
 * 公开面：只读字段 `renderer` / `scene` / `camera`；方法 `mountGlb`、`render`、`resize`、
 * `add` / `remove`（场景层挂件）、`hasModel` / `model` / `worldBox`、`setLightingMode` /
 * `getLightingMode`；模块级另有 `disposeObject`。
 * `constructor` 建 WebGL 渲染器（antialias、像素比上限 2、sRGB 输出色空间）、透视相机与
 * 三点光；`render` 每帧做一次近平面自适应检查后交给 three 绘制；`add` / `remove` 只转发到
 * `scene`，供回放可视化挂轨迹线与幽灵；`disposeObject` 是换图时的显存释放入口。
 *
 * 与 game renderer-main 对齐：三点光组合、近平面贴墙自适应、far = maxDim × 100（本工程另加 CAMERA_INIT_FAR 下限）；
 * 差异：本工程不建雾、无 LOD 与自动裁剪，相机由 `FlyCam` 驱动——本文件不持有输入与位姿状态。
 *
 * 调用方：`apps/viewer/src/app.ts`（`loadBsp` → `mountGlb` / `worldBox`、帧循环 → `render`、
 * resize 事件 → `resize`、光照模式面板回调 → `setLightingMode`）与
 * `apps/viewer/src/replay/visuals.ts`（`add` / `remove` 挂放轨迹线与幽灵）。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  applyLightmapToMeshes,
  fullbrightUnlitLitMaterials,
  loadLightmapAtlas,
  setAmbientScale,
  setExposure,
  setLightGamma,
  setLightingMode as setLightingModeInShader,
  setPropVertexFlatten,
  setPropVertexRelax,
  getLightingMode,
  type LightingMode,
} from '../renderer/lightmap-shader.js';
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
// ── 分块合并调参（只被 `optimizeScene` 读）──
// OPT_TARGET_CELLS 是目标块数，用来推初始块边长（diag / 立方根）；可接受块数区间是
// [OPT_MIN_CELLS, OPT_MAX_CELLS]，块边长本身夹在 [OPT_CELL_MIN, OPT_CELL_MAX] 之间。
/** 视锥外保留圈（frustum culling 的包围球膨胀系数）：快移 / 猛转时新入视锥的几何已预渲染。 */
const FRUSTUM_PAD = 1.6;
/** 默认光照模式 = 预烘焙（构造时写入共享 uniform；地图页光照模式下拉可切纯纹理）。 */
const DEFAULT_LIGHTING_MODE: LightingMode = 'baked';

function optCellKey(x: number, y: number, z: number, cellSize: number): string {
  return Math.floor(x / cellSize) + '|' + Math.floor(y / cellSize) + '|' + Math.floor(z / cellSize);
}

export class ViewerScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  /** 已挂载的 BSP 模型根（换图时先 `disposeObject` 再挂新的）。 */
  private modelRoot: THREE.Object3D | null = null;
  private readonly gltfLoader = new GLTFLoader();

  // ── 近平面贴墙自适应（与 game 的 updateNearPlane 同法；防贴墙 / 贴地裁剪）──
  /** 场景默认 near：`fitCamera` 写成 max(maxDim / 1000, CAMERA_NEAR_MIN)；空旷时用它复位。 */
  private defaultNear = CAMERA_INIT_NEAR;
  /** 探测距离（HU）：射线 far 的上限，值越大越容易命中斜掠射的面。 */
  private nearProbeDist = NEAR_PROBE_DIST;
  /** near 收缩系数：越小越保守（near 越贴近相机，越不易裁墙）。 */
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

    // 静态光照（预烘焙）参数：与 `apps/game/src/renderer/renderer-main.ts` 初始化装配同值
    // —— exposure 2.3 / lightGamma 2.2 / ambientScale 1 / propVertexRelax 1 / propVertexFlatten 0.85。
    // 数值出处是 `apps/game/src/config.ts` 的 `DEFAULT_CONFIG.lighting`：本工程没有面板持久化，
    // 直接取同一组默认值，使同一张地图在两端观感一致。
    // 注意 `setLightGamma` 只接受 (0, 1] 的入参 ⇒ 这里的 2.2 会被它忽略、共享 uniform 保持初值 1；
    // 其余四项都落在各自接受窗口内（`setPropVertexFlatten` 另会把值钳到上限 1）。
    setExposure(2.3);
    setLightGamma(2.2);
    setAmbientScale(1);
    setPropVertexRelax(1);
    setPropVertexFlatten(0.85);
    setLightingModeInShader(DEFAULT_LIGHTING_MODE);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG_COLOR);

    this.camera = new THREE.PerspectiveCamera(
      FOV,
      canvas.clientWidth / Math.max(canvas.clientHeight, 1),
      CAMERA_INIT_NEAR,
      CAMERA_INIT_FAR,
    );
    this.camera.position.set(0, 0, 0);

    // 灯光：与 game renderer-main 同款三点光组合（环境光 + 半球光 + 定向光）
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    this.scene.add(new THREE.HemisphereLight(0xb0c4de, 0x404030, 0.4));
    const dirLight = new THREE.DirectionalLight(0xfff4e0, 0.5);
    dirLight.position.set(100, 200, 100);
    this.scene.add(dirLight);
  }

  hasModel(): boolean {
    return this.modelRoot !== null;
  }

  /** 已挂载的地图根节点（拾取 / 量测用；无地图时为 null）。 */
  get model(): THREE.Object3D | null {
    return this.modelRoot;
  }

  /** 当前地图的世界包围盒（由 `modelRoot` 现算；无地图时为 null）。 */
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
    // 近平面贴墙自适应：每 2 帧做一次（`nearCheckToggle` 交替），贴墙 / 贴地时收缩 near
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

  /** 挂载 GLB（替换旧地图）：解析 → 施加静态光照 → 分块合并 → `fitCamera`。 */
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

    // 静态光照（预烘焙，默认）必须赶在 optimizeScene 之前：分块合并按材质实例分组，
    // 换过材质的图元一旦留到合并之后才处理，分组与逐 primitive 的 UV1 映射都会失配。
    await this.applyStaticLighting(gltf, root);

    // 渲染减负：空间分块合并（GLTFLoader 逐 primitive 建 Mesh，这里按空间块归并）
    this.optimizeScene();
    this.fitCamera();
  }

  /**
   * 施加离线烘焙静态光照（与 apps/game 同一条链路、同一份 GLB 契约）：
   * - 图集来自 `asset.extras.lightmap.textureIndex`，缺失时回落 `scene.userData.extras`，
   *   解析单点是 `apps/viewer/src/renderer/lightmap-shader.ts` 的 `loadLightmapAtlas`；
   * - `applyLightmapToMeshes` 逐图元路由：世界面走 lightmap 采样、带 `_VBSP_VLIGHT` 的 prop
   *   走逐顶点烘焙、其余 prop 走 leaf ambient cube；
   * - 终扫由 `fullbrightUnlitLitMaterials` 把仍是 GLTF 原 Standard 材质的图元收敛为贴图原色。
   * 结束后打一条 `[viewer][lightmap]` 日志（模式、图集尺寸、施加数、终扫数）。
   * 失败只告警不阻断：无图集或中途抛错时地图仍可看（纯贴图原色）。
   */
  private async applyStaticLighting(gltf: GLTF, root: THREE.Object3D): Promise<void> {
    try {
      const atlas = await loadLightmapAtlas(gltf.parser, gltf);
      if (!atlas) {
        console.info('[viewer][lightmap] GLB 未携带 atlas（asset.extras.lightmap 缺失），跳过静态光照');
        return;
      }
      const applied = applyLightmapToMeshes(root, atlas);
      const swept = fullbrightUnlitLitMaterials(root);
      const image = atlas.image as { width?: number; height?: number } | undefined;
      console.info(
        `[viewer][lightmap] 光照模式=${getLightingMode()}，atlas ${image?.width ?? 0}×${image?.height ?? 0}，` +
          `施加 mesh=${applied}，终扫收敛=${swept}`,
      );
    } catch (err) {
      console.error('[viewer][lightmap] 施加静态光照失败:', err);
    }
  }

  /**
   * 切换光照模式（面板「预烘焙 / 纯纹理」）：只改共享 uniform，下一次绘制即生效。
   *
   * 语义与 `apps/viewer/src/renderer/lightmap-shader.ts` 的 `LightingMode` 一致：
   * 预烘焙 = 每像素采图集并算逐顶点 / 环境盒烘焙项（有明暗关系，每帧开销更大）；
   * 纯纹理 = 只上漫反射贴图（不采图集、不算烘焙项，移动时更平稳）。
   * 两种模式共用同一条加载路径 ⇒ 切换不重建场景、不重编译材质、不打断视角；
   * 传入与当前相同的模式时提前返回，不重复写 uniform。
   */
  setLightingMode(mode: LightingMode): void {
    if (getLightingMode() === mode) return;
    setLightingModeInShader(mode);
    console.info(`[viewer][lighting] 光照模式 → ${mode}（运行期 uniform 切换，未重建场景）`);
  }

  /** 当前光照模式（面板回填 / 诊断用）。 */
  getLightingMode(): LightingMode {
    return getLightingMode();
  }

  /**
   * 相机 near / far 按地图尺寸自适应；无地图时直接返回（保持构造值）。
   * - near = max(maxDim / 1000, CAMERA_NEAR_MIN)，同时记为 `defaultNear` 供 `updateNearPlane` 复位
   * - far = max(maxDim × CAMERA_FAR_SCALE, CAMERA_INIT_FAR)
   * 两个尺寸都取自 `worldBox()`，改完调用 `updateProjectionMatrix`。
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
   * 近平面自适应：以相机为原点，沿相机局部系的 6 个方向（前 / 后 / 左 / 右 / 上 / 下）探测
   * `nearProbeDist` 内最近的几何，据此调整 near——game 只探 4 个水平方向，本工程是自由飞行、
   * 会贴地 / 贴顶，故补上垂直两向。
   * - 命中：near = max(最近距离 × `nearRatio`, CAMERA_NEAR_MIN)
   * - 全空：near 复位为 `defaultNear`
   * 两步实现：先按包围球（`boundingSphere` 经 `matrixWorld` 变换）粗筛候选，候选只取
   * `modelRoot` 子树；再对候选跑 raycaster。目标值与 `camera.near` 相差不足 0.001 时不写回。
   * 调用频率：`render` 每 2 帧一次；无地图时直接返回。
   */
  private updateNearPlane(): void {
    if (!this.modelRoot) return;
    const camera = this.camera;
    const probe = this.nearProbeDist;
    this._nearOrigin.copy(camera.position);

    // 1. 包围球粗筛：只把 modelRoot 子树里够得着探测范围的 Mesh 收进候选
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

    // 2. 取相机局部基向量，沿 6 个方向各打一条射线，记录最近命中距离
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

    // 3. 定 near：贴近几何则收缩、空旷则复位；变化不足 0.001 就跳过写回
    const target = isFinite(minD)
      ? Math.max(minD * this.nearRatio, CAMERA_NEAR_MIN)
      : this.defaultNear;
    if (Math.abs(camera.near - target) > 0.001) {
      camera.near = target;
      camera.updateProjectionMatrix();
    }
  }

  /**
   * 空间分块合并：把 GLTFLoader 逐 primitive 建出来的 Mesh 按空间网格并块，块内再按材质实例
   * 子合并，把上万级绘制批次压到块的数量级。
   *
   * 步骤与边界：
   * - 遍历范围只到 `modelRoot` 子树（回放的轨迹线 / 辅助对象挂在场景层，不参与合并）；
   * - 材质是数组或缺失、以及没有 position 属性的 Mesh 不参与合并，但仍会被搬到新根节点下
   *   （几何先烘进世界坐标）；
   * - 块边长从 `diag / 立方根(OPT_TARGET_CELLS)` 起步，按实测块数迭代至多 6 次逼近
   *   [OPT_MIN_CELLS, OPT_MAX_CELLS]；分块键由 `optCellKey` 用「坐标 / 边长」向下取整拼出；
   * - 块内材质子合并失败（属性不兼容）时保留全部子块，不丢几何；
   * - 合并后逐块重算包围球并把半径乘 `FRUSTUM_PAD`（几何已烘成世界坐标，旧包围球不再适用）。
   *
   * 副作用：旧 `modelRoot` 从场景移除、由新根节点接管；被合并掉的原始几何会 dispose。
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
          // 最终合并失败（属性不兼容，如 indexed / non-indexed 混合）：逐块全部保留；
          // 只留第一块会把该 cell 其余几何静默丢掉（画面缺块）。
          for (let i = 0; i < mergedGeoms.length; i++) {
            optRoot.add(new THREE.Mesh(mergedGeoms[i], mats[i]));
          }
        }
      }
      for (const it of arr) it.mesh.geometry.dispose();
    }
    for (const m of keptMeshes) optRoot.add(m);

    // 视锥外保一圈：块包围球半径 × FRUSTUM_PAD（几何已烘成世界坐标，故须重算包围球）
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

/**
 * 释放模型几何 / 材质 / 纹理（换图前先调它，防显存泄漏）。
 * 每个材质释放 `map` 与 `lightMap` 两张纹理（dispose 后再次加载会重新上传），再 dispose
 * 材质本身；非 Mesh 节点跳过。本仓当前只在 `mountGlb` 换图时调用。
 */
export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      if (!mat) continue;
      const holder = mat as unknown as { map?: THREE.Texture | null; lightMap?: THREE.Texture | null };
      const map = holder.map;
      if (map?.isTexture) map.dispose();
      // lightmap 图集同样要释放：viewer 是反复换图的工具，漏掉它每张图都会多留一份图集
      // 纹理占用显存（与 map 同为 GLTF 纹理，dispose 后再次加载会重新上传）。
      const lightMap = holder.lightMap;
      if (lightMap?.isTexture) lightMap.dispose();
      mat.dispose();
    }
  });
}

/** 清除 GLB 根子节点的旋转（与 `apps/game/src/renderer/renderer-main.ts` 的 `resetRootRotations` 同法）。 */
function resetRootRotations(gltf: GLTF): void {
  for (const child of gltf.scene.children) {
    if (child.rotation.x !== 0 || child.rotation.y !== 0 || child.rotation.z !== 0) {
      child.rotation.set(0, 0, 0);
      child.updateMatrixWorld();
    }
  }
  gltf.scene.updateMatrixWorld(true);
}
