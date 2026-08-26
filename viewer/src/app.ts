/**
 * WebSurf-viewer — 最小 BSP 自由视角查看器。
 *
 * 仅自由视角（无物理/碰撞/面板）：BSP → GLB 场景 + 飞行相机。
 * 位姿（人物位置 + 视角）传入三通道，应用即生效（流程响应最快）：
 * - URL 查询参数 `?pos=x,y,z&ang=yaw,pitch`（页面加载时应用）
 * - URL hash `#pos=x,y,z&ang=yaw,pitch`（hashchange 实时应用，外部工具改 location.hash 即响应）
 * - JS API `window.viewer.setPose(...)` / `window.viewer.getPose()`（直接调用）
 *
 * 位姿约定（与 game 一致）：
 * - pos = 人物脚底位置（Y-up 世界坐标，GLB 空间）；相机眼位 = pos + EYE_STAND(64.09)
 * - ang = [yawDeg, pitchDeg]；yaw 0 = 面朝 -Z，正方向逆时针（俯视），即 game 的
 *   cs-movement yaw 约定（BSP yaw 需经 bspYawToCsYaw 转换）；pitch 正 = 仰视，±89° 限幅
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BspProcessor, initSync } from '../pkg/websurf_viewer_wasm.js';

// ── 常量 ─────────────────────────────────────────────────────────────
const DEG2RAD = Math.PI / 180;
/** 固定站立眼高（HU，与 game EYE_STAND 一致）。pos 为脚底，相机 y = pos.y + EYE_STAND。 */
const EYE_STAND = 64.09;
/** FOV（度）。 */
const FOV = 73.6;
const CAMERA_NEAR = 1;
const CAMERA_FAR_MAX = 65536;
const CAMERA_FAR_MIN = 4096;
const BG_COLOR = 0x0d1b2a;
/** 飞行速度（HU/s）；Shift ×4。 */
const FLY_SPEED = 500;
const FLY_SPEED_FAST = FLY_SPEED * 4;
/** 鼠标灵敏度（rad/px）。 */
const MOUSE_SENS = 0.0022;
const PITCH_LIMIT = 89 * DEG2RAD;
/** 指针锁定后丢弃下一个 mousemove（初始跳变通常 2000-5000+ px）。 */
const MOUSE_MAX_DELTA = 1000;

// ── 位姿类型与解析 ──────────────────────────────────────────────────
/** 位姿输入：pos = [x,y,z] 脚底位置；ang = [yawDeg, pitchDeg]。 */
interface Pose {
  pos: [number, number, number];
  ang: [number, number];
}

/** 兼容对象形式（外部工具常用）：{ pos: {x,y,z}, ang: {yaw,pitch} }。 */
interface PoseLike {
  pos: [number, number, number] | { x: number; y: number; z: number };
  ang: [number, number] | { yaw: number; pitch: number };
}

function normalizePose(input: PoseLike): Pose {
  const pos = Array.isArray(input.pos)
    ? [input.pos[0], input.pos[1], input.pos[2]]
    : [input.pos.x, input.pos.y, input.pos.z];
  const ang = Array.isArray(input.ang)
    ? [input.ang[0], input.ang[1]]
    : [input.ang.yaw, input.ang.pitch];
  return { pos: [pos[0], pos[1], pos[2]], ang: [ang[0], ang[1]] };
}

/** 从 URLSearchParams 解析 `pos=x,y,z&ang=yaw,pitch`（分隔符支持逗号/空白）。 */
function parsePoseParams(params: URLSearchParams): Pose | null {
  const posRaw = params.get('pos');
  const angRaw = params.get('ang');
  if (!posRaw || !angRaw) return null;
  const toNums = (s: string): number[] =>
    s
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => Number.isFinite(n));
  const pos = toNums(posRaw);
  const ang = toNums(angRaw);
  if (pos.length !== 3 || ang.length !== 2) return null;
  return { pos: [pos[0], pos[1], pos[2]], ang: [ang[0], ang[1]] };
}

