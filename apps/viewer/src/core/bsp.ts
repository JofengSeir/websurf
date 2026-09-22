/**
 * BSP 加载：WASM 懒初始化 → 元数据 → 出生点 → GLB 导出。
 *
 * `loadBspFile` 的三步顺序被 wasm 侧的借用语义固死：`BspProcessor` 的 `metadata()` 与
 * `parse_spawn_points()` 都是**借用**方法，而 `export_glb_with_pakfile_models()` 会
 * **消耗**内部 Bsp 实例，故 GLB 导出必须是最后一步（约束写在
 * `apps/viewer/crates/wasm/src/lib.rs` 的 `export_glb_with_pakfile_models` 文档注释里）。
 *
 * 结构映射：`BspMeta` 是 `metadata()` JSON 的宽松映射（字段全部可选），
 * `SpawnPoint` 与 `BspLoadResult` 分别对应 `parse_spawn_points()` 的元素与本次加载的汇总。
 *
 * 失败面：`ensureWasm` 或解析抛错时由调用方 `apps/viewer/src/app.ts` 的 `loadBsp` 捕获，
 * 交给 `humanizeBspError` 翻译成人话再经 HUD 显示。本文件不碰 UI、不碰相机，
 * 只做「字节 → 结构化结果」。
 */

import { BspProcessor, initSync } from '../../pkg/websurf_viewer_wasm.js';
import { base64ToBytes, readEmbeddedWasmB64 } from '../../../../src/ts-shared/wasm/loader.js';

export interface BspMeta {
  schema_version?: number;
  magic?: string;
  map_name?: string;
  num_models?: number;
  num_faces?: number;
  num_vertices?: number;
  num_brushes?: number;
  num_static_props?: number;
  packed_files?: number;
}

export interface SpawnPoint {
  classname: string;
  origin: number[];
  angles: number[];
}

export interface BspLoadResult {
  fileName: string;
  meta: BspMeta;
  spawnPoints: SpawnPoint[];
  /** 推荐出生点下标（wasm 规则：有 info_player_start 时取它的下标，否则 0）。 */
  primary: number;
  glbBytes: ArrayBuffer;
  /** 解析 + GLB 导出的耗时（ms），`performance.now()` 前后差值。 */
  elapsedMs: number;
}

let wasmReady: Promise<void> | null = null;

/** 动态插入 classic `<script>` 并等它加载完（回退分支加载 wasm-embedded.js 用）。 */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`script 加载失败: ${src}`));
    document.head.appendChild(s);
  });
}
/**
 * 确保 WASM 就绪。结果缓存在模块级 `wasmReady`，重复调用只 await 同一个 Promise。
 *
 * 三条取值路径按序短路：
 * 1. `globalThis.__VBSP_WASM_B64__` 命中 ⇒ `initSync`（single 打包把 base64 内嵌在 app.js，
 *    `file://` 下不 fetch）；
 * 2. `fetch` 同目录的 `websurf_viewer_wasm_bg.wasm` 成功 ⇒ `initSync`（multi 部署主路径）；
 * 3. 动态加载 `wasm-embedded.js` 后重读同一全局键 ⇒ `initSync`（multi 构建的内嵌副本）。
 * 三条都不通时抛错，文案带 `npm run build:wasm` 提示。
 *
 * 内嵌判定走共享层 `src/ts-shared/wasm/loader.ts` 的 `readEmbeddedWasmB64`
 * （口径 = 非空字符串）：空串或非字符串注入不算命中。
 */
export function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      // 判定统一为「非空字符串」（共享层 loader）：空串 / 非字符串注入不算命中
      const embedded = readEmbeddedWasmB64();
      if (embedded) {
        // single 构建（file:// 双击）：base64 内嵌在 app.js，直接同步初始化
        console.log('[wasm] 路径：内嵌命中（single 构建的 app.js 内嵌）');
        initSync({ module: base64ToBytes(embedded) });
        return;
      }
      // ① 请求外置 WASM（multi 部署主路径；dev 同源也走这条）
      const url = new URL('./websurf_viewer_wasm_bg.wasm', import.meta.url);
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          console.log('[wasm] 路径：外置请求成功（multi 部署主路径）');
          initSync({ module: await resp.arrayBuffer() });
          return;
        }
        console.warn(`[wasm] 外置请求 ${resp.status}，回退内嵌副本…`);
      } catch {
        console.warn('[wasm] 外置请求失败（file:// 或网络），回退内嵌副本…');
      }
      // ② 回退：动态加载 wasm-embedded.js（multi 构建生成的内嵌副本）
      await loadScript(new URL('./wasm-embedded.js', import.meta.url).href);
      const fallback = readEmbeddedWasmB64();
      if (fallback) {
        console.log('[wasm] 路径：内嵌回退副本命中（wasm-embedded.js）');
        initSync({ module: base64ToBytes(fallback) });
        return;
      }
      // ③ 外置与内嵌回退都不可用 → 抛错
      throw new Error(
        'WASM 加载失败：外置请求与内嵌回退均不可用——请运行 npm run build:wasm 后重试',
      );
    })();
  }
  return wasmReady;
}

export async function loadBspFile(file: File): Promise<BspLoadResult> {
  await ensureWasm();
  // 先让出一帧：解析与导出都在同步段内完成，不给浏览器绘制机会就没有加载反馈
  await new Promise((r) => setTimeout(r, 0));

  const t0 = performance.now();
  const proc = new BspProcessor(new Uint8Array(await file.arrayBuffer()));
  const meta = JSON.parse(proc.metadata()) as BspMeta;
  // parse_spawn_points 是借用方法，必须在消耗 Bsp 实例的 GLB 导出之前调用
  const spawnJson = proc.parse_spawn_points();
  const glb = proc.export_glb_with_pakfile_models();
  const glbBytes = glb.buffer.slice(
    glb.byteOffset,
    glb.byteOffset + glb.byteLength,
  ) as ArrayBuffer;
  const elapsedMs = performance.now() - t0;

  const spawnData = JSON.parse(spawnJson) as {
    spawn_points?: SpawnPoint[];
    primary?: number;
    total?: number;
  };
  const spawnPoints = spawnData.spawn_points ?? [];
  const primary = spawnData.primary ?? 0;

  return { fileName: file.name, meta, spawnPoints, primary, glbBytes, elapsedMs };
}

/**
 * 把底层异常翻译成人话；返回 [给人看的一句, 原始信息]。
 * 判据是对 `message` 依次做正则匹配（解析类 → WASM/网络类 → 内存类），全不中时给通用文案；
 * 第二个元素始终是原始信息，供引导层的「详情」行展示。
 */
export function humanizeBspError(e: unknown): [string, string] {
  const raw = e instanceof Error ? e.message : String(e);
  if (/magic|format|parse|binrw|unexpected|invalid/i.test(raw)) {
    return ['这不是有效的（或暂不支持的）BSP 地图文件', raw];
  }
  if (/wasm|fetch|404|network/i.test(raw)) {
    return ['运行时组件缺失：请先完成构建（npm run build:wasm）', raw];
  }
  if (/memory|allocation/i.test(raw)) {
    return ['地图过大，内存不足导致解析失败', raw];
  }
  return ['地图加载失败', raw];
}
