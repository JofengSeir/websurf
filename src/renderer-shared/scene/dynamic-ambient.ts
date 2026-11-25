/**
 * 动态实体的实时 BSP leaf ambient cube 采样追踪器（节流 + 平滑插值，零热路径分配）。
 *
 * 背景：静态加载期 `collect_model_entities` 只按实体初始 `origin` 查一次 leaf ambient cube；
 * 一旦 `prop_dynamic*` 挂在 `func_movelinear` / `func_door` / `func_tracktrain` 上开出室内进入
 * 明亮室外，车体材质若继续沿用出生室内的暗 cube 就会「黑着开进阳光里」。
 *
 * 本模块：
 * 1. 载图后收集带 `__vbspAmbCubeUniform` 材质的动态实体组；
 * 2. 运行期仅在实体位移超过阈值或目标尚未收敛时，以低频（~6.7Hz）向 `PvsManager.getAmbientCubeAt`
 *    按实时包围盒中心（含 +24 HU 离地防埋兜底）查询当前所在 leaf 的 6 面环境光；
 * 3. 每帧用指数平滑把当前 `vbspAmbCube` 六个 `THREE.Vector3` 原地 lerp 向目标值（不换材质、零 GC），
 *    实体过门进出明暗区域平滑过渡不闪烁。
 */
import * as THREE from 'three';
import type { PvsManager } from '../../ts-shared/world/pvs-manager.js';

interface AmbCubeUniform {
	value: THREE.Vector3[];
}

interface TrackedEntityAmbient {
	entityIndex: number;
	group: THREE.Group;
	uniforms: AmbCubeUniform[];
	baseCenter: THREE.Vector3;
	baseGroupPos: THREE.Vector3;
	lastSampleGroupPos: THREE.Vector3;
	current: Float32Array;
	target: Float32Array;
	initialized: boolean;
	dirty: boolean;
	converging: boolean;
	nextSampleMs: number;
}

const SAMPLE_INTERVAL_MS = 150;
const MOVE_THRESHOLD_SQ = 8 * 8;
const LERP_RATE = 6.0;
const CONVERGE_EPS = 0.0015;

export class DynamicAmbientTracker {
	private readonly entries: TrackedEntityAmbient[] = [];
	private readonly byEntity = new Map<number, TrackedEntityAmbient>();
	private readonly probePos = { x: 0, y: 0, z: 0 };
	private readonly probeBuf = new Float32Array(18);
	private lastTickMs = 0;

	collect(dynGroups: ReadonlyMap<number, THREE.Group>): number {
		this.clear();
		if (dynGroups.size === 0) return 0;
		const box = new THREE.Box3();
		const center = new THREE.Vector3();
		for (const [entityIndex, group] of dynGroups) {
			const uniformSet = new Set<AmbCubeUniform>();
			group.traverse((obj) => {
				const mesh = obj as THREE.Mesh;
				if (!mesh.isMesh) return;
				const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
				for (const mat of mats) {
					const u = (mat?.userData as { __vbspAmbCubeUniform?: AmbCubeUniform } | undefined)?.__vbspAmbCubeUniform;
					if (u && Array.isArray(u.value) && u.value.length === 6) {
						uniformSet.add(u);
					}
				}
			});
			if (uniformSet.size === 0) continue;

			const uniforms = [...uniformSet];
			const first = uniforms[0].value;
			const current = new Float32Array(18);
			const target = new Float32Array(18);
			for (let j = 0; j < 6; j++) {
				current[j * 3] = first[j].x;
				current[j * 3 + 1] = first[j].y;
				current[j * 3 + 2] = first[j].z;
			}
			target.set(current);

			group.updateMatrixWorld(true);
			box.setFromObject(group);
			if (box.isEmpty()) center.copy(group.position);
			else box.getCenter(center);

			const entry: TrackedEntityAmbient = {
				entityIndex,
				group,
				uniforms,
				baseCenter: center.clone(),
				baseGroupPos: group.position.clone(),
				lastSampleGroupPos: group.position.clone(),
				current,
				target,
				initialized: true,
				dirty: false,
				converging: false,
				nextSampleMs: 0,
			};
			this.entries.push(entry);
			this.byEntity.set(entityIndex, entry);
		}
		return this.entries.length;
	}

	markMoved(entityIndex: number): void {
		const entry = this.byEntity.get(entityIndex);
		if (entry) entry.dirty = true;
	}

	update(pvs: PvsManager | null, nowMs: number): void {
		if (this.entries.length === 0 || !pvs || !pvs.hasLeafAmbient()) return;
		const dt = this.lastTickMs > 0 ? Math.min(0.1, Math.max(0, (nowMs - this.lastTickMs) / 1000)) : 1 / 60;
		this.lastTickMs = nowMs;
		const alpha = 1 - Math.exp(-dt * LERP_RATE);

		for (const entry of this.entries) {
			const gp = entry.group.position;
			const movedSq =
				(gp.x - entry.lastSampleGroupPos.x) ** 2
				+ (gp.y - entry.lastSampleGroupPos.y) ** 2
				+ (gp.z - entry.lastSampleGroupPos.z) ** 2;

			if ((entry.dirty || movedSq >= MOVE_THRESHOLD_SQ) && nowMs >= entry.nextSampleMs) {
				entry.dirty = false;
				entry.nextSampleMs = nowMs + SAMPLE_INTERVAL_MS;
				entry.lastSampleGroupPos.copy(gp);

				this.probePos.x = entry.baseCenter.x + (gp.x - entry.baseGroupPos.x);
				this.probePos.y = entry.baseCenter.y + (gp.y - entry.baseGroupPos.y);
				this.probePos.z = entry.baseCenter.z + (gp.z - entry.baseGroupPos.z);

				let ok = pvs.getAmbientCubeAt(this.probePos, this.probeBuf);
				if (!ok) {
					this.probePos.y += 24;
					ok = pvs.getAmbientCubeAt(this.probePos, this.probeBuf);
				}
				if (ok) {
					entry.target.set(this.probeBuf);
					entry.converging = true;
				}
			}

			if (!entry.converging) continue;
			let maxDiff = 0;
			for (let k = 0; k < 18; k++) {
				const diff = entry.target[k] - entry.current[k];
				const abs = Math.abs(diff);
				if (abs > maxDiff) maxDiff = abs;
				entry.current[k] += diff * alpha;
			}
			for (const u of entry.uniforms) {
				for (let j = 0; j < 6; j++) {
					u.value[j].set(entry.current[j * 3], entry.current[j * 3 + 1], entry.current[j * 3 + 2]);
				}
			}
			if (maxDiff < CONVERGE_EPS) {
				entry.current.set(entry.target);
				for (const u of entry.uniforms) {
					for (let j = 0; j < 6; j++) {
						u.value[j].set(entry.target[j * 3], entry.target[j * 3 + 1], entry.target[j * 3 + 2]);
					}
				}
				entry.converging = false;
			}
		}
	}

	clear(): void {
		this.entries.length = 0;
		this.byEntity.clear();
		this.lastTickMs = 0;
	}
}