// ── DOM ──────────────────────────────────────────────────────────────
const canvas = document.getElementById('game') as HTMLCanvasElement | null;
const bspFileInput = document.getElementById('bspFile') as HTMLInputElement | null;
const bspStatusEl = document.getElementById('bspStatus') as HTMLElement | null;
const poseEl = document.getElementById('pose') as HTMLElement | null;
const guideEl = document.getElementById('guide');
const guideBtn = document.getElementById('guideBtn') as HTMLButtonElement | null;
const guideErrorEl = document.getElementById('guideError');
const dropzoneEl = document.getElementById('dropzone');
const fatalEl = document.getElementById('fatal');
const fatalDetailEl = document.getElementById('fatalDetail');
const bspbarBtn = document.getElementById('bspbarBtn');
if (!canvas) throw new Error('canvas#game 未找到');

/** 启动失败兜底卡（WebGL 缺失等初始化期错误；资源加载缺失由 index.html 内联脚本覆盖）。 */
function showFatal(detail: string): void {
  if (!fatalEl || !fatalDetailEl) return;
  fatalDetailEl.textContent =
    detail +
    '\n\n建议：使用最新版 Chrome / Edge / Firefox（需 WebGL）；' +
    '若首次构建请先在 viewer/ 目录运行 npm install → npm run build:wasm → npm run build:ts。';
  fatalEl.classList.add('show');
}

/** 状态行临时闪现提示（约 3s 后恢复原文本，用于指针锁定失败等轻量反馈）。 */
function flashStatus(text: string, ms = 3000): void {
  if (!bspStatusEl) return;
  const prev = bspStatusEl.textContent;
  bspStatusEl.textContent = text;
  window.setTimeout(() => {
    if (bspStatusEl.textContent === text && prev !== null) bspStatusEl.textContent = prev;
  }, ms);
}

// ── THREE 初始化 ─────────────────────────────────────────────────────
let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
} catch (e) {
  showFatal(
    '无法创建 WebGL 渲染上下文（' + (e instanceof Error ? e.message : String(e)) + '）。\n' +
      '可能原因：浏览器禁用了 WebGL / 硬件加速未开启 / 显式驱动过旧。',
  );
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_COLOR);

const camera = new THREE.PerspectiveCamera(FOV, canvas.clientWidth / Math.max(canvas.clientHeight, 1), CAMERA_NEAR, CAMERA_FAR_MAX);
camera.position.set(0, EYE_STAND, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(100, 200, 100);
scene.add(dirLight);

/** 已挂载的 BSP 模型根（重复加载时先 dispose 旧的）。 */
let modelRoot: THREE.Object3D | null = null;

// ── 自由飞行状态（人物 = 相机；pos 为脚底，渲染时加眼高）──────────────
const fly = {
  pos: new THREE.Vector3(0, 0, 0),
  /** 弧度；0 = 面朝 -Z，正 = 逆时针（俯视）。 */
  yaw: 0,
  /** 弧度；正 = 仰视。 */
  pitch: 0,
};

let locked = false;
let discardNextMouse = false;
let mouseDx = 0;
let mouseDy = 0;
const keys = new Set<string>();

/** 外部显式传入的位姿（非空时覆盖出生点默认视角）。 */
let explicitPose: Pose | null = null;

/** 鼠标增量绝对削平（防事件合并/驱动异常跳变）。 */
function clampMouseDelta(v: number): number {
  return Math.max(-MOUSE_MAX_DELTA, Math.min(MOUSE_MAX_DELTA, v));
}

/** requestPointerLock 运行时签名（现代 Chromium 支持 options 并返回 Promise）。 */
type RequestPointerLockFn = (
  options?: { unadjustedMovement?: boolean },
) => Promise<void> | void;

function requestPointerLockWithUnadjusted(target: HTMLElement): void {
  const fn = target.requestPointerLock as unknown as RequestPointerLockFn;
  try {
    const result: unknown = fn.call(target, { unadjustedMovement: true });
    if (result && typeof (result as Promise<void>).then === 'function') {
      (result as Promise<void>).catch(() => {
        console.warn('[viewer] unadjustedMovement 不可用，降级为普通锁定');
        try {
          fn.call(target);
        } catch {
          /* 忽略降级失败 */
        }
      });
    }
  } catch {
    try {
      fn.call(target);
    } catch {
      /* 忽略 */
    }
  }
}

canvas.addEventListener('click', () => {
  if (!locked) requestPointerLockWithUnadjusted(canvas);
});

document.addEventListener('pointerlockerror', () => {
  console.warn('[viewer] Pointer Lock 请求失败');
  flashStatus('鼠标锁定失败，请再点击一次画布重试');
});

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  discardNextMouse = true;
  if (!locked) {
    mouseDx = 0;
    mouseDy = 0;
    keys.clear();
  }
});

