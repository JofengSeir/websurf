/**
 * lightmap 注入生效性统计（首帧后一次性诊断）：遍历场景材质上的注入记录，按阶段汇总
 * 注入/失效/跳过/预期失败，并打印 ambient cube、第 1 级逐顶点光照与 alpha 状态的接线统计。
 * 只读场景与 globalThis 的注入记录、只写日志与 `__vbspLightmapInjectFailed` 标记，不做任何渲染。
 */

import * as THREE from 'three';
import { VERTEX_LIGHTING_ATTR, getVertexLightingRelaxStats, getPropVertexRelax, getPropVertexFlatten } from '../shader/lightmap-shader.js';
  /**
   * 注入生效性统计（由 renderer-main 的 `tick` 在首帧 `renderer.render()` 之后调用一次；2026-10-02 自同名私有方法原样抽出，入参 = 渲染场景）。
   *
   * 统计口径：遍历场景材质上的 `__vbspLightmapInject` 记录，按 `skipped` / `expectedFail` /
   * `applied` 分别计数，其余算失效并留最多 3 条样本。阶段名读 `globalThis.__vbspLightmapStage`：
   * 命中 `KNOWN_STAGES` 就原样使用，否则一律按 `auto`。
   * 阶段分支：`broken` 与 `noinject` 只告警，`native` 直接返回（走 three 原生 lightmap）；其余阶段
   * 「有失效材质但一条注入都没生效」时置 `globalThis.__vbspLightmapInjectFailed` 并打 error
   * （出帧脚本据此非零退出），只是部分失效则告警。
   * 同一趟还会打印 ambient cube 与第 1 级逐顶点光照的接线统计，以及材质的 alpha 状态审计。
   */
  export function reportInjectStatsOnce(scene: THREE.Scene): void {
    if (!scene) return;
    const stage = (globalThis as { __vbspLightmapStage?: unknown }).__vbspLightmapStage;
    // 已知阶段名原样保留（`channel0` / `channel1` 是注入通道对照档、`noinject` 是可比负控）：
    // 把对照档记成 `auto` 会让日志与出帧标签对不上
    const KNOWN_STAGES = ['broken', 'native', 'off', 'channel0', 'channel1', 'noinject'];
    const stageName = typeof stage === 'string' && KNOWN_STAGES.includes(stage) ? stage : 'auto';

    let injectOk = 0;
    let injectBad = 0;
    let skipped = 0;
    let expectedFail = 0;
    const samples: unknown[] = [];
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat) continue;
        const rec = (
          mat as unknown as {
            __vbspLightmapInject?: { applied?: boolean | null; skipped?: boolean; expectedFail?: boolean };
            __vbspLightmapInjected?: boolean;
          }
        ).__vbspLightmapInject;
        if (!rec) continue;
        if (rec.skipped) skipped++;
        else if (rec.expectedFail) expectedFail++;
        else if (rec.applied) injectOk++;
        else {
          injectBad++;
          if (samples.length < 3) samples.push(rec);
        }
      }
    });

    console.info(
      `[lightmap] 注入生效性（首帧后统计，stage=${stageName}）：` +
        `注入生效材质=${injectOk}，注入失效材质=${injectBad}，` +
        `跳过=${skipped}，预期失败=${expectedFail}`,
    );

    // prop ambient cube 命中统计（hit/miss 按 mesh 调用计；nodes = 去重后的 cube 引用数）
    const amb = (globalThis as { __vbspAmbientStats?: { hit: number; miss: number; nodes: Set<unknown> } })
      .__vbspAmbientStats;
    if (amb) {
      console.info(
        `[ambient-cube] 命中=${amb.hit} 未命中=${amb.miss} 节点=${amb.nodes.size}`,
      );
      // 材质级统计：遍历材质读 `__vbspAmbientInject.applied`
      let ambOk = 0;
      let ambBad = 0;
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (!m.isMesh) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          const rec = (mat as unknown as { __vbspAmbientInject?: { applied?: boolean } })
            .__vbspAmbientInject;
          if (!rec) continue;
          if (rec.applied) ambOk++;
          else ambBad++;
        }
      });
      console.info(`[ambient-cube] applied=${ambOk} 失败=${ambBad}`);
    }

    	// 定向转储（诊断）：全局设 `__vbspDumpMesh='<regex>'` 时，把匹配 mesh 的几何属性、
	// `_VBSP_VLIGHT` 统计与三条注入路径的落账状态逐条打出来，用于定位「某个 prop 为什么是黑的」。
	{
		const pat = (globalThis as { __vbspDumpMesh?: string }).__vbspDumpMesh;
		if (pat) {
			const re = new RegExp(pat);
			scene.traverse((obj) => {
				const m = obj as THREE.Mesh;
				if (!m.isMesh) return;
				const _mm = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material | undefined;
				const _map = (_mm as unknown as { map?: { name?: string } | null } | undefined)?.map;
				if (!re.test(m.name || '') && !re.test(_mm?.name || '') && !re.test(_map?.name || '')) return;
				const g = m.geometry as THREE.BufferGeometry;
				const at = g?.getAttribute?.('_vbsp_vlight') as THREE.BufferAttribute | undefined;
				let stats = 'no-attr';
				if (at) {
					const a = at.array as ArrayLike<number>;
					let mn = Infinity, mx = -Infinity, sum = 0, zero = 0;
					for (let i = 0; i < a.length; i++) { const v = a[i]; if (!Number.isFinite(v)) continue; if (v < mn) mn = v; if (v > mx) mx = v; sum += v; if (v === 0) zero++; }
					stats = 'min=' + mn.toFixed(4) + ' max=' + mx.toFixed(4) + ' mean=' + (sum / a.length).toFixed(4) + ' zero=' + (100 * zero / a.length).toFixed(1) + '%';
				}
				const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material;
				const rec = mat as unknown as { __vbspLightmapInject?: { applied?: boolean }; __vbspVertexLightingInject?: { applied?: boolean }; __vbspAmbientInject?: { applied?: boolean } };
				console.info('[dump] ' + JSON.stringify({
					name: m.name, mat: mat?.name, tex: (mat as unknown as { map?: { name?: string } | null })?.map?.name ?? null,
					matState: (() => { const b = mat as unknown as { transparent?: boolean; alphaTest?: number; opacity?: number; blending?: number; side?: number; depthWrite?: boolean; premultipliedAlpha?: boolean; map?: { format?: number; image?: { width?: number; height?: number; data?: { length?: number } } | null } | null }; const im = b.map?.image; return { tr: b.transparent === true, at: b.alphaTest ?? 0, op: b.opacity ?? 1, bl: b.blending ?? 1, side: b.side ?? 0, dw: b.depthWrite !== false, fmt: b.map?.format ?? -1, size: im ? [im.width, im.height] : null, dataLen: im?.data?.length ?? (im ? 'bitmap' : 0) }; })(), matType: mat?.type, attrs: Object.keys(g?.attributes ?? {}),
					vlight: stats,
					inject: { lightmap: rec.__vbspLightmapInject?.applied === true, vlight1: rec.__vbspVertexLightingInject?.applied === true, ambCube: rec.__vbspAmbientInject?.applied === true },
					world: (() => { const bs = (m.geometry as THREE.BufferGeometry & { boundingSphere?: THREE.Sphere | null }).boundingSphere; const v = bs ? bs.center.clone() : m.position.clone(); v.applyMatrix4(m.matrixWorld); return [Math.round(v.x), Math.round(v.y), Math.round(v.z)]; })(),
					radius: Math.round((m.geometry as THREE.BufferGeometry & { boundingSphere?: THREE.Sphere | null }).boundingSphere?.radius ?? 0),
					userData: JSON.stringify((m.userData as { vbsp?: unknown }).vbsp ?? {}).slice(0, 120),
				}));
			});
		}
	}
