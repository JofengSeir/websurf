/**
 * instanced-diorama 入口 —— 实例化绘制 + PBR 光照渲染测试。
 *
 * 双模式：
 * - 沙盘 Diorama：2.1 万实例方块（金属/玻璃/木头/砖，每材质 1 个 InstancedMesh）
 *   + 影棚光照（PCFSoft 4096 软阴影 + 半球天光）+ SSAO + Bokeh DOF + FXAA；
 * - BSP 地图：wasm 导出含 KHR_lights_punctual 光照的 GLB → 渲染端实例化 →
 *   同一条后处理管线。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { PostFX } from './composer.js';
import { Diorama } from './diorama.js';
import { createStudioLights, setShadowSize, type StudioLights } from './studio-lights.js';
import { BspViewer } from './bsp-viewer.js';
import { Hud } from './hud.js';

// ── 渲染器：物理正确光照模式（r155+ 默认物理单位强度）+ PCFSoft 软阴影 ──
const canvas = document.getElementById('gl') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: true, // ?probe=1 像素诊断需要读回默认缓冲
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// 关闭 info 自动重置：composer 多 pass 累加整帧 draw call / 三角形统计（HUD 展示）
renderer.info.autoReset = false;

// ── 场景：影棚环境反射（金属/玻璃的镜面反射来源）──
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1114);
scene.fog = new THREE.Fog(0x0e1114, 260, 900);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.5, 1000);
camera.position.set(72, 46, 72);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 4, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2.05;
controls.update();

const postfx = new PostFX(renderer, scene, camera, innerWidth, innerHeight);
const hud = new Hud(renderer);

// ── 沙盘（默认模式）──
const diorama = new Diorama(scene);
const lights: StudioLights = createStudioLights(4096);
scene.add(diorama.group);
scene.add(lights.key, lights.hemi, lights.fill);
const dioramaStats = diorama.build(21000);
hud.setInstances(dioramaStats.total);
hud.setNote(
  `沙盘: ${dioramaStats.total.toLocaleString()} 实例 / ${dioramaStats.drawCalls} 个 draw call\n` +
    `金属 ${dioramaStats.metal} · 木头 ${dioramaStats.wood} · 砖 ${dioramaStats.brick} · 玻璃 ${dioramaStats.glass}`,
);

// ── BSP 模式 ──
const bspViewer = new BspViewer(scene, camera, controls, hud, postfx);
const DIORAMA_CAMERA_POS = new THREE.Vector3(72, 46, 72);
const DIORAMA_TARGET = new THREE.Vector3(0, 4, 0);

// ── 模式切换 ──
type Mode = 'diorama' | 'bsp';
let mode: Mode = 'diorama';
const tabDiorama = document.getElementById('tab-diorama')!;
const tabBsp = document.getElementById('tab-bsp')!;
const ctrlDiorama = document.getElementById('ctrl-diorama')!;
const ctrlBsp = document.getElementById('ctrl-bsp')!;

function switchMode(m: Mode): void {
  if (m === mode) return;
  mode = m;
  tabDiorama.classList.toggle('active', m === 'diorama');
  tabBsp.classList.toggle('active', m === 'bsp');
  ctrlDiorama.style.display = m === 'diorama' ? '' : 'none';
  ctrlBsp.style.display = m === 'bsp' ? '' : 'none';
  if (m === 'diorama') {
    bspViewer.clear();
    scene.fog = new THREE.Fog(0x0e1114, 260, 900); // 恢复沙盘雾
    scene.add(diorama.group);
    scene.add(lights.key, lights.hemi, lights.fill);
    camera.position.copy(DIORAMA_CAMERA_POS);
    controls.target.copy(DIORAMA_TARGET);
    controls.update();
    postfx.setDofFocus(96);
    hud.setInstances(diorama.stats.total);
    hud.setNote(
      `沙盘: ${diorama.stats.total.toLocaleString()} 实例 / ${diorama.stats.drawCalls} 个 draw call`,
    );
  } else {
    scene.remove(diorama.group);
    scene.remove(lights.key, lights.hemi, lights.fill);
  }
}
tabDiorama.addEventListener('click', () => switchMode('diorama'));
tabBsp.addEventListener('click', () => switchMode('bsp'));

// ── BSP 加载（选择 / 拖拽）──
const bspInput = document.getElementById('bsp-file') as HTMLInputElement;
document.getElementById('bsp-pick')!.addEventListener('click', () => bspInput.click());
bspInput.addEventListener('change', () => {
  const f = bspInput.files?.[0];
  if (f) void loadBsp(f);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.name.toLowerCase().endsWith('.bsp'));
  if (f) void loadBsp(f);
});

async function loadBsp(file: File): Promise<void> {
  const info = document.getElementById('bsp-info')!;
  info.textContent = `解析 ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…`;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const report = await bspViewer.loadBsp(bytes);
    info.textContent =
      `✓ ${file.name}\n` +
      `导出 GLB ${(report.glbBytes / 1048576).toFixed(1)} MB（含模型 + ${report.lightCount} 个光照）\n` +
      `实例化 ${report.instancing.groups} 组 / ${report.instancing.instances} 实例\n` +
      `包围盒 ${report.bboxSize.map((v) => v.toFixed(0)).join(' × ')}`;
  } catch (err) {
    info.textContent = `✗ 加载失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── ?bsp=maps/xxx.bsp → 自动切 BSP 模式并加载（headless 验证 / 快速演示）──
const bspParam = new URLSearchParams(location.search).get('bsp');
if (bspParam) {
  switchMode('bsp');
  void fetch(bspParam)
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const report = await bspViewer.loadBsp(bytes);
      const info = document.getElementById('bsp-info')!;
      info.textContent =
        `✓ ${bspParam} (${(bytes.length / 1048576).toFixed(1)} MB)\n` +
        `导出 GLB ${(report.glbBytes / 1048576).toFixed(1)} MB（含模型 + ${report.lightCount} 个光照）\n` +
        `实例化 ${report.instancing.groups} 组 / ${report.instancing.instances} 实例\n` +
        `包围盒 ${report.bboxSize.map((v) => v.toFixed(0)).join(' × ')}`;
    })
    .catch((err) => {
      document.getElementById('bsp-info')!.textContent = `✗ 加载失败: ${err instanceof Error ? err.message : String(err)}`;
    });
}

// ── 控制面板接线 ──
/** DOF 焦点是否被用户手动锁定（滑杆拖动后锁定；默认跟随相机→场景中心 = 移轴效果）。
 *  声明必须先于 bindRange 的同步 apply()（TDZ：闭包内赋值不得早于 let 声明）。 */
