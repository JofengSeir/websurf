/**
 * 录像的 3D 呈现层：为每条轨道建一组「轨迹线 + tick 数据点 + 幽灵实体 + 起终点标记」。
 *
 * 职责边界：本文件只把采样结果写进 `three` 对象，不做时间换算（在
 * `apps/viewer/src/replay/tracks.ts` 的 `TrackSet`）、不管播放状态（在
 * `apps/viewer/src/replay/player.ts` 的 `ReplayPlayer`）、不建面板控件。
 *
 * 关键不变量：
 * - 每条轨道的五个对象都**独立** `scene.add`（不成组），显隐逐个设置，故每次重建都必须
 *   把旧对象全部移除，否则场景里会残留上一批轨迹；
 * - 采样坐标的语义是**脚底**（viewer 为 Y-up）：轨迹线与 tick 点抬高 8 HU 画，起终点标记抬高 16 HU；
 * - `Track.visible` 与三个显示开关的关系——轨迹线受 `showTrail`、tick 点受 `showTickNodes`、
 *   幽灵受 `showGhost`，三者的位姿/可见性都再与 `Track.visible` 相与；只有幽灵会因
 *   「第一人称且正是跟随目标」额外隐藏（它贴在相机上会挡满屏），轨迹线、tick 点与起终点标记不受影响。
 *
 * 交互方：`apps/viewer/src/app.ts` 构造唯一实例并在 `syncTracks` 里调 `setTracks`、
 * 在渲染循环里每帧调 `update`；`apps/viewer/src/replay/timeline.ts` 的三个复选框经
 * `setTrailVisible` / `setGhostVisible` / `setTickNodesVisible` 写三个开关位。
 */

import * as THREE from 'three';
import { DEG2RAD } from '../core/constants.js';
import type { ViewerScene } from '../core/scene.js';
import type { Clip, Track, TrackSample } from './types.js';
import type { PlayMode } from './player.js';

/** 轨迹线抽稀上限（点数）：`stride = max(1, ceil(clip.count / 本值))`，采样点数 = `floor((clip.count − 1) / stride) + 1`，恒不超过本值。 */
const MAX_TRAIL_POINTS = 40000;

interface TrackObjects {
  trackId: string;
  trail: THREE.Line;
  /** 每帧一个方点的 tick 数据点（`Clip.count` 个点，不抽稀）。 */
  tickNodes: THREE.Points;
  ghost: THREE.Group;
  startMark: THREE.Mesh;
  endMark: THREE.Mesh;
}

export class ReplayVisuals {
  /** 轨迹线总开关（时间轴的「轨迹线」复选框写它）。 */
  showTrail = true;
  /** 幽灵总开关（时间轴的「幽灵」复选框写它）。 */
  showGhost = true;
  /** tick 数据点总开关（时间轴的「tick 点」复选框写它）。 */
  showTickNodes = true;

  /** 已建对象表，下标与 `setTracks` 传入的顺序一致；`update` 靠 `trackId` 找回对应项。 */
  private objects: TrackObjects[] = [];

  constructor(private readonly scene: ViewerScene) {}

  /** 按传入顺序整体重建：先 `clear` 再逐条建。`Clip.count = 0` 的轨道被跳过（建不出几何）。 */
  setTracks(tracks: readonly Track[]): void {
    this.clear();
    for (const track of tracks) {
      const objs = buildTrackObjects(track);
      if (!objs) continue;
      for (const o of [objs.trail, objs.tickNodes, objs.ghost, objs.startMark, objs.endMark]) this.scene.add(o);
      this.objects.push(objs);
    }
  }

  /**
   * 每帧更新：先用采样数组与 `Track.visible` 定各对象显隐，再给幽灵写位姿。
   * 采样表里找不到该轨道时按可见处理（对象与轨道集不同步的过渡帧）；没有采样则不写位姿、隐藏幽灵。
   * 幽灵旋转用 `'YXZ'` 序（与第一人称相机一致），三轴角度都乘 `DEG2RAD`。
   */
  update(samples: readonly TrackSample[], mode: PlayMode, followId: string | null): void {
    for (const o of this.objects) {
      const entry = samples.find((s) => s.track.id === o.trackId);
      const visible = entry ? entry.track.visible : true;
      o.trail.visible = this.showTrail && visible;
      o.tickNodes.visible = this.showTickNodes && visible;
      o.startMark.visible = visible;
      o.endMark.visible = visible;

      const hideGhost = !this.showGhost || !visible || (mode === 'first' && o.trackId === followId);
      const sample = entry?.sample ?? null;
      if (!sample || hideGhost) {
        o.ghost.visible = false;
        continue;
      }
      o.ghost.visible = true;
      o.ghost.position.set(sample.pos[0], sample.pos[1], sample.pos[2]);
      o.ghost.rotation.set(
        sample.ang[1] * DEG2RAD,
        sample.ang[0] * DEG2RAD,
        sample.ang[2] * DEG2RAD,
        'YXZ',
      );
    }
  }

  /** 轨迹线总开关（时间轴复选框的回调）。 */
  setTrailVisible(v: boolean): void {
    this.showTrail = v;
  }

  /** 幽灵总开关（时间轴复选框的回调）。 */
  setGhostVisible(v: boolean): void {
    this.showGhost = v;
  }

