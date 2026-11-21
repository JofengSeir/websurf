/**
 * 粒子/光效独立预览页（不加载地图、不吃预烘焙光照）。
 *
 * 用途：只把 `ParticleSystems` 放进一个空的 three.js 场景里，用固定机位和可控参数反复迭代
 * collapse 观感，避免被地图几何、世界光贴图、PVS 干扰。入口在 `apps/debug/web/preview-particles.html`。
 *
 * URL 参数：
 * - `?effect=tendies_endparticle01` 选择效果（默认 tendies_endparticle01）。
 * - `?cam=x,y,z&yaw=deg&pitch=deg` 指定相机（缺省 `0,260,760` / `180` / `-8`）。
 * - `?paused=1` 不推进时间（截图对照用）。
 */

import * as THREE from 'three';
import { ParticleSystems, type ParticleEntity } from '../../../src/renderer-shared/scene/particles.js';
import { createPreviewExtras, type PreviewExtras } from './preview-extras.js';

const params = new URLSearchParams(location.search);
const effectName = params.get('effect') ?? 'tendies_endparticle01';
const paused = params.get('paused') === '1';

const canvasHost = document.body;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x05060a, 1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
canvasHost.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(73.6, window.innerWidth / window.innerHeight, 1, 60000);

const camParam = params.get('cam');
const camPos = camParam
  ? (camParam.split(',').map(Number) as [number, number, number])
  : ([0, 260, 760] as [number, number, number]);
let yaw = Number(params.get('yaw') ?? '180');
let pitch = Number(params.get('pitch') ?? '-8');
const yawRad = (yaw * Math.PI) / 180;
const pitchRad = (pitch * Math.PI) / 180;
const dir = new THREE.Vector3(
  -Math.sin(yawRad) * Math.cos(pitchRad),
  Math.sin(pitchRad),
  -Math.cos(yawRad) * Math.cos(pitchRad),
);
camera.position.set(camPos[0], camPos[1], camPos[2]);
camera.lookAt(new THREE.Vector3(camPos[0] + dir.x * 1000, camPos[1] + dir.y * 1000, camPos[2] + dir.z * 1000));

// 地面：极简的暗色圆盘 + 同心圈，给光柱一个可读的「底」。
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(1600, 64),
  new THREE.MeshBasicMaterial({ color: 0x0b0c11, side: THREE.DoubleSide, fog: false }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 0;
scene.add(ground);

const ring = new THREE.Mesh(
  new THREE.RingGeometry(180, 190, 64),
  new THREE.MeshBasicMaterial({ color: 0x2a2338, side: THREE.DoubleSide, fog: false }),
);
ring.rotation.x = -Math.PI / 2;
ring.position.y = 0.5;
scene.add(ring);

const entities: ParticleEntity[] = [{ effect: effectName, origin: [0, 0, 0], angles: [-90, 0, 0] }];
const systems = new ParticleSystems(entities);
scene.add(systems.root);

// 空白场景里没有地图 brush 几何，用近似层补齐 boreas 的三层观感：
// 底部符文盘（end_wiccan）+ 加色烟幕（tendies_endsmoke）。详见 preview-extras.ts / RUNE_SPEC.md。
const extras: PreviewExtras = createPreviewExtras();
scene.add(extras.root);

const hud = document.getElementById('hud') as HTMLDivElement;
const info = {
  effect: effectName,
  stats: null as ReturnType<ParticleSystems['stats']> | null,
};
const updateHud = (): void => {
  hud.innerHTML =
    `<b>${info.effect}</b>\n` +
    `cam ${camera.position.x.toFixed(0)},${camera.position.y.toFixed(0)},${camera.position.z.toFixed(0)}  yaw ${yaw}  pitch ${pitch}\n` +
    `extras rune+smoke  ${extras.root.visible ? 'on' : 'off'}\n` +
    `stats ${info.stats ? JSON.stringify(info.stats) : '-'}`;
};
updateHud();

let last = performance.now();
const tick = (now: number): void => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (!paused) {
    systems.update(dt, camera);
    extras.update(dt);
  }
  info.stats = systems.stats();
  updateHud();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
};

// 预热：让光柱已经铺满一个寿命（暂停模式下也能直接截到完整形态）。
for (let i = 0; i < 180; i++) {
  systems.update(1 / 60, camera);
  extras.update(1 / 60);
}
renderer.render(scene, camera);
requestAnimationFrame(tick);

interface PreviewApi {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  systems: ParticleSystems;
  /** 符文盘 + 烟幕近似层（截图时可用 setVisible 单独开关对照）。 */
  extras: PreviewExtras;
  /** 只做一次固定步进的推进，避免截图时受 rAF 节奏影响。 */
  step: (dt: number, times?: number) => void;
  /** 重设相机（与 URL 参数同语义）。 */
  setCamera: (x: number, y: number, z: number, yawDeg: number, pitchDeg: number) => void;
}

const api: PreviewApi = {
  scene,
  camera,
  renderer,
  systems,
  extras,
  step: (dt: number, times = 1) => {
    for (let i = 0; i < times; i++) {
      systems.update(dt, camera);
      extras.update(dt);
    }
  },
  setCamera: (x, y, z, yawDeg, pitchDeg) => {
    yaw = yawDeg;
    pitch = pitchDeg;
    const yr = (yawDeg * Math.PI) / 180;
    const pr = (pitchDeg * Math.PI) / 180;
    camera.position.set(x, y, z);
    camera.lookAt(
      x - Math.sin(yr) * Math.cos(pr) * 1000,
      y + Math.sin(pr) * 1000,
      z - Math.cos(yr) * Math.cos(pr) * 1000,
    );
  },
};

(globalThis as Record<string, unknown>)['__preview'] = api;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