let manualDofFocus = false;
function bindRange(id: string, onValue: (v: number) => void, fmt = (v: number) => String(v)): void {
  const el = document.getElementById(id) as HTMLInputElement;
  const val = document.getElementById(id + '-val')!;
  const apply = () => {
    const v = Number(el.value);
    val.textContent = fmt(v);
    onValue(v);
  };
  el.addEventListener('input', apply);
  apply();
}

bindRange('inst-count', (n) => {
  const s = diorama.build(n);
  hud.setInstances(s.total);
  hud.setNote(
    `沙盘: ${s.total.toLocaleString()} 实例 / ${s.drawCalls} 个 draw call\n` +
      `金属 ${s.metal} · 木头 ${s.wood} · 砖 ${s.brick} · 玻璃 ${s.glass}`,
  );
});
bindRange('exposure', (v) => (renderer.toneMappingExposure = v), (v) => v.toFixed(2));
bindRange('ao-intensity', (v) => postfx.setAoIntensity(v), (v) => v.toFixed(1));
bindRange('ao-radius', (v) => postfx.setAoRadius(v));
bindRange('dof-focus', (v) => {
  manualDofFocus = true; // 用户拖动焦点滑杆 → 锁定手动焦点
  postfx.setDofFocus(v);
});
bindRange('dof-aperture', (v) => postfx.setDofAperture(v), (v) => v.toFixed(3));
// 阴影分辨率是 select（无 val 显示），直接接线
const shadowSelect = document.getElementById('shadow-size') as HTMLSelectElement;
shadowSelect.addEventListener('change', () => setShadowSize(lights, Number(shadowSelect.value)));
(document.getElementById('ssao-on') as HTMLInputElement).addEventListener('change', (e) =>
  postfx.setSsaoEnabled((e.target as HTMLInputElement).checked),
);
(document.getElementById('dof-on') as HTMLInputElement).addEventListener('change', (e) =>
  postfx.setDofEnabled((e.target as HTMLInputElement).checked),
);
(document.getElementById('fxaa-on') as HTMLInputElement).addEventListener('change', (e) =>
  postfx.setFxaaEnabled((e.target as HTMLInputElement).checked),
);

// ── resize ──
window.addEventListener('resize', () => {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  postfx.resize(w, h);
});

// ── 渲染循环 ──
function frame(): void {
  requestAnimationFrame(frame);
  controls.update();
  if (!manualDofFocus) {
    const dist = camera.position.distanceTo(controls.target);
    postfx.setDofFocus(dist);
  }
  renderer.info.reset(); // 整帧统计起点（composer 多 pass 累计）
  postfx.render();
  hud.tick();
}
frame();

// ── 验证参数：?ssao=0&dof=0&fxaa=0 强制开关（headless 对照截图用）──
const qp = new URLSearchParams(location.search);
if (qp.get('ssao') === '0') postfx.setSsaoEnabled(false);
if (qp.get('dof') === '0') postfx.setDofEnabled(false);
if (qp.get('fxaa') === '0') postfx.setFxaaEnabled(false);

// ── ?probe=1：把画面下采样为 8×8 亮度网格写入 DOM（无图像查看能力时的空间诊断）──
if (qp.get('probe') === '1') {
  const probeEl = document.createElement('div');
  probeEl.id = 'pixel-probe';
  probeEl.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:20;font:11px monospace;white-space:pre;color:#fff;background:rgba(0,0,0,.7);padding:6px;border-radius:6px;';
  document.body.appendChild(probeEl);
  setInterval(() => {
    try {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      // 8×8 网格（每格取 4 个采样点平均）
      const rows: string[] = [];
      for (let gy = 0; gy < 8; gy++) {
        let line = '';
        for (let gx = 0; gx < 8; gx++) {
          let s = 0;
          for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
            const x = Math.min(w - 1, Math.floor(((gx + ox) / 8) * w));
            const y = Math.min(h - 1, Math.floor(((gy + oy) / 8) * h));
            const i = (y * w + x) * 4;
            s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
          }
          line += (s / 4 / 2.55).toFixed(0).padStart(3) + ' ';
        }
        rows.push(line);
      }
      probeEl.textContent = `亮度网格(0-100, 行=自下而上 屏幕坐标):\n${rows.reverse().join('\n')}`;
    } catch (e) {
      probeEl.textContent = `probe 失败: ${e}`;
    }
  }, 4000);
}
