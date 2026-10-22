/**
 * 回退 VMT 文本表的装载（三端共用一处，owner 规则：装配不得各端各写一份）。
 *
 * 数据源：`src/materials/vmts-fallback.json` → 各端 `web/vmts.json`（dev 由
 * `src/scripts/sync-web-assets.mjs` 分发；dist 由各端 `scripts/build-dist.mjs` 复制）。
 *
 * 只收**游戏本体自带**、且与游戏安装目录 VPK 逐字节对上的材质原文（见 JSON 内 6 条）。
 * 地图 pakfile 里没有这些 VMT 时，导出期靠它拿到真实 `$fogcolor` / `$translucent` 等参数。
 * 取不到就跳过：材质侧按「数据缺失」处理并告警，**不编造缺省值**（owner 2026-10-22 规则）。
 */
export interface VmtFallbackInstaller {
  setVmtFallback?: (json: string) => void;
}

/**
 * 拉取并装入回退 VMT 表；返回装入条数（0 = 未装入/不可用）。
 *
 * 失败不抛：调用点都在导出主链路前，缺表只应降级为「缺 VMT」，不应阻断加载。
 */
export async function installVmtFallback(
  proc: unknown,
  url = 'vmts.json',
): Promise<number> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[vmt-fallback] ${url} 不可用（HTTP ${res.status}）⇒ 缺 VMT 的材质按数据缺失处理`);
      return 0;
    }
    const text = await res.text();
    const setter = (proc as VmtFallbackInstaller | null)?.setVmtFallback;
    if (typeof setter !== 'function') {
      console.warn('[vmt-fallback] 本构建未导出 setVmtFallback ⇒ 回退表未生效');
      return 0;
    }
    setter.call(proc, text);
    const count = Object.keys(JSON.parse(text) as Record<string, unknown>).length;
    console.info(`[vmt-fallback] 已装入 ${count} 条（${url}）`);
    return count;
  } catch (e) {
    console.warn('[vmt-fallback] 读取/解析失败 ⇒ 缺 VMT 的材质按数据缺失处理:', e);
    return 0;
  }
}