// 第 1 级 prop 光照（逐顶点预烘焙 → `_VBSP_VLIGHT` 几何属性）的接线校验：走这一级的材质数、
    // 注入是否生效、有没有失败。带属性却没注入记录的分两类：材质标了 `userData.unlit === true`
    // 的自发光 VMT 本就不吃光照（正确），其余算真漏网并打 error。
    {
      let vlOk = 0;
      let vlBad = 0;
      let vlUnlit = 0;
      let vlMissed = 0;
		const vlMissedNames: string[] = [];
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (!m.isMesh) return;
        const g = m.geometry as THREE.BufferGeometry | undefined;
        const hasAttr = !!g?.getAttribute?.(VERTEX_LIGHTING_ATTR);
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          const rec = (mat as unknown as { __vbspVertexLightingInject?: { applied?: boolean } })
            .__vbspVertexLightingInject;
          if (!rec) {
            if (!hasAttr) continue;
            const unlit = (mat?.userData as { unlit?: unknown } | undefined)?.unlit === true;
            if (unlit) vlUnlit++;
				else { vlMissed++; if (vlMissedNames.length < 12) { const hlG = (g?.userData as { hasLightmap?: unknown } | undefined)?.hasLightmap; const hlM = (m.userData as { hasLightmap?: unknown }).hasLightmap; const hasCube = !!(mat as unknown as { __vbspAmbientInject?: unknown }).__vbspAmbientInject; vlMissedNames.push((m.name || '(anon)') + '@' + (mat?.name || '(noname)') + '[' + (mat?.type || '?') + '|hl=' + String(hlG ?? hlM) + '|cb=' + (hasCube ? 1 : 0) + '|uv1=' + (g?.getAttribute?.('uv1') ? 1 : 0) + ']'); } }
            continue;
          }
          if (rec.applied) vlOk++;
          else vlBad++;
        }
      });
      if (vlOk + vlBad + vlUnlit + vlMissed > 0) {
        const rs = getVertexLightingRelaxStats();
        console.info(
          `[vertex-lighting] 第 1 级（逐顶点预烘焙）注入：生效材质=${vlOk}，失败=${vlBad}，` +
            `自发光 unlit（按 VMT 语义不吃光照，正确）=${vlUnlit}，**真漏网**=${vlMissed}`,
        );
        console.info(
          `[vertex-lighting] 几何重建（${getPropVertexRelax() === 0 ? '**关闭**：原样使用烘焙值' : `平滑档 ${getPropVertexRelax()}`}）：` +
            `mesh=${rs.meshes}，接缝焊接组=${rs.welded}，空间不一致顶点=${rs.medianFixed}，松弛遍数=${rs.relaxed}，` +
            `方差压缩 mesh=${rs.flattened}（**跳过 ${rs.flattenSkipped}**：面内本来就一致 ⇒ 保留原样烘焙值，flatten=${getPropVertexFlatten()}），` +
            `平均偏移=${(rs.meanAbsDelta * 100).toFixed(1)}%（单顶点最大 ${(rs.maxAbsDelta * 100).toFixed(1)}%，` +
            `样本顶点=${rs.samples}）`,
        );
      }
      if (vlMissed > 0) {
        console.error(
			`[vertex-lighting] 有 ${vlMissed} 个带 _VBSP_VLIGHT 的非 unlit mesh 没走到第 1 级材质 ⇒ 缺陷` + (vlMissedNames.length ? '：' + vlMissedNames.join(' ｜ ') : ''),
        );
      }
      // alpha 状态审计（铁丝网/格栅/玻璃这类材质的关键状态：替换材质若丢掉 alphaTest/side，
      // $alphatest 的孔洞会变成实心板、单面材质会少一半）
      let aCut = 0;
      let aBlend = 0;
      let aDouble = 0;
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (!m.isMesh) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          if (!mat) continue;
          if ((mat as THREE.Material & { alphaTest?: number }).alphaTest &&
            (mat as THREE.Material & { alphaTest?: number }).alphaTest! > 0) aCut++;
          if (mat.transparent) aBlend++;
          if ((mat as THREE.Material & { side?: number }).side === THREE.DoubleSide) aDouble++;
        }
      });
      console.info(
        `[alpha] 场景材质 alpha 状态：alphaTest>0 判 =${aCut}，transparent=${aBlend}，双面=${aDouble}` +
          `（GLB 侧：MASK=8 / BLEND=11 / 无贴图=18；裁切/混合若在此丢失即为铁丝网、格栅、玻璃整片不透的根因）`,
      );
    }

    if (stageName === 'broken') {
      // broken：预期注入失效，只告警不打 error（免得出帧负控帧被污染）
      console.warn(
        `[lightmap] stage=broken（负控）：注入预期失效 —— 预期失败材质=${expectedFail}、生效=${injectOk}。`,
      );
      return;
    }
    if (stageName === 'native') {
      // native：按设计走 three 原生 lightmap 采样，不计失败
      return;
    }
    if (stageName === 'noinject') {
      // noinject：材质照换、只是不注入 ⇒ 本来就没有 `__vbspLightmapInject` 记录，
      // injectOk = injectBad = 0 属预期，不得报"注入全失效"
      console.warn(
        '[lightmap] stage=noinject（可比负控）：材质替换保留、仅停用 shader 注入 ⇒ ' +
          '无注入记录属预期；画面预期退回无烘焙光照，且场景构成与 auto 相同（可比）。',
      );
      return;
    }
    if (injectOk === 0 && injectBad > 0) {
      const message =
        '[lightmap] 施加了材质但**没有任何一个注入生效** —— fragment 里找不到可替换的 ' +
        'lightmap 块（three 版本漂移？）。地图将只剩贴图、无烘焙光照。样本：' +
        JSON.stringify(samples);
      (globalThis as { __vbspLightmapInjectFailed?: boolean }).__vbspLightmapInjectFailed = true;
      console.error(message);
    } else if (injectBad > 0) {
      console.warn(
        `[lightmap] 有 ${injectBad} 个材质注入失效（成功 ${injectOk} 个）。样本：` +
          JSON.stringify(samples),
      );
    }
  }
