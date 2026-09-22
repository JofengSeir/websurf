/**
 * 输入面探针（脚本名 `t13-input-surface-probe`）：把「`serde_json` 的解析结果」变成位级可观测
 * 的输出行为，覆盖四条输入路径。
 *
 * 设计要点（为什么这样能测出解析差异）：
 *   A `build_world` 的 brush JSON 平面 `dist`：地板顶面 `dist = literal`，玩家自 `literal + 10`
 *     落体（出生 Y 用 JS 的 `Number(literal)` 算，不经 JSON），90 tick 后读 `state().posY`。
 *     落点要过碰撞解算，分辨率被量化，故只对足够大的 dist 差可见——量化尺度见
 *     `apps/game/scripts/t13-ulp-sensitivity-control.mjs` 的 A-threshold 扫描。
 *   B `set_params` 的 `run_speed = literal`：前进 60 tick 后读 velX/velY/velZ/posX，由该值决定
 *     → 解析差异传播到位级。
 *   C `set_spawn_points` 的 `[[0, literal, 0, 0]]` → `teleport_to_spawn(0)` 后读 `state().posY`
 *     （不经碰撞解算，故对极端量级/次正规/2^53+1 同样灵敏）。
 *   D `build_world` 的 teleport JSON `origin`：`take_event()` 拿到的传送事件里 `origin` 即解析值
 *     （`src/phys/mod.rs` 在 `check` 命中后用 `dest.origin` 组事件），与 C 同为精确回显面。
 *   ref `JS Number(literal)`（JS 解析 = IEEE 正确舍入）作为参照位型，用于判读某一侧是否偏 ULP。
 *
 * 解析路径差异的来源：`serde_json` 的 `float_roundtrip` —— `src/Cargo.toml` 开启，
 * `src/wasm-core/Cargo.toml` 与三工程 `crates/wasm/Cargo.toml` 取默认 features。
 *
 * 用法：node scripts/t13-input-surface-probe.mjs [--wasm-dir=<repo 相对目录>]
 *   缺省 --wasm-dir=apps/game/pkg（当前构建）；对比实验传 --wasm-dir=<另一构建的产物目录>。
 * 只读：不写任何文件（输出 JSON 到 stdout）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..'); // apps/game（脚本位于 scripts/，其上一级即工程根）
const argDir = process.argv.find((a) => a.startsWith('--wasm-dir='));
const WASM_DIR = argDir ? resolve(argDir.slice('--wasm-dir='.length)) : join(APP, 'pkg');

const mod = await import(pathToFileURL(join(WASM_DIR, 'websurf_wasm.js')).href);
const wasmBytes = readFileSync(join(WASM_DIR, 'websurf_wasm_bg.wasm'));
const initOut = mod.initSync({ module: wasmBytes });
const PhysWorld = mod.PhysWorld;
const DT = 1 / 64;

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
/** f64 → 16 位十六进制位型。 */
function b(x) {
  f64[0] = x;
  return u64[0].toString(16).padStart(16, '0');
}

// ── A/B 面：量级可落体/可加速的字面量（含最短表示与超长表示对照）─────────
const ADV = [
  '10.478655362066775',                    // 与 apps/game/scripts/t13-ulp-sensitivity-control.mjs 的 A 面同基数
  '100.00000000000001',
  '1234.5678901234567',                    // 17 位（最短表示的极端长度）
  '0.1',
  '0.1000000000000000055511151231257827',  // 0.1 的精确十进制展开（34 位）
  '123.4567890123456789012345',            // 25 位
  '3.0000000000000004',
  '0.30000000000000004',
  '100',                                   // 与 "1e2" 同值对照
];
// ── C 面：全量对抗字面量（含 2^53+1 / 极值 / 次正规 / 负零）──────────────
const ADV_EXTREME = [
  ...ADV,
  '1e2',
  '9007199254740993',                      // 2^53+1（tie）
  '1e23',
  '1.7976931348623157e308',                // f64 max
  '2.2250738585072014e-308',               // 最小正规数
  '2.2250738585072011e-308',               // 与上一行仅末位不同（最小正规数下侧的相邻十进制）
  '5e-324',                                // 最小次正规
  '-0.0',
  '0',
];

