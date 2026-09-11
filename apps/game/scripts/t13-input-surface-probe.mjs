/**
 * t13 输入面探针（float_roundtrip 影响半径实验的观测仪）：把「serde_json 解析结果」
 * 变成位级可观测的输出行为，覆盖三条既有输入路径。
 *
 * 设计要点（为什么这样能测出解析差异）：
 *   A build_world（brush JSON 平面 dist）：地板顶面 dist = literal。玩家从 literal+10 落体，
 *     静止后 posY 逐位 = 解析出的 dist（物理剩余偏移两构建同源）→ dist 的 1-ULP 差异可见。
 *   B set_params（run_speed = literal）：前进 60 tick 后的 velX 由 run_speed 决定 →
 *     解析差异传播到位级。
 *   C set_spawn_points（[[0, literal, 0, 0]]）→ teleport_to_spawn(0)：origin.y 直接 = 解析值
 *     （无物理遍历，故对极端量级/次正规/2^53+1 同样灵敏）→ 覆盖 A/B 无法覆盖的极端字面量。
 *   ref：JS Number(literal)（JS 解析=IEEE 正确舍入）作为参照位型，用于判读某一侧是否偏 ULP。
 *
 * 用法：node scripts/t13-input-surface-probe.mjs [--wasm-dir=<repo 相对目录>]
 *   缺省 --wasm-dir=game/pkg（当前构建）；OFF 实验传 --wasm-dir=<OFF 构建产物目录>。
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
  '10.478655362066775',                    // t3 实测 fast parser 1-ULP 案例
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
  '2.2250738585072011e-308',               // serde_json 文档点名的 fast 路径偏差候选
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
// 理由：brush 平面 dist 经碰撞解算后被量化（A 面对 1 ULP 不敏感，见 ulp-sensitivity-control），
// 故补一条 build_world 输入面的**直读回显**通道：teleport 目的地 origin 由 JSON 解析后
// 原样进事件对象（take_event），无物理遍历 → 对极端字面量同样逐位可见。
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
