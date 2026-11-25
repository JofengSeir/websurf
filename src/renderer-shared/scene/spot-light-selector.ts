/**
 * spot / dlight 的 Top-N 筛选器（T-P2-2c 从 render-session.ts 的 `updateSpotLights` 拆出；行为逐字节不变）。
 *
 * 每帧送进 lightmap 注入的 spot 上限 8、dlight 上限 2，与 `lightmap-shader.ts` 的
 * `SPOT_MAX` / `DLIGHT_MAX` 对齐（那边是模块私有常量，改动必须同步这两处）。
 */
import * as THREE from 'three';
import {
  setDLights,
  setSpotLights,
  type DLightInput,
  type SpotLightInput,
} from '../shader/lightmap-shader.js';

const SPOT_TOP_N = 8;
const DLIGHT_TOP_N = 2;

/**
 * 零分配 scratch。旧实现每帧
 * `map → sort → slice → map`（spot 57 盏 + dlight）会分配约 130 个临时对象、
 * 6 个临时数组并重算 16 次 `Math.cos`；120–240fps 下就是持续的 GC 压力。
 * 现在只做单趟 O(N) 选前 8 / 前 2，结果写进固定槽位对象。
 *
 * 安全性：`setSpotLights` / `setDLights`（shader/lightmap-shader.ts）内部立刻把数值拷进
 * uniform，不持有入参数组或元素引用，所以复用这些对象是安全的。
 */
export class SpotLightSelector {
  private readonly spotTopIdx = new Int32Array(SPOT_TOP_N);
  private readonly spotTopDist = new Float64Array(SPOT_TOP_N);
  private readonly spotOutSlots: SpotLightInput[] = Array.from({ length: SPOT_TOP_N }, () => ({
    position: [0, 0, 0],
    direction: [0, 0, 0],
    color: [0, 0, 0],
    intensity: 0,
    range: 0,
    cosOuter: 0,
    cosInner: 0,
  }));
  private readonly spotOutList: SpotLightInput[] = [];
  /**
   * spot 圆锥角的 `Math.cos` 缓存：`spots` 数组只在载图时由 `spot-beams.ts` 重建，
   * 锥角不逐帧变化，所以按「数组身份 + 长度」失效即可（旧实现每帧算 16 次）。
   */
  private spotCosRef: unknown = null;
  private spotCosCount = -1;
  private spotCosOuter = new Float64Array(0);
  private spotCosInner = new Float64Array(0);
  private readonly dlightTopIdx = new Int32Array(DLIGHT_TOP_N);
  private readonly dlightTopDist = new Float64Array(DLIGHT_TOP_N);
  private readonly dlightOutSlots: DLightInput[] = Array.from({ length: DLIGHT_TOP_N }, () => ({
    position: [0, 0, 0],
    color: [0, 0, 0],
    range: 0,
  }));
  private readonly dlightOutList: DLightInput[] = [];

