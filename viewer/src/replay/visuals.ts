/** 录像的 3D 呈现：每条轨道一套「轨迹线 + 幽灵实体 + 起终点标记」。 */

import * as THREE from 'three';
import { DEG2RAD } from '../core/constants.js';
import type { ViewerScene } from '../core/scene.js';
import type { Clip, Track, TrackSample } from './types.js';
import type { PlayMode } from './player.js';

/** 轨迹线抽稀上限（点数），超出等间距取样。29 万帧 → stride 8，约 3.6 万点。 */
const MAX_TRAIL_POINTS = 40000;

interface TrackObjects {
  trackId: string;
  trail: THREE.Line;
  ghost: THREE.Group;
  startMark: THREE.Mesh;
  endMark: THREE.Mesh;
}

export class ReplayVisuals {
  showTrail = true;
  showGhost = true;

  private objects: TrackObjects[] = [];

  constructor(private readonly scene: ViewerScene) {}

  /** 轨道增减/整体替换后调用（轨道数很少，重建比增量同步省心）。 */
  setTracks(tracks: readonly Track[]): void {
    this.clear();
    for (const track of tracks) {
      const objs = buildTrackObjects(track);
      if (!objs) continue;
      for (const o of [objs.trail, objs.ghost, objs.startMark, objs.endMark]) this.scene.add(o);
      this.objects.push(objs);
    }
  }

  /**
   * 每帧更新幽灵位姿。
   * 第一人称下只隐藏**被跟随**的那条（它就贴在相机上，会挡满屏），
   * 其余照常显示——那正是切第一人称时要对比的东西。
   */
  update(samples: readonly TrackSample[], mode: PlayMode, followId: string | null): void {
    for (const o of this.objects) {
      const entry = samples.find((s) => s.track.id === o.trackId);
      const visible = entry ? entry.track.visible : true;
      o.trail.visible = this.showTrail && visible;
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

  setTrailVisible(v: boolean): void {
    this.showTrail = v;
  }

  setGhostVisible(v: boolean): void {
    this.showGhost = v;
  }

  hasTracks(): boolean {
    return this.objects.length > 0;
  }

  clear(): void {
    for (const o of this.objects) {
      for (const obj of [o.trail, o.ghost, o.startMark, o.endMark]) {
        this.scene.remove(obj);
        disposeTree(obj);
      }
    }
    this.objects = [];
  }
}

function buildTrackObjects(track: Track): TrackObjects | null {
  const clip = track.clip;
  if (clip.count === 0) return null;

  const trail = buildTrail(clip, track.color);
  const ghost = buildGhost(track.color);

  const startMark = buildMark(track.color, 14, 0.95);
  const endMark = buildMark(track.color, 9, 0.55);
  startMark.position.set(clip.pos[0], clip.pos[1] + 16, clip.pos[2]);
  const last = (clip.count - 1) * 3;
  endMark.position.set(clip.pos[last], clip.pos[last + 1] + 16, clip.pos[last + 2]);

  return { trackId: track.id, trail, ghost, startMark, endMark };
}

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

/** 幽灵：胶囊（近似玩家碰撞体 32×72）+ 朝向指示锥。 */
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

function buildMark(color: number, radius: number, opacity: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, 16, 12),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity }),
  );
}

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