  /** tick 数据点总开关（时间轴复选框的回调）。 */
  setTickNodesVisible(v: boolean): void {
    this.showTickNodes = v;
  }

  /** 是否已建过对象（等价于「有没有含帧的轨道」）。 */
  hasTracks(): boolean {
    return this.objects.length > 0;
  }

  /** 移除并释放全部已建对象，随后清空对象表。 */
  clear(): void {
    for (const o of this.objects) {
      for (const obj of [o.trail, o.tickNodes, o.ghost, o.startMark, o.endMark]) {
        this.scene.remove(obj);
        disposeTree(obj);
      }
    }
    this.objects = [];
  }
}

/**
 * 建一条轨道的五个对象；`Clip.count = 0` 时返回 null（起终点标记取不到帧，几何无法成型）。
 * 起点标记画在首帧、终点标记画在末帧，横坐标与纵坐标分别取 `clip.pos` 与 `clip.pos + 16`。
 */
function buildTrackObjects(track: Track): TrackObjects | null {
  const clip = track.clip;
  if (clip.count === 0) return null;

  const trail = buildTrail(clip, track.color);
  const tickNodes = buildTickNodes(clip, track.color);
  const ghost = buildGhost(track.color);

  const startMark = buildMark(track.color, 14, 0.95);
  const endMark = buildMark(track.color, 9, 0.55);
  startMark.position.set(clip.pos[0], clip.pos[1] + 16, clip.pos[2]);
  const last = (clip.count - 1) * 3;
  endMark.position.set(clip.pos[last], clip.pos[last + 1] + 16, clip.pos[last + 2]);

  return { trackId: track.id, trail, tickNodes, ghost, startMark, endMark };
}

/**
 * 抽稀后的轨迹线：`stride = max(1, ceil(total / MAX_TRAIL_POINTS))`（`total = clip.count`），
 * 采样点数 `count = floor((total − 1) / stride) + 1`（恒 ≤ MAX_TRAIL_POINTS），按 stride 取样，
 * 每个点抬高 8 HU；取满后把末点覆盖到最后一格，保证收尾连到终点。
 * 材质走 `LineBasicMaterial`（半透明 0.85），并关掉视锥剔除。
 */
function buildTrail(clip: Clip, color: number): THREE.Line {
  const total = clip.count;
  const stride = Math.max(1, Math.ceil(total / MAX_TRAIL_POINTS));
  const count = Math.floor((total - 1) / stride) + 1;
  const arr = new Float32Array(count * 3);
  let w = 0;
  for (let i = 0; i < total && w < count; i += stride) {
    arr[w * 3] = clip.pos[i * 3];
    arr[w * 3 + 1] = clip.pos[i * 3 + 1] + 8;
    arr[w * 3 + 2] = clip.pos[i * 3 + 2];
    w++;
  }
  // 末点补齐（保证收尾连到终点）
  if (w === count && count > 1) {
    const last = (total - 1) * 3;
    arr[(count - 1) * 3] = clip.pos[last];
    arr[(count - 1) * 3 + 1] = clip.pos[last + 1] + 8;
    arr[(count - 1) * 3 + 2] = clip.pos[last + 2];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  return line;
}

/** tick 数据点：逐帧一个顶点（不抽稀，tick 密度即信息量），抬高 8 HU 画；点材质 size 5、开 sizeAttenuation，故近大远小。 */
function buildTickNodes(clip: Clip, color: number): THREE.Points {
  const total = clip.count;
  const arr = new Float32Array(total * 3);
  for (let i = 0; i < total; i++) {
    arr[i * 3] = clip.pos[i * 3];
    arr[i * 3 + 1] = clip.pos[i * 3 + 1] + 8;
    arr[i * 3 + 2] = clip.pos[i * 3 + 2];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  // 无贴图的 THREE.Points 渲染为方块——与 debug 权威帧方点同款观感
  const mat = new THREE.PointsMaterial({
    color,
    size: 5,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.9,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}
/** 幽灵实体：胶囊体近似玩家碰撞箱（半径 16、圆柱长 40 ⇒ 总高 72，与 `src/phys/player.rs` 的 `DEFAULT_HULL_HALF_WIDTH` / `DEFAULT_HULL_STAND_HEIGHT` 同尺），加一个朝向指示锥。 */
function buildGhost(color: number): THREE.Group {
  const g = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(16, 40, 6, 12),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 }),
  );
  body.position.y = 36;
  g.add(body);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(9, 26, 12),
    new THREE.MeshBasicMaterial({ color }),
  );
  // 锥体默认沿 +Y，转到 -Z（viewer 的前方）
  nose.rotation.x = -Math.PI / 2;
  nose.position.set(0, 56, -22);
  g.add(nose);

  return g;
}

/** 起终点标记：球体（半径与不透明度由调用方给，起点大而亮、终点小而暗），位置由调用方设。 */
function buildMark(color: number, radius: number, opacity: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, 16, 12),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity }),
  );
}

/**
 * 释放子树的几何体与材质：遍历时只处理 `isMesh` 的节点，故 `THREE.Line` 与 `THREE.Points`
 * （轨迹线、tick 数据点）的几何体与材质不在释放范围内。
 */
function disposeTree(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) for (const m of mat) m.dispose();
    else mat?.dispose();
  });
}
