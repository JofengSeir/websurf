/**
 * GLB 加载 → Three.js Scene
 *
 * 用 GLTFLoader 解析 GLB（通过 Blob URL），遍历 mesh 存储 userData 元数据
 * （从 material.name 与 texture name 解析），应用 lightmap atlas，返回 Scene。
 *
 * 关键约束（project_memory）：
 * - 遵循模块边界（不跨层引用 world/physics）
 * - lightmap 由 lightmap-shader 模块注入
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { RuntimeConfig } from '../config.js';
import { applyLightmapToMeshes, loadLightmapAtlas } from './lightmap-shader.js';

/** mesh userData 元数据（从 material.name / texture name 解析）。 */
export interface MeshMetadata {
	/** 工具纹理（tools/*）。 */
	isTools: boolean;
	/** nodraw 纹理。 */
	isNodraw: boolean;
	/** 是否有漫反射贴图。 */
	hasTexture: boolean;
	/** 水面材质。 */
	isWater: boolean;
	/** 半透明材质。 */
	isTrans: boolean;
	/** 自发光/发光材质。 */
	isLightEmissive: boolean;
	/** 纹理名（用于调试/分类）。 */
	textureName: string;
	/** 材质名。 */
	materialName: string;
}

/** build() 返回的结果。 */
export interface BuildResult {
	/** 加载的 Three.js 场景。 */
	scene: THREE.Scene;
	/** 已应用 lightmap 的 mesh 数量。 */
	lightmapApplied: number;
	/** 场景包围盒。 */
	boundingBox: THREE.Box3;
	/** 场景对角线长度。 */
	diagonal: number;
}

/**
 * GLB → Three.js Scene 构建器。
 *
 * 持有 GLTFLoader 实例（复用），提供 build() 与 dispose()。
 */
export class SceneBuilder {
	private readonly loader: GLTFLoader;
	private scene: THREE.Scene | null = null;

	constructor() {
		this.loader = new GLTFLoader();
	}

	/**
	 * 解析 GLB 字节并构建 Three.js 场景。
	 *
	 * 流程：
	 * 1. 用 GLTFLoader 通过 Blob URL 异步加载 GLB。
	 * 2. 遍历 mesh 存储 userData 元数据（isTools/isNodraw/hasTexture/isWater/
	 *    isTrans/isLightEmissive/textureName/materialName）。
	 * 3. 调用 lightmap-shader 应用 lightmap（加载 atlas + 注入 shader）。
	 * 4. 返回 scene + 包围盒 + 对角线。
	 *
	 * @param glbBytes GLB 字节数据。
	 * @param _config 运行时配置（保留接口，当前 build 不直接依赖）。
	 * @returns 构建结果。
	 */
	async build(
		glbBytes: Uint8Array,
		_config: RuntimeConfig,
	): Promise<BuildResult> {
		// 复制到独立的 ArrayBuffer（Blob 需要 ArrayBufferView，避免引用外部 buffer）
		const buffer = new Uint8Array(glbBytes.byteLength);
		buffer.set(glbBytes);

		// 通过 Blob URL 加载（render-worker.js 同款做法）
		const blob = new Blob([buffer], { type: 'model/gltf-binary' });
		const blobUrl = URL.createObjectURL(blob);

		let gltf: GLTF;
		try {
			gltf = await this.loader.loadAsync(blobUrl);
		} catch (err) {
			URL.revokeObjectURL(blobUrl);
			throw new Error(`[scene-builder] GLB 加载失败: ${String(err)}`);
		} finally {
			// loadAsync 完成后立即释放 Blob URL
			URL.revokeObjectURL(blobUrl);
		}

		// gltf.scene 是 THREE.Group；用 THREE.Scene 包裹以满足 build() 返回类型
		// （render-loop.setScene 将其整体加入主场景）
		const scene = new THREE.Scene();
		gltf.scene.userData.isBspModel = true;

		// 坐标系统一修复（v31→v32 关键 bug 修复）：
		// convert.rs 在 GLB 根节点（root_node）上设置了 R_y(90°) 旋转。
		// GLTFLoader.loadScene 创建一个 Group（gltf.scene）作为容器，
		// root_node 成为 gltf.scene.children[0]（而非 gltf.scene 本身）。
		// 所以必须重置 gltf.scene.children[*] 的旋转，而不是 gltf.scene.rotation。
		//
		// 数学：GLB 顶点世界坐标 = root_rotation * map_coords(bsp_vertex)
		//      = R_y(90°) * [y,z,x] = [z, y, -x]（从 BSP 原始 [x,y,z]）
		// 但 WASM 端碰撞体/spawn/PVS 仅用 rotate_yup = [y,z,x]（无根旋转），
		// 导致渲染位置 ≠ 碰撞体位置（X/Z 互换 + Z 取反），玩家 spawn 在地图外。
		//
		// 修复：遍历 gltf.scene.children，重置所有非零旋转的根节点。
		// 重置后渲染坐标系 = map_coords(bsp_vertex) = [y,z,x]，与碰撞体一致。
		// 注意：lightmap UV 是 vertex 局部属性，不依赖世界坐标，不受此修复影响。
		let resetCount = 0;
		for (const child of gltf.scene.children) {
			const r = child.rotation;
			if (r.x !== 0 || r.y !== 0 || r.z !== 0) {
				console.log(
					`[scene-builder] 重置根节点 "${child.name || '(unnamed)'}" 旋转: ` +
					`(${r.x.toFixed(3)}, ${r.y.toFixed(3)}, ${r.z.toFixed(3)}) → (0, 0, 0) 统一坐标系`,
				);
				child.rotation.set(0, 0, 0);
				child.updateMatrixWorld();
				resetCount++;
			}
		}
		if (resetCount > 0) {
			gltf.scene.updateMatrixWorld(true);
			console.log(`[scene-builder] 共重置 ${resetCount} 个根节点的旋转`);
		} else {
			// 诊断：如果没有重置任何节点，打印所有子节点的 rotation 供调试
			console.log(`[scene-builder] gltf.scene.children.length=${gltf.scene.children.length}`);
			for (let i = 0; i < gltf.scene.children.length; i++) {
				const c = gltf.scene.children[i];
				console.log(
					`[scene-builder] child[${i}] name="${c.name}" ` +
					`rotation=(${c.rotation.x.toFixed(3)}, ${c.rotation.y.toFixed(3)}, ${c.rotation.z.toFixed(3)}) ` +
					`position=(${c.position.x.toFixed(1)}, ${c.position.y.toFixed(1)}, ${c.position.z.toFixed(1)})`,
				);
			}
		}

		scene.add(gltf.scene);
		this.scene = scene;

		// 1. 遍历 mesh 存储元数据
		this.collectMetadata(scene);

		// 2. 应用 lightmap（加载 atlas + 注入 shader）
		let lightmapApplied = 0;
		const atlasTexture = await loadLightmapAtlas(gltf.parser, gltf);
		if (atlasTexture) {
			lightmapApplied = applyLightmapToMeshes(scene, atlasTexture);
		}

		// 3. 计算包围盒与对角线
		scene.updateMatrixWorld(true);
		const boundingBox = new THREE.Box3().setFromObject(scene);
		const size = boundingBox.getSize(new THREE.Vector3());
		const diagonal = size.length();

		return { scene, lightmapApplied, boundingBox, diagonal };
	}