window.addEventListener('mousemove', (e) => {
  if (!locked) return;
  if (discardNextMouse) {
    discardNextMouse = false;
    return;
  }
  mouseDx += clampMouseDelta(e.movementX);
  mouseDy += clampMouseDelta(e.movementY);
});

window.addEventListener('keydown', (e) => {
  if (!locked) return;
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight'].includes(e.code)) {
    e.preventDefault();
    keys.add(e.code);
  }
});

window.addEventListener('keyup', (e) => keys.delete(e.code));

window.addEventListener('blur', () => {
  keys.clear();
  mouseDx = 0;
  mouseDy = 0;
});

window.addEventListener('resize', () => {
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  camera.aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
  camera.updateProjectionMatrix();
});

// ── 位姿应用 / 查询 ─────────────────────────────────────────────────
/** 应用位姿：设置人物（脚底）位置 + 视角（yaw/pitch），立即生效。 */
function applyPose(pose: Pose): void {
  fly.pos.set(pose.pos[0], pose.pos[1], pose.pos[2]);
  fly.yaw = pose.ang[0] * DEG2RAD;
  fly.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pose.ang[1] * DEG2RAD));
  syncCamera();
  updatePoseHud();
}

/** 当前位姿（人物脚底位置 + 视角，度）。 */
function getPose(): Pose {
  return {
    pos: [fly.pos.x, fly.pos.y, fly.pos.z],
    ang: [fly.yaw / DEG2RAD, fly.pitch / DEG2RAD],
  };
}

function syncCamera(): void {
  camera.rotation.set(fly.pitch, fly.yaw, 0, 'YXZ');
  camera.position.set(fly.pos.x, fly.pos.y + EYE_STAND, fly.pos.z);
}

// window.viewer API：外部脚本实时传入/读取位姿（流程响应最快）
(globalThis as unknown as { viewer?: unknown }).viewer = {
  setPose(input: PoseLike): void {
    explicitPose = normalizePose(input);
    applyPose(explicitPose);
  },
  getPose(): PoseLike {
    return getPose();
  },
};

// URL hash：`#pos=x,y,z&ang=yaw,pitch`，hash 变更实时应用
window.addEventListener('hashchange', () => {
  const pose = parsePoseParams(new URLSearchParams(window.location.hash.slice(1)));
  if (pose) {
    explicitPose = pose;
    applyPose(pose);
  }
});

// ── BSP 加载（主线程解析；最小集：metadata / spawn / GLB）─────────────
let mainWasmReady: Promise<void> | null = null;
function ensureMainWasm(): Promise<void> {
  if (!mainWasmReady) {
    mainWasmReady = (async () => {
      let resp: Response;
      try {
        resp = await fetch('./websurf_viewer_wasm_bg.wasm');
      } catch (e) {
        throw new Error('WASM 文件请求失败：请确认通过 npm run dev 启动并访问 http://localhost:8080/');
      }
      if (!resp.ok) {
        throw new Error(
          `fetch wasm → ${resp.status}：缺少 WASM 产物，请在 viewer/ 目录先运行 npm run build:wasm`,
        );
      }
      initSync({ module: await resp.arrayBuffer() });
    })();
  }
  return mainWasmReady;
}

