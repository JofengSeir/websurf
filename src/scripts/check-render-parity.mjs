/**
 * 渲染归属静态门禁：三端的「渲染步骤」必须只在共享 `RenderSession` 里存在。
 *
 * 背景（2026-10-23）：`assembleScene` 只统一了 GLB→终扫的 7 步；load/环境/天空/相机/可见性/
 * 画质/每帧 draw 仍是三份。事故：回退 VMT 表只装在 viewer 的 `core/bsp.ts`，debug/game 没装
 * ⇒ debug 水层 alpha=0 不绘制。本脚本把「哪些调用只许出现在共享层」写成可执行判据。
 *
 * 判据：
 *   1. `apps/<app>/src` 下的 TS 不得出现下列渲染步骤的调用/构造（注释不算）；
 *   2. 三端渲染入口必须引用 `RenderSession`（viewer `core/scene.ts`、game/debug `renderer-main.ts`）；
 *   3. 共享 `render-session.ts` 必须真的包含装配/天空/可见性三件事（防它被掏空后仍过关）。
 *
 * 用法：`node src/scripts/check-render-parity.mjs`（仓库根运行）。违规时 exit 1。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/** 只许出现在共享层 / 只许由共享会话调用的渲染步骤。 */
const FORBIDDEN = [
  ['new THREE.WebGLRenderer', '渲染器构造'],
  ['createRenderer(', '渲染器构造'],
  ['precompileScene(', '着色器预编译'],
  ['installRenderProbe(', '只读渲染探针'],
  ['assembleScene(', 'GLB 装配核'],
  ['mergeIntoChunks(', '分块合并'],
  ['mergeIntoNewRoot(', '分块合并'],
  ['optimizeScene(', '分块合并'],
  ['renderSkyPass(', '天空/主世界每帧绘制'],
  ['createSkyCamera(', '天空相机'],
  ['setSceneEnvironment(', '环境登记'],
  ['setSceneBackgroundColor(', '背景登记'],
  ['clearSceneEnvironment(', '环境清理'],
  ['applySceneCamera(', '相机 near/far/fov'],
  ['shrinkNearPlane(', '近平面贴墙'],
  ['new VisibilityController', '可见性判定'],
  ['new NearPlaneController', '近平面控制器'],
  ['new PvsManager', 'PVS 装载'],
  ['applySceneTextureQuality(', '贴图画质切换'],
  ['buildMapScene(', 'GLB → 场景'],
  ['applyLightmap(', 'lightmap 施加'],
  ['fullbrightUnlitLitMaterials(', '装配后终扫'],
  ['applyWorldTransitionShaders(', '世界过渡注入'],
  ['applyBumpShaders(', '法线注入'],
  ['applyWaterShaders(', '水面注入'],
  ['disposeObject(', '渲染资源释放'],
];

/** 三端渲染入口（必须引用共享 RenderSession）。 */
const ENTRY_FILES = [
  'apps/viewer/src/core/scene.ts',
  'apps/game/src/renderer/renderer-main.ts',
  'apps/debug/src/renderer/renderer-main.ts',
];

const SHARED_SESSION = 'src/renderer-shared/scene/render-session.ts';

/** 保留行号的注释剥离（块注释里的换行保留，行号不漂）。 */
function stripComments(text) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/(^|[^:])\/\/[^\n]*/gm, (m, prefix) => prefix + ' '.repeat(m.length - prefix.length));
  return out;
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

const violations = [];
for (const app of ['apps/debug', 'apps/game', 'apps/viewer']) {
  const src = join(ROOT, app, 'src');
  if (!existsSync(src)) continue;
  for (const file of walk(src)) {
    const code = stripComments(readFileSync(file, 'utf8'));
    const lines = code.split('\n');
    for (const [needle, what] of FORBIDDEN) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(needle)) {
          violations.push(`${relative(ROOT, file)}:${i + 1}  ${what} 只许出现在共享层（命中：${needle}）`);
        }
      }
    }
  }
}

for (const entry of ENTRY_FILES) {
  const p = join(ROOT, entry);
  if (!existsSync(p)) {
    violations.push(`${entry}  不存在（三端渲染入口清单过期）`);
    continue;
  }
  const text = readFileSync(p, 'utf8');
  if (!text.includes('RenderSession') || !text.includes('session.loadScene')) {
    violations.push(`${entry}  未引用共享 RenderSession / session.loadScene`);
  }
}

if (!existsSync(join(ROOT, SHARED_SESSION))) {
  violations.push(`${SHARED_SESSION}  不存在`);
} else {
  const shared = readFileSync(join(ROOT, SHARED_SESSION), 'utf8');
  for (const needle of ['assembleScene', 'renderSkyPass', 'VisibilityController', 'disposeScene']) {
    if (!shared.includes(needle)) violations.push(`${SHARED_SESSION}  缺少共享步骤：${needle}`);
  }
}

if (violations.length) {
  console.error(`[render-parity] 违规 ${violations.length} 处：`);
  for (const v of violations) console.error('  - ' + v);
  console.error('\n规则：渲染步骤只在 src/renderer-shared/scene/render-session.ts；apps 只保留数据源/输入/端特有 overlay。');
  process.exit(1);
}
console.log('[render-parity] OK：三端渲染入口都走共享 RenderSession，apps 内没有重写渲染步骤。');
