/**
 * 导入文件的类型识别：只看**文件头魔数**，不看扩展名。
 *
 * viewer 能收的四种文件在字节最前面就分得开，故一次切片即可判完：
 *
 * | 类型 | 魔数 | 判据来源 |
 * |---|---|---|
 * | `.bsp` 地图 | `VBSP`（前 4 字节） | 本文件的 `BSP_MAGIC` |
 * | Source `.dem` 录像 | `HL2DEMO\0`（前 8 字节） | `apps/viewer/src/replay/demo/demo.ts` 的 `looksLikeSourceDemo` |
 * | Shavit `.replay` 记录 | `{SHAVITREPLAYFORMAT}`（前 64 字节内） | `apps/viewer/src/replay/shavit-replay.ts` 的 `looksLikeShavitReplay` |
 * | KSF `.rec` 记录 | 小端 i32 魔数 2/3 + 头部界校验（前 24 字节） | `apps/viewer/src/replay/gokz-rec.ts` 的 `looksLikeGokzRec` |
 *
 * 后三条**复用各模块已有的嗅探函数**（不另立第二份魔数）；`.bsp` 的魔数没有既有判据可用——
 * 校验归 wasm 侧（`BspProcessor` 构造时解不出就抛，经 `apps/viewer/src/core/bsp.ts` 的
 * `loadBspFile` 上抛），故这里定义唯一一处常量供分派用。
 *
 * 本文件刻意**只依赖纯 TS 解析模块**（不引 `core/bsp.ts`，那会把 wasm 胶水拖进依赖），
 * 因此可以在 Node 自检里直接跑（见 `apps/viewer/test/replay-selftest.ts`）。
 *
 * 用途：入口分派（`apps/viewer/src/app.ts` 的 `routeFile`）与两个面板的入口自查
 * （`apps/viewer/src/replay/panel.ts` 的 `loadFile` 收 `replay`/`rec`、`apps/viewer/src/replay/demopanel.ts` 的 `load` 只收 `demo`）——
 * 用户从哪个入口丢进什么文件，去向由内容决定，不再由扩展名或「点的是哪个面板的按钮」决定。
 *
 * 边界：切片或读取抛错时一律按 `'unknown'` 返回，不抛异常（调用方只需处理五种取值）。
 */

import { looksLikeSourceDemo } from '../replay/demo/demo.js';
import { looksLikeShavitReplay, SHAVIT_SNIFF_BYTES } from '../replay/shavit-replay.js';
import { looksLikeGokzRec, GOKZ_REC_SNIFF_BYTES } from '../replay/gokz-rec.js';

/** `.bsp` 文件头魔数（4 字节 ASCII）。全仓唯一一处定义，只服务本文件的识别。 */
export const BSP_MAGIC = 'VBSP';

/** 识别结果；`'unknown'` = 四种魔数都没命中。 */
export type FileKind = 'bsp' | 'replay' | 'demo' | 'rec' | 'unknown';

/** 切片长度：取各判定的最大需求（Shavit 的魔数声明在前 64 字节内，见 `SHAVIT_SNIFF_BYTES`）。 */
const SNIFF_BYTES = Math.max(SHAVIT_SNIFF_BYTES, BSP_MAGIC.length, 8, GOKZ_REC_SNIFF_BYTES);

/** 各类型的展示名（错误提示与面板文案共用，避免各处手写导致口径不一）。 */
export const FILE_KIND_LABEL: Record<FileKind, string> = {
  bsp: '.bsp 地图',
  replay: '.replay 记录',
  demo: '.dem 录像',
  rec: '.rec 记录（KSF）',
  unknown: '未知类型',
};

/** 前缀比较（大小写敏感；三种魔数全是 ASCII）。 */
function startsWithAscii(head: Uint8Array, magic: string): boolean {
  if (head.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (head[i] !== magic.charCodeAt(i)) return false;
  return true;
}

/** 已取到的文件头 → 类型。四种魔数在文件头的位置互不重叠，判定顺序不影响结果。 */
export function kindOfHead(head: Uint8Array): FileKind {
  if (startsWithAscii(head, BSP_MAGIC)) return 'bsp';
  if (looksLikeSourceDemo(head)) return 'demo';
  if (looksLikeShavitReplay(head)) return 'replay';
  if (looksLikeGokzRec(head)) return 'rec';
  return 'unknown';
}

/** 文件 → 类型：只读前 `SNIFF_BYTES` 字节，不整份读入。切片或读取抛错时按 `'unknown'` 返回。 */
export async function sniffFileKind(file: File): Promise<FileKind> {
  try {
    return kindOfHead(new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer()));
  } catch {
    return 'unknown';
  }
}
