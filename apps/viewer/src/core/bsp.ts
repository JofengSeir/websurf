/** BSP 加载：WASM 懒初始化 → metadata → spawn → GLB。消费顺序固定（GLB 必须最后）。 */

import { BspProcessor, initSync } from '../../pkg/websurf_viewer_wasm.js';

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
  /** 推荐出生点索引（优先 info_player_start）。 */
  primary: number;
  glbBytes: ArrayBuffer;
  /** 主线程解析耗时（ms）。 */
  elapsedMs: number;
}

let wasmReady: Promise<void> | null = null;

/**
 * 单文件（file:// 双击）构建时，WASM 以 base64 内嵌在 app.js 的
 * `globalThis.__VBSP_WASM_B64__` 里（见 scripts/build-dist.mjs single 模式）。
 * 有内嵌字节就直接 initSync，不 fetch——file:// 下 fetch 会被浏览器拦截。
 */
export function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const g = globalThis as { __VBSP_WASM_B64__?: unknown };
      if (typeof g.__VBSP_WASM_B64__ === 'string' && g.__VBSP_WASM_B64__.length > 0) {
        const bin = atob(g.__VBSP_WASM_B64__);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        initSync({ module: bytes });
        return;
      }
      const url = new URL('./websurf_viewer_wasm_bg.wasm', import.meta.url);
      let resp: Response;
      try {
        resp = await fetch(url);
      } catch {
        throw new Error('WASM 文件请求失败：请确认通过 npm run dev 启动并访问 http://localhost:8080/');
      }
      if (!resp.ok) {
        throw new Error(
          `fetch wasm → ${resp.status}：缺少 WASM 产物，请在 viewer/ 目录先运行 npm run build:wasm`,
        );
      }
      initSync({ module: await resp.arrayBuffer() });
    })();
  }
  return wasmReady;
}

export async function loadBspFile(file: File): Promise<BspLoadResult> {
  await ensureWasm();
  // 先让 UI 刷新（大图解析可能数百 ms）
  await new Promise((r) => setTimeout(r, 0));

  const t0 = performance.now();
  const proc = new BspProcessor(new Uint8Array(await file.arrayBuffer()));
  const meta = JSON.parse(proc.metadata()) as BspMeta;
  // 借用导出（spawn）必须在消费 BSP 的 export_glb* 之前调用
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

/** 把底层异常翻译成人话；返回 [人类可读, 原始信息]。 */
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