	/**
	 * 遍历 mesh，从 material.name 与 texture name 解析元数据存入 userData。
	 *
	 * 解析规则（基于 Source 材质命名约定）：
	 * - isTools: 名含 "tools/" 或 "tools\\"
	 * - isNodraw: 名含 "nodraw"
	 * - isWater: 名含 "water"
	 * - isLightEmissive: 名含 "light"/"emit"/"glow"/"sky"
	 * - hasTexture: material.map !== null
	 * - isTrans: material.transparent === true
	 */
	private collectMetadata(scene: THREE.Scene): void {
		scene.traverse((obj) => {
			if (!(obj as THREE.Mesh).isMesh) return;
			const mesh = obj as THREE.Mesh;
			const mat = mesh.material as THREE.Material | THREE.Material[];
			const firstMat = Array.isArray(mat) ? mat[0] : mat;
			if (!firstMat) return;

			const materialName = (firstMat.name ?? '').toLowerCase();
			const basicMat = firstMat as THREE.MeshBasicMaterial;
			const map = (basicMat as unknown as { map?: THREE.Texture | null }).map;
			const textureName = map?.name ? map.name.toLowerCase() : '';
			const combined = `${materialName} ${textureName}`;

			const meta: MeshMetadata = {
				isTools: combined.includes('tools/') || combined.includes('tools\\'),
				isNodraw: combined.includes('nodraw'),
				hasTexture: !!map,
				isWater: combined.includes('water'),
				isTrans: !!firstMat.transparent,
				isLightEmissive:
					combined.includes('light') ||
					combined.includes('emit') ||
					combined.includes('glow') ||
					combined.includes('sky'),
				textureName: map?.name ?? '',
				materialName: firstMat.name ?? '',
			};

			mesh.userData.vbsp = meta;
		});
	}

	/** 释放资源（销毁场景内 geometry/material/texture）。 */
	dispose(): void {
		if (!this.scene) return;
		this.scene.traverse((obj) => {
			const mesh = obj as THREE.Mesh;
			if (!mesh.isMesh) return;
			if (mesh.geometry) mesh.geometry.dispose();
			const mat = mesh.material as THREE.Material | THREE.Material[];
			if (Array.isArray(mat)) {
				mat.forEach((m) => disposeMaterial(m));
			} else if (mat) {
				disposeMaterial(mat);
			}
		});
		this.scene = null;
	}
}

/**
 * 释放材质及其贴图资源。
 *
 * 多个材质可能共享同一张 atlas 贴图，dispose() 是幂等的，
 * Three.js 内部会处理已释放的资源。
 */
function disposeMaterial(mat: THREE.Material): void {
	const m = mat as THREE.MeshBasicMaterial & {
		map?: THREE.Texture | null;
		lightMap?: THREE.Texture | null;
	};
	// 不释放共享的 lightmap atlas（由 scene-builder 统一管理）
	if (m.map && m.map.name !== '__vbsp_lightmap_atlas__') {
		m.map.dispose();
	}
	m.dispose();
}