/** BSP 方位角 yaw（顺时针）→ viewer yaw（逆时针，与 ts-shared bspYawToCsYaw 一致）。 */
function bspYawToCsYaw(bspYaw: number): number {
  return ((270 - bspYaw) % 360 + 360) % 360;
}

function setBspStatus(text: string): void {
  if (bspStatusEl) bspStatusEl.textContent = text;
}

// ── 引导层 / 错误可视化 ──────────────────────────────────────────────
function showGuideError(human: string, raw?: string): void {
  if (!guideErrorEl) return;
  guideErrorEl.innerHTML = '';
  const msg = document.createElement('div');
  msg.textContent = human;
  guideErrorEl.appendChild(msg);
  if (raw) {
    const detail = document.createElement('span');
    detail.className = 'raw';
    detail.textContent = raw;
    guideErrorEl.appendChild(detail);
  }
  guideErrorEl.classList.add('show');
}

function clearGuideError(): void {
  guideErrorEl?.classList.remove('show');
}

function hideGuide(): void {
  guideEl?.classList.add('hidden');
}

function showGuide(): void {
  guideEl?.classList.remove('hidden');
}

/** 把底层异常翻译成人话；返回 [人类可读, 原始信息]。 */
function humanizeBspError(e: unknown): [string, string] {
  const raw = e instanceof Error ? e.message : String(e);
  if (/magic|format|parse|binrw|unexpected|invalid/i.test(raw)) {
    return ['这不是有效的（或暂不支持的）BSP 地图文件', raw];
  }
  if (/wasm|fetch|404|network/i.test(raw)) {
    return ['运行时组件缺失：请先完成构建（npm run build:wasm）', raw];
  }
  if (/memory|allocation/i.test(raw)) {
    return ['地图过大，内存不足导致解析失败', raw];
  }
  return ['地图加载失败', raw];
}

/** 加载互斥：解析进行中忽略新的加载请求，防止并发解析竞态。 */
let bspLoading = false;

function setLoadBusy(busy: boolean): void {
  guideBtn?.classList.toggle('busy', busy);
  bspbarBtn?.classList.toggle('busy', busy);
  if (bspFileInput) bspFileInput.disabled = busy;
}

async function loadBsp(file: File): Promise<void> {
  if (bspLoading) return;
  bspLoading = true;
  setLoadBusy(true);
  clearGuideError();
  try {
    setBspStatus(`正在解析 ${file.name}（主线程 BSP 解析）…`);
    await ensureMainWasm();
    await new Promise((r) => setTimeout(r, 0)); // 先让 UI 刷新（大图解析可能数百 ms）

    const proc = new BspProcessor(new Uint8Array(await file.arrayBuffer()));
    const meta = JSON.parse(proc.metadata()) as {
      magic?: string;
      map_name?: string;
      num_brushes?: number;
      num_faces?: number;
      num_models?: number;
      num_vertices?: number;
    };
    // 借用导出（spawn）必须在消费 BSP 的 export_glb* 之前调用
    const spawnJson = proc.parse_spawn_points();
    const glb = proc.export_glb_with_pakfile_models();
    const glbBytes = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;

    await loadGlb(glbBytes);

    // 初始视角：外部显式位姿（URL/API）优先，否则用推荐出生点
    if (!explicitPose) {
      const spawnData = JSON.parse(spawnJson) as {
        spawn_points?: Array<{ classname: string; origin: number[]; angles: number[] }>;
        primary?: number;
      };
      const points = spawnData.spawn_points ?? [];
      const primary = points[spawnData.primary ?? 0] ?? points[0];
      if (primary) {
        applyPose({
          pos: [primary.origin[0], primary.origin[1], primary.origin[2]],
          ang: [bspYawToCsYaw(primary.angles[1] ?? 0), primary.angles[0] ?? 0],
        });
        setBspStatus(
          `${file.name}：${meta.magic ?? 'VBSP'}，${meta.num_brushes ?? 0} brushes，` +
            `${points.length} 出生点（初始视角 = 出生点 #${spawnData.primary ?? 0}），` +
            `GLB ${Math.round(glbBytes.byteLength / 1024)} KB`,
        );
      } else {
        setBspStatus(
          `${file.name}：${meta.magic ?? 'VBSP'}，${meta.num_brushes ?? 0} brushes，` +
            `无出生点（初始视角 = 原点），GLB ${Math.round(glbBytes.byteLength / 1024)} KB`,
        );
      }
    } else {
      applyPose(explicitPose);
      setBspStatus(
        `${file.name}：${meta.magic ?? 'VBSP'}，${meta.num_brushes ?? 0} brushes，` +
          `GLB ${Math.round(glbBytes.byteLength / 1024)} KB（已应用外部位姿）`,
      );
    }
    hideGuide();
  } catch (e) {
    const [human, raw] = humanizeBspError(e);
    setBspStatus(`BSP 加载失败：${human}`);
    console.error('[viewer] BSP 加载失败:', e);
    if (!modelRoot) {
      // 尚无任何地图：回到引导层并展示可见错误
      showGuide();
      showGuideError(human, raw);
    } else {
      // 已有地图在场景中：保留画面，仅状态行提示
      flashStatus(`新地图加载失败：${human}`, 5000);
    }
  } finally {
    bspLoading = false;
    setLoadBusy(false);
  }
}

