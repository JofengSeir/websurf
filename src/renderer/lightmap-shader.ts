/**
 * RGBExp32 lightmap 解码着色器注入
 *
 * 将 Source 引擎 RGBExp32 编码的光照贴图 atlas 注入到 MeshBasicMaterial。
 *
 * 关键约束（project_memory）：
 * - 使用 MeshBasicMaterial + onBeforeCompile（不用 MeshLambertMaterial）
 * - atlas 纹理名 `__vbsp_lightmap_atlas__`，NoColorSpace + NearestFilter
 * - RGBExp32 解码：`exp = alpha * 255 - 128; rgb * pow(2, exp)`（UNSIGNED）
 * - 应用公式：`finalColor = diffuseColor * pow(decoded_lightmap, 1/2.2)`
 * - 手动双线性采样（4 邻居 + mix）— NearestFilter + raw RGBExp32
 * - r151+ maps TEXCOORD_1 → geometry.attributes.uv1（NOT uv2）；
 *   `MeshBasicMaterial.lightMap` slot 的 `vLightMapUv` varying 由 `uv2` attribute 驱动，
 *   检测 uv1 并复制到 uv2：`geom.setAttribute('uv2', geom.attributes.uv1)`
 */

import * as THREE from 'three';
import type { GLTF, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';

// ---------------------------------------------------------------------------
// GLSL 着色器片段
// ---------------------------------------------------------------------------

/**
 * 解码单个 RGBExp32 样本。
 *
 * atlas 纹理为 RGBA8（NoColorSpace，采样值 [0,1] 为原始字节/255）：
 * - RGB = mantissa（0..1）
 * - A   = exponent 偏移到无符号字节（exp + 128）
 *
 * 解码：`exp = alpha * 255 - 128; rgb * pow(2, exp)`
 * （rgb 已是字节/255，故结果 = byte * pow(2,exp) / 255，与 Source RGBExp32 一致）
 */
const VBSP_DECOMPRESS_LIGHTMAP_SAMPLE = /* glsl */ `
vec3 vbsp_DecompressLightmapSample(vec4 texel) {
	float expV = texel.a * 255.0 - 128.0;
	return texel.rgb * pow(2.0, expV);
}
`;

/**
 * 手动双线性采样 + RGBExp32 解码 + 应用 gamma。
 *
 * 由于 atlas 用 NearestFilter（保留 raw RGBExp32 字节，避免硬件线性插值破坏
 * 指数编码），在 shader 中手动采样 4 个最近邻并 mix，每个样本先解码再插值。
 *
 * 应用公式：`pow(decoded, 1/2.2)`（lightmap 从线性空间转到显示 gamma）。
 * 调用方将其乘入 diffuseColor：`finalColor = diffuseColor * result`。
 *
 * atlas 尺寸通过 uniform `vbsp_AtlasSize`（vec2，像素数）传入，避免依赖
 * GLSL ES 3.00 的 textureSize（兼容性更好）。
 */
const VBSP_APPLY_LIGHTMAP = /* glsl */ `
vec3 vbsp_ApplyLightmap(sampler2D atlas, vec2 uv) {
	vec2 atlasSize = vbsp_AtlasSize;
	vec2 px = uv * atlasSize - 0.5;
	vec2 ipx = floor(px);
	vec2 f = px - ipx;
	vec2 invSize = 1.0 / atlasSize;
	vec3 s00 = vbsp_DecompressLightmapSample(texture2D(atlas, (ipx + vec2(0.5, 0.5)) * invSize));
	vec3 s10 = vbsp_DecompressLightmapSample(texture2D(atlas, (ipx + vec2(1.5, 0.5)) * invSize));
	vec3 s01 = vbsp_DecompressLightmapSample(texture2D(atlas, (ipx + vec2(0.5, 1.5)) * invSize));
	vec3 s11 = vbsp_DecompressLightmapSample(texture2D(atlas, (ipx + vec2(1.5, 1.5)) * invSize));
	vec3 s0 = mix(s00, s10, f.x);
	vec3 s1 = mix(s01, s11, f.x);
	vec3 decoded = mix(s0, s1, f.y);
	return pow(max(decoded, vec3(0.0)), vec3(1.0 / 2.2));
}
`;

// MeshBasicMaterial 在 fragment shader 中内联了 lightmap 处理（不使用 lightmap_fragment chunk）：
//   vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
//   reflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;
// 我们替换该内联块，改用 vbsp_ApplyLightmap。
// 同时兼容直接 include <lightmap_fragment> 的材质（理论上 MeshBasicMaterial 不会，但防御性处理）。
const BASIC_INLINE_LIGHTMAP_SRC =
	'vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );\n\t\treflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;';

const BASIC_INLINE_LIGHTMAP_REPLACEMENT =
	'reflectedLight.indirectDiffuse += vbsp_ApplyLightmap(lightMap, vLightMapUv);';

const CHUNK_LIGHTMAP_INCLUDE = '#include <lightmap_fragment>';
const CHUNK_LIGHTMAP_REPLACEMENT =
	'reflectedLight.indirectDiffuse += vbsp_ApplyLightmap(lightMap, vLightMapUv);';

// ---------------------------------------------------------------------------
// Atlas 加载
// ---------------------------------------------------------------------------

/**
 * 从 glTF extras.lightmap.textureIndex 异步加载 lightmap atlas 纹理。
 *
 * 约束：NoColorSpace + NearestFilter（保留 raw RGBExp32 字节，手动双线性在 shader 中做）。
 * 纹理名设为 `__vbsp_lightmap_atlas__` 便于外部识别。
 *
 * @param parser GLTFParser（gltf.parser）。
 * @param gltf GLTF 解析结果（读取 asset/scene extras 中的 textureIndex）。
 * @returns atlas 纹理；若 glTF 无 lightmap extras 则返回 null。
 */
export async function loadLightmapAtlas(
	parser: GLTFParser,
	gltf: GLTF,
): Promise<THREE.Texture | null> {
	// textureIndex 可能在 asset.extras.lightmap 或 scene.userData.extras.lightmap
	const assetExtras = (gltf.asset?.extras ?? {}) as Record<string, unknown>;
	const sceneExtras = (gltf.scene?.userData?.extras ?? {}) as Record<string, unknown>;
	const assetLightmap = assetExtras.lightmap as { textureIndex?: number } | undefined;
	const sceneLightmap = sceneExtras.lightmap as { textureIndex?: number } | undefined;
	const textureIndex = assetLightmap?.textureIndex ?? sceneLightmap?.textureIndex;

	if (textureIndex === undefined || textureIndex === null || textureIndex < 0) {
		return null;
	}

	let texture: THREE.Texture;
	try {
		texture = await parser.loadTexture(textureIndex);
	} catch (err) {
		console.error('[lightmap-shader] 加载 atlas 纹理失败:', err);
		return null;
	}

	texture.name = '__vbsp_lightmap_atlas__';
	texture.colorSpace = THREE.NoColorSpace;
	texture.minFilter = THREE.NearestFilter;
	texture.magFilter = THREE.NearestFilter;
	texture.generateMipmaps = false;
	texture.needsUpdate = true;

	return texture;
}

// ---------------------------------------------------------------------------
// 应用 lightmap 到 mesh
// ---------------------------------------------------------------------------

/**
 * 遍历场景中的 mesh，对带 uv1/uv2 的几何体应用 lightmap atlas。
 *
 * 流程：
 * 1. 检测 geometry.attributes.uv1（r151+ TEXCOORD_1 映射），若存在则复制到 uv2
 *    （MeshBasicMaterial.lightMap 的 vLightMapUv varying 由 uv2 驱动）。
 * 2. 用 `MeshBasicMaterial({ map, lightMap, lightMapIntensity: 1 })` 替换原材质
 *    （保留原 map 与 color），onBeforeCompile 注入 RGBExp32 解码 + 手动双线性 shader。
 * 3. 仅处理同时拥有 uv2（或 uv1）的 mesh；无 lightmap UV 的 mesh 跳过。
 *
 * @param scene Three.js 场景。
 * @param atlasTexture lightmap atlas 纹理（来自 loadLightmapAtlas）。
 * @returns 已应用 lightmap 的 mesh 数量。
 */
export function applyLightmapToMeshes(
	scene: THREE.Scene,
	atlasTexture: THREE.Texture,
): number {
	const atlasW = (atlasTexture.image?.width as number) || 0;
	const atlasH = (atlasTexture.image?.height as number) || 0;
	const atlasSize = new THREE.Vector2(atlasW, atlasH);

	let applied = 0;

	scene.traverse((obj) => {
		if (!(obj as THREE.Mesh).isMesh) return;
		const mesh = obj as THREE.Mesh;
		const geom = mesh.geometry as THREE.BufferGeometry;
		if (!geom) return;

		// 检测 uv1 / uv2
		const hasUv1 = !!geom.getAttribute('uv1');
		const hasUv2 = !!geom.getAttribute('uv2');
		if (!hasUv1 && !hasUv2) return; // 无 lightmap UV

		// r151+ TEXCOORD_1 → uv1；lightMap slot 由 uv2 驱动 → 复制 uv1 到 uv2
		if (hasUv1 && !hasUv2) {
			geom.setAttribute('uv2', geom.getAttribute('uv1'));
		}

		// 保留原材质的 map / color / transparent / opacity 等
		const origMat = mesh.material as THREE.Material | THREE.Material[];
		const firstOrig = Array.isArray(origMat) ? origMat[0] : origMat;
		const origBasic = firstOrig as THREE.MeshBasicMaterial;
		const origMap = (origBasic as unknown as { map?: THREE.Texture | null }).map ?? null;
		const origColor =
			(origBasic as unknown as { color?: THREE.Color }).color?.clone() ??
			new THREE.Color(0xffffff);
		const origTransparent = (firstOrig as THREE.Material).transparent ?? false;
		const origOpacity = (firstOrig as THREE.Material).opacity ?? 1;

		const newMat = new THREE.MeshBasicMaterial({
			map: origMap,
			color: origColor,
			lightMap: atlasTexture,
			lightMapIntensity: 1,
		});
		newMat.transparent = origTransparent;
		newMat.opacity = origOpacity;

		// 注入 RGBExp32 解码着色器
		injectLightmapShader(newMat, atlasSize);

		mesh.material = newMat;
		applied++;
	});

	return applied;
}

/**
 * 在 MeshBasicMaterial 的 onBeforeCompile 中注入 RGBExp32 解码 + 手动双线性 shader。
 *
 * 注入内容：
 * - 在 `void main()` 之前插入 `vbsp_DecompressLightmapSample` + `vbsp_ApplyLightmap` 函数。
 * - 添加 uniform `vbsp_AtlasSize`（vec2）。
 * - 替换 MeshBasicMaterial 内联的 lightmap texel 采样为 `vbsp_ApplyLightmap(lightMap, vLightMapUv)`。
 * - 兼容 `#include <lightmap_fragment>` chunk（防御性）。
 */
function injectLightmapShader(
	material: THREE.MeshBasicMaterial,
	atlasSize: THREE.Vector2,
): void {
	// 保留 uniform 值引用：onBeforeCompile 每次重编译都会被调用，
	// 需要重新设置 uniform（Three.js 不会自动保留自定义 uniform）。
	const uniformValue = { value: atlasSize.clone() };
	material.onBeforeCompile = (shader) => {
		shader.uniforms.vbsp_AtlasSize = uniformValue;

		const frag = shader.fragmentShader;

		// 插入函数定义（在 void main 之前）
		const injected =
			VBSP_DECOMPRESS_LIGHTMAP_SAMPLE +
			'\n' +
			VBSP_APPLY_LIGHTMAP +
			'\n';

		// 先替换内联 lightmap 块（MeshBasicMaterial 实际路径）
		let updated = frag.replace(
			BASIC_INLINE_LIGHTMAP_SRC,
			BASIC_INLINE_LIGHTMAP_REPLACEMENT,
		);
		// 兼容 chunk include 路径（防御性）
		updated = updated.replace(
			CHUNK_LIGHTMAP_INCLUDE,
			CHUNK_LIGHTMAP_REPLACEMENT,
		);

		// 插入函数定义 + uniform 声明
		updated =
			'uniform vec2 vbsp_AtlasSize;\n' +
			injected +
			updated;

		shader.fragmentShader = updated;
	};
	material.needsUpdate = true;
}