function floorBrush(topDist) {
  return `[{"planes":[{"normal":[0,1,0],"dist":${topDist}},{"normal":[0,-1,0],"dist":0},{"normal":[1,0,0],"dist":1e6},{"normal":[-1,0,0],"dist":1e6},{"normal":[0,0,1],"dist":1e6},{"normal":[0,0,-1],"dist":1e6}],"min":[-1e6,0,-1e6],"max":[1e6,1e7,1e6],"is_ladder":false,"is_solid":true}]`;
}
const NO_TELE = JSON.stringify({ teleports: [], triggers: [] });

const out = {
  probe: 't13-input-surface',
  wasmDir: relative(APP, WASM_DIR),
  wasmSha256File: join(WASM_DIR, 'websurf_wasm_bg.wasm'),
  surfaces: {},
};

// ── A：build_world 平面 dist 解析 → 静止 posY ────────────────────────────
{
  const rows = [];
  for (const v of ADV) {
    const w = new PhysWorld();
    const spawnY = Number(v) + 10;
    w.build_world(floorBrush(v), '[]', NO_TELE, 0, spawnY, 0, 0);
    for (let i = 0; i < 90; i++) w.tick(DT, 0, 0, 0);
    const s = w.state();
    rows.push({ literal: v, refJS: b(Number(v)), posY: b(s.posY), posX: b(s.posX), onGround: s.onGround });
    w.free();
  }
  out.surfaces.build_world = rows;
}

// ── B：set_params run_speed 解析 → 60 tick 后 velX ───────────────────────
{
  const rows = [];
  for (const v of ADV) {
    const w = new PhysWorld();
    w.build_world(floorBrush('0'), '[]', NO_TELE, 0, 20, 0, 0);
    for (let i = 0; i < 10; i++) w.tick(DT, 0, 0, 0); // 落稳
    w.set_params(`{"run_speed":${v}}`);
    for (let i = 0; i < 60; i++) w.tick(DT, 1, 0, 0); // 前进
    const s = w.state();
    rows.push({ literal: v, refJS: b(Number(v)), velX: b(s.velX), velY: b(s.velY), velZ: b(s.velZ), posX: b(s.posX) });
    w.free();
  }
  out.surfaces.set_params = rows;
}

// ── C：set_spawn_points 解析 → teleport_to_spawn(0) 后 origin ───────────
{
  const rows = [];
  for (const v of ADV_EXTREME) {
    const w = new PhysWorld();
    w.build_world(floorBrush('0'), '[]', NO_TELE, 0, 20, 0, 0);
    w.set_spawn_points(`[[0,${v},0,0]]`);
    w.teleport_to_spawn(0);
    const s = w.state();
    rows.push({ literal: v, refJS: b(Number(v)), posY: b(s.posY), yaw: b(s.yaw) });
    w.free();
  }
  out.surfaces.set_spawn_points = rows;
}

// ── D：build_world 的 teleport JSON 解析 → 事件 origin 直读（精确回显面）────
// 理由：A 面的落点要过碰撞解算、分辨率被量化，故补一条同属 build_world 但**不经碰撞**的直读
// 通道——目的地 origin 逐字段取自解析结果（`src/phys/teleport.rs` 的
// `TeleportManager::from_json`），`check` 命中后由 `src/phys/mod.rs` 用 `dest.origin` 组事件，
// 故 `take_event()` 读到的 origin 对极端字面量逐位可见。
{
  const rows = [];
  for (const v of ADV_EXTREME) {
    const tele = `{"teleports":[{"index":0,"targetname":"tpd","origin":[0,${v},0],"angles":[0,0,0]}],"triggers":[{"index":0,"classname":"trigger_teleport","target":"tpd","origin":[0,0,0],"model_mins":[-50,-50,-50],"model_maxs":[50,300,50],"spawnflags":1}]}`;
    const w = new PhysWorld();
    w.build_world(floorBrush('0'), '[]', tele, 0, 20, 0, 0);
    let ev = null;
    for (let i = 0; i < 8 && !ev; i++) {
      w.tick(DT, 0, 0, 0);
      ev = w.take_event();
    }
    const o = ev && ev.kind === 'teleport' && Array.isArray(ev.origin) ? ev.origin[1] : null;
    rows.push({
      literal: v,
      refJS: b(Number(v)),
      eventKind: ev ? ev.kind : null,
      destY: o === null ? null : b(o),
    });
    w.free();
  }
  out.surfaces.build_world_teleport_echo = rows;
}

console.log(JSON.stringify(out, null, 1));