bspFileInput?.addEventListener('change', () => {
  const file = bspFileInput.files?.[0];
  bspFileInput.value = ''; // 允许重复选择同名文件（change 事件依赖 value 变化）
  if (file) void loadBsp(file);
});

// 引导层按钮复用同一个文件输入（避免双 input 状态不同步）
guideBtn?.addEventListener('click', () => bspFileInput?.click());

// ── 拖拽加载（既有文件加载交互的标准形态）────────────────────────────
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (!bspLoading) dropzoneEl?.classList.add('active');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) dropzoneEl?.classList.remove('active');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzoneEl?.classList.remove('active');
  if (bspLoading) return;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!/\.bsp$/i.test(file.name)) {
    if (!modelRoot) {
      // 尚无地图：引导层可见，错误写引导层
      showGuideError('请拖入 .bsp 地图文件（当前拖入的是其他类型）', file.name);
    } else {
      // 已有地图在场景中：引导层已隐藏，走状态行闪现
      flashStatus(`未加载：${file.name} 不是 .bsp 地图文件`, 5000);
    }
    return;
  }
  void loadBsp(file);
});

// ── GLB 场景构建 ─────────────────────────────────────────────────────
const gltfLoader = new GLTFLoader();

function loadGlb(glbBytes: ArrayBuffer): Promise<void> {
  const buffer = new Uint8Array(glbBytes.byteLength);
  buffer.set(new Uint8Array(glbBytes));
  const url = URL.createObjectURL(new Blob([buffer], { type: 'model/gltf-binary' }));
  return gltfLoader
    .loadAsync(url)
    .then((gltf) => {
      URL.revokeObjectURL(url);
      if (modelRoot) {
        disposeObject(modelRoot);
        scene.remove(modelRoot);
      }
      const root = new THREE.Group();
      resetRootRotations(gltf);
      root.add(gltf.scene);
      scene.add(root);
      modelRoot = root;

      // 渲染减负：空间分块合并（GLB 数千~数万 primitive Mesh → ~数百块）
      optimizeScene();

      // 视距/雾按世界包围盒自适应
      const box = new THREE.Box3().setFromObject(root);
      const diag = box.getSize(new THREE.Vector3()).length();
      const far = Math.min(Math.max(diag * 2, CAMERA_FAR_MIN), CAMERA_FAR_MAX);
      camera.far = far;
      camera.updateProjectionMatrix();
      scene.fog = new THREE.Fog(BG_COLOR, far * 0.4, far * 0.9);
    })
    .catch((err) => {
      URL.revokeObjectURL(url);
      throw err;
    });
}

