/**
 * lightmap 注入生效性统计（首帧后一次性诊断）：遍历场景材质上的注入记录，按阶段汇总
 * 注入/失效/跳过/预期失败，并打印 ambient cube、第 1 级逐顶点光照与 alpha 状态的接线统计。
 * 只读场景与 globalThis 的注入记录、只写日志与 `__vbspLightmapInjectFailed` 标记，不做任何渲染。
 */

import * as THREE from 'three';
import { VERTEX_LIGHTING_ATTR, getVertexLightingRelaxStats, getPropVertexRelax, getPropVertexFlatten } from '../../../../src/renderer-shared/shader/lightmap-shader.js';
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

    // 第 1 级 prop 光照（逐顶点预烘焙 → `_VBSP_VLIGHT` 几何属性）的接线校验：走这一级的材质数、
    // 注入是否生效、有没有失败。带属性却没注入记录的分两类：材质标了 `userData.unlit === true`
    // 的自发光 VMT 本就不吃光照（正确），其余算真漏网并打 error。
    {
      let vlOk = 0;
      let vlBad = 0;
      let vlUnlit = 0;
      let vlMissed = 0;
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
            else vlMissed++;
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
          `[vertex-lighting] 有 ${vlMissed} 个带 _VBSP_VLIGHT 的非 unlit mesh 没走到第 1 级材质 ⇒ 缺陷`,
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