  /**
   * 每帧调用：选最近 8 盏 spot / 2 个 dlight 并写入 lightmap uniform。
   * `beams` 是本图的 `point_spotlight` 组（null = 本图没有 spot）。
   */
  update(beams: THREE.Object3D | null, camera: THREE.PerspectiveCamera): void {
    const spots = beams?.userData.spots as
      | {
          position: [number, number, number];
          direction: [number, number, number];
          color: [number, number, number];
          intensity: number;
          range: number;
          innerConeAngle: number;
          outerConeAngle: number;
        }[]
      | undefined;
    if (!spots || spots.length === 0) {
      // 与旧实现一致：无 spot 时**提前返回**，dlight uniform 保持上一帧的值。
      this.spotOutList.length = 0;
      setSpotLights(this.spotOutList);
      return;
    }
    const len = spots.length;
    if (this.spotCosRef !== spots || this.spotCosCount !== len) {
      if (this.spotCosOuter.length !== len) {
        this.spotCosOuter = new Float64Array(len);
        this.spotCosInner = new Float64Array(len);
      }
      for (let i = 0; i < len; i++) {
        this.spotCosOuter[i] = Math.cos(spots[i].outerConeAngle);
        this.spotCosInner[i] = Math.cos(spots[i].innerConeAngle);
      }
      this.spotCosRef = spots;
      this.spotCosCount = len;
    }
    const cam = camera.position;
    const topIdx = this.spotTopIdx;
    const topDist = this.spotTopDist;
    // 单趟 O(N) 选最近 SPOT_TOP_N 盏：插入位置在「所有距离相同者之后」，因此同距离时
    // 下标小的仍在前 —— 与旧实现「稳定 sort 升序 + slice(0, 8)」逐位同序。
    let count = 0;
    for (let i = 0; i < len; i++) {
      const s = spots[i];
      const dx = s.position[0] - cam.x;
      const dy = s.position[1] - cam.y;
      const dz = s.position[2] - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (count < SPOT_TOP_N) {
        let pos = count;
        while (pos > 0 && topDist[pos - 1] > d2) pos--;
        for (let j = count; j > pos; j--) {
          topDist[j] = topDist[j - 1];
          topIdx[j] = topIdx[j - 1];
        }
        topDist[pos] = d2;
        topIdx[pos] = i;
        count++;
      } else if (d2 < topDist[SPOT_TOP_N - 1]) {
        // 并列第 8 远时旧实现保留先出现的下标，这里同样不替换。
        let pos = SPOT_TOP_N - 1;
        while (pos > 0 && topDist[pos - 1] > d2) pos--;
        for (let j = SPOT_TOP_N - 1; j > pos; j--) {
          topDist[j] = topDist[j - 1];
          topIdx[j] = topIdx[j - 1];
        }
        topDist[pos] = d2;
        topIdx[pos] = i;
      }
    }
    const out = this.spotOutList;
    for (let j = 0; j < count; j++) {
      const oi = topIdx[j];
      const s = spots[oi];
      const slot = this.spotOutSlots[j];
      slot.position = s.position;
      slot.direction = s.direction;
      slot.color = s.color;
      slot.intensity = s.intensity;
      slot.range = s.range;
      slot.cosOuter = this.spotCosOuter[oi];
      slot.cosInner = this.spotCosInner[oi];
      out[j] = slot;
    }
    out.length = count;
    setSpotLights(out);
    // 命中点的 dlight：宽而软的光斑，按距离取最近 2 个（同上的零分配选法）。
    const dlights = beams?.userData.dlights as
      | { position: [number, number, number]; color: [number, number, number]; range: number }[]
      | undefined;
    const dTopIdx = this.dlightTopIdx;
    const dTopDist = this.dlightTopDist;
    const dLen = dlights ? dlights.length : 0;
    let dCount = 0;
    for (let i = 0; i < dLen; i++) {
      const d = dlights![i];
      const dx = d.position[0] - cam.x;
      const dy = d.position[1] - cam.y;
      const dz = d.position[2] - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (dCount < DLIGHT_TOP_N) {
        let pos = dCount;
        while (pos > 0 && dTopDist[pos - 1] > d2) pos--;
        for (let j = dCount; j > pos; j--) {
          dTopDist[j] = dTopDist[j - 1];
          dTopIdx[j] = dTopIdx[j - 1];
        }
        dTopDist[pos] = d2;
        dTopIdx[pos] = i;
        dCount++;
      } else if (d2 < dTopDist[DLIGHT_TOP_N - 1]) {
        let pos = DLIGHT_TOP_N - 1;
        while (pos > 0 && dTopDist[pos - 1] > d2) pos--;
        for (let j = DLIGHT_TOP_N - 1; j > pos; j--) {
          dTopDist[j] = dTopDist[j - 1];
          dTopIdx[j] = dTopIdx[j - 1];
        }
        dTopDist[pos] = d2;
        dTopIdx[pos] = i;
      }
    }
    const outD = this.dlightOutList;
    for (let j = 0; j < dCount; j++) {
      const d = dlights![dTopIdx[j]];
      const slot = this.dlightOutSlots[j];
      slot.position = d.position;
      slot.color = d.color;
      slot.range = d.range;
      outD[j] = slot;
    }
    outD.length = dCount;
    setDLights(outD);
  }
}