/** 释放模型几何/材质/纹理（防重复加载泄漏）。 */
function disposeObject(obj: THREE.Object3D): void {
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

// ── 空间分块合并（移植自 test/dual-mode-harness worker-b.ts，已验证）──
// GLTFLoader 每 primitive 一个 THREE.Mesh：surf 地图 GLB 可达 ~3.4 万 Mesh，
// 每帧遍历/剔除开销使渲染接近帧间隔。分块合并把数万 Mesh → ~数百空间块
// （块内按材质子合并，draw call = 材质数）→ 渲染耗时 < 5ms。
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

function optimizeScene(): void {
  if (!modelRoot) return;
  scene.updateMatrixWorld(true);
  const infos: Array<{ mesh: THREE.Mesh; cx: number; cy: number; cz: number }> = [];
  const keptMeshes: THREE.Mesh[] = [];
  const worldBox = new THREE.Box3();
  const box = new THREE.Box3();
  const center = new THREE.Vector3();
  scene.traverse((obj) => {
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
    if (keptMeshes.length > 0 && modelRoot) {
      scene.remove(modelRoot);
      modelRoot = new THREE.Group();
      for (const m of keptMeshes) modelRoot.add(m);
      scene.add(modelRoot);
    }
    return;
  }

  // cell 大小自适应：世界包围盒对角线 / cbrt(目标块数)，非空 cell 数微调落 [300,800]
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
        for (const g of geoms) mergedGeoms.push(g), mats.push(mat);
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
    (g.boundingSphere as THREE.Sphere).radius *= FRUSTUM_PAD;
  }

  if (modelRoot) scene.remove(modelRoot);
  scene.add(optRoot);
  modelRoot = optRoot;
}

// ── 渲染循环 ─────────────────────────────────────────────────────────
let lastNow = performance.now();
/** HUD 位姿刷新门控（10Hz）。 */
let poseHudAt = 0;

function updatePoseHud(): void {
  const p = getPose();
  if (poseEl) {
    poseEl.textContent =
      `pos (${p.pos[0].toFixed(1)}, ${p.pos[1].toFixed(1)}, ${p.pos[2].toFixed(1)})  ` +
      `ang (yaw ${p.ang[0].toFixed(1)}°, pitch ${p.ang[1].toFixed(1)}°)`;
  }
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastNow) / 1000, 0.05);
  lastNow = now;

  // 鼠标视角（仅锁定时；顺时针 yaw 增量为负 → 右转）
  if (locked) {
    const dx = mouseDx;
    const dy = mouseDy;
    mouseDx = 0;
    mouseDy = 0;
    fly.yaw -= dx * MOUSE_SENS;
    fly.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, fly.pitch - dy * MOUSE_SENS));
  }

  // 飞行移动（相机相对方向；WASD 水平 + 空格/Ctrl 升降 + Shift ×4）
  if (locked && keys.size > 0) {
    const fast = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const speed = fast ? FLY_SPEED_FAST : FLY_SPEED;
    const fwd = new THREE.Vector3(-Math.sin(fly.yaw), 0, -Math.cos(fly.yaw));
    const right = new THREE.Vector3(Math.cos(fly.yaw), 0, -Math.sin(fly.yaw));
    const move = new THREE.Vector3();
    if (keys.has('KeyW')) move.add(fwd);
    if (keys.has('KeyS')) move.sub(fwd);
    if (keys.has('KeyD')) move.add(right);
    if (keys.has('KeyA')) move.sub(right);
    if (keys.has('Space')) move.y += 1;
    if (keys.has('KeyC') || keys.has('ControlLeft') || keys.has('ControlRight')) move.y -= 1;
    if (move.lengthSq() > 0) {
      fly.pos.addScaledVector(move.normalize(), speed * dt);
    }
  }

  syncCamera();
  renderer.render(scene, camera);

  if (now - poseHudAt >= 100) {
    poseHudAt = now;
    updatePoseHud();
  }
}

// ── 启动：应用初始外部位姿（URL 查询参数）后进入渲染循环 ──────────────
const initialPose = parsePoseParams(new URLSearchParams(window.location.search));
if (initialPose) {
  explicitPose = initialPose;
  applyPose(initialPose);
}
updatePoseHud();
requestAnimationFrame(frame);
