/**
 * 单测：跨线程状态通道的槽位布局与发布/读取语义。
 *
 * 覆盖（对应 `src/ts-shared/auth/shared-state.ts` 的常量与两个实现）：
 * - **字节核算**：四个协议槽 = `i32[5..8]` → 字节 20-35，落在 i32 保留区 20-63 内；
 *   与全部 i64 锚（输入槽与两个帧双缓冲）无重叠；帧锚与 512B 总量保持不变。
 * - **`AUTH_EVT` 位定义**：低 8 位恰好 8 个互异取值且都 `< 256`；`AUTH_EVT_OPT = 256`；
 *   OPT 位与低 8 位位集不相交（乐观帧「bit8 置位、低 8 位恒 0」的编码前提）。
 * - **`ShmState` 往返**：`V_A = 0` 时返回 0 且不动 `dst`；无 meta 发布对四个协议槽
 *   **逐字节零触碰**（预置哨兵验证，含「tick 模式用过之后回耦合发布」的跨模式断言）；
 *   定点倍数还原（pos/vel/eyeHeight ÷100、yaw/pitch ÷1000、timeMs 原值）；
 *   `dst` 超出 [0..9] 的部分不被写；带 meta 发布后 `seg/tick/evt` 落槽且 PSEQ 回到偶值。
 * - **沿用 / 逐帧语义**：meta 省略 `seg` 则沿用、省略 `evt` 则写 0；无 meta 发布不递增
 *   tick（`publishCurrentState` 路径）。
 * - **seqlock**：PSEQ 奇数态 → 两次尝试都弃读 → 返回 −1 且 `dst` 未被写；偶值可读。
 * - **i32 回绕**：`Atomics.store` 按 mod 2^32 截断，i32 距离 `(b−a)|0` 仍可判相邻；
 *   `prev(i32min) = i32max`；PSEQ 的 +2 步进跨回绕仍保持奇偶。
 * - **`MsgState` 消息路径**：无 meta 时消息形态不变；`recvFrame` 前读返回 0；
 *   带 meta 的消息携带 `seg/tick/evt`，粘滞镜像往返一致，省略 `seg` 沿用、`tick` 覆盖。
 * - **读侧一致性（探针接缝）**：偶值快照 + 复检 + 代际复检三层，配三处可选回调把
 *   「写者读中插入」确定性注入，覆盖插入即翻、连两次翻 → −1、以及只有代际复检能拒的
 *   「旧 `V_A` × 新代偶值 PSEQ」窗口；另用 raw store 构造 f' 写序的中段/尾段停点。
 * - **传输透明**：低 8 位事件值原样落槽，传输层不会自动补 bit8。
 *
 * 运行（node，不需要浏览器）——**路径以本仓实际布局为准**：
 *   cd apps/game && npx esbuild ../../src/ts-shared/auth/shared-state.protocol.test.ts \
 *     --bundle --format=esm --platform=node --outfile=node_modules/.cache/t4-tests/shared-state.test.mjs \
 *     && node node_modules/.cache/t4-tests/shared-state.test.mjs
 *
 * 断言标签与 `console.log` 分组名里含「SG-xx」「§x.y」「t2/t5/t11」这类历史编号，它们是
 * **字符串字面量而非注释**，本次注释重编不改动（同 §7.3 #36 的处置口径）。
 */

import {
  I_A_SEG,
  I_A_TICK,
  I_A_EVT,
  I_A_PSEQ,
  AUTH_EVT,
  AUTH_EVT_OPT,
  SHARED_BUFFER_SIZE,
  B_DX_ACC,
  B_DY_ACC,
  B_A0,
  B_A1,
  B_D0,
  B_D1,
  ShmState,
  MsgState,
  type AuthPublishMeta,
} from './shared-state.js';
import { EYE_STAND } from '../phys/constants.js';

let passed = 0;
let failed = 0;
function expect(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`);
  }
}
const PROTO_SLOTS = [I_A_SEG, I_A_TICK, I_A_EVT, I_A_PSEQ] as const;

// ── 1. 字节核算（20-63B 保留区；i64 区零冲突）────────────────
console.log('[1] byte layout audit');
expect(I_A_SEG === 5 && I_A_TICK === 6 && I_A_EVT === 7 && I_A_PSEQ === 8, 'slots = i32[5][6][7][8]');
for (const s of PROTO_SLOTS) {
  const lo = s * 4;
  const hi = s * 4 + 3;
  expect(lo >= 20 && hi <= 63, `i32[${s}] → bytes ${lo}-${hi} ⊂ reserved 20-63`);
}
// i64 锚：i64[i] = bytes 8i..8i+7；全部帧/输入区自字节 64 起
const i64Anchors = [B_DX_ACC, B_DY_ACC, B_A0, B_A1, B_D0, B_D1];
expect(
  i64Anchors.every((a) => a * 8 >= 64),
  'all i64 regions start at byte ≥ 64 (B_DX_ACC=i64[8] → 64-71)',
);
for (const s of PROTO_SLOTS) {
  const lo = s * 4;
  const hi = s * 4 + 3;
  const clash = i64Anchors.some((a) => lo <= a * 8 + 7 && hi >= a * 8);
  expect(!clash, `i32[${s}] (bytes ${lo}-${hi}) no overlap with any i64 region`);
}
expect(
  B_A0 === 16 && B_A1 === 26 && B_D0 === 36 && B_D1 === 46,
  'frame anchors unchanged (既有布局零破坏)',
);
expect(SHARED_BUFFER_SIZE === 512, 'SAB 总字节 512（不变）');

// ── 2. I_A_EVT 位定义 ────────────────────────────────────────
console.log('[2] AUTH_EVT bit definitions');
const evtVals = Object.values(AUTH_EVT);
expect(evtVals.length === 8, 'SG-§2.5 8 event types (内核 2 + 控制面 6, t3-memo §13.1 双源)');
expect(evtVals.every((v) => v >= 1 && v < 256), 'SG-M1 前提 event bits within bit0-7');
expect(new Set(evtVals).size === 8, 'SG-M1 前提 event bits pairwise distinct');
expect(AUTH_EVT_OPT === 256, 'SG-M1 OPT = bit8 (256, t6 §8.1)');
expect(
  evtVals.every((v) => (v & AUTH_EVT_OPT) === 0) && (AUTH_EVT_OPT & 0xff) === 0,
  'SG-M1/M4 OPT 位单向性：bit8 与 bit0-7 位集不相交（emit 帧 evt=bit8∧低8≡0 / auth 恒不携 bit8 的编码前提）',
);

// ── 3. ShmState 发布/读取往返 ────────────────────────────────
console.log('[3] ShmState meta publish/read round-trip');
const F1 = {
  pos: { x: 100.5, y: -50.25, z: 3000.75 },
  yaw: 179.999,
  pitch: -45.5,
  vel: { x: 350.12, y: 7.89, z: -12.34 },
  onGround: true,
  eyeHeight: EYE_STAND,
  timeMs: 123456,
};
const F2 = {
  pos: { x: 101.5, y: -50.5, z: 3055.25 },
  yaw: -179.5,
  pitch: -44.25,
  vel: { x: 351.5, y: 8.0, z: -12.0 },
  onGround: false,
  eyeHeight: 32.05,
  timeMs: 123471,
};
const sab = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
const shm = new ShmState(sab);
const rawI32 = new Int32Array(sab);
const dstF = new Float64Array(12);
const dstI = new Int32Array(6);

// 通道未开始：返回 0 且不动 dst
dstF.fill(123.456);
dstI.fill(-7);
expect(shm.readAuthoritativeInto(dstF, dstI) === 0, 'V_A=0 → return 0');
expect(dstF[0] === 123.456 && dstI[0] === -7, 'dst untouched before start');

// 无 meta 发布（耦合/解耦路径）：四个协议槽逐字节零触碰（先预置哨兵）
rawI32[I_A_SEG] = 777;
rawI32[I_A_TICK] = 888;
rawI32[I_A_EVT] = 999;
rawI32[I_A_PSEQ] = 1010;
const va1 = shm.writeAuthoritative(F1, true);
expect(va1 === 1, 'first publish va=1');
expect(
  rawI32[I_A_SEG] === 777 && rawI32[I_A_TICK] === 888 && rawI32[I_A_EVT] === 999 && rawI32[I_A_PSEQ] === 1010,
  'no-meta publish: all four proto slots byte-untouched (additive-only)',
);
expect(shm.readAuthoritativeInto(dstF, dstI) === 1, 'read into returns va=1');
expect(dstF[0] === 100.5 && dstF[1] === -50.25 && dstF[2] === 3000.75, 'pos定点还原 (÷100)');
expect(dstF[3] === 179.999 && dstF[4] === -45.5, 'yaw/pitch定点还原 (÷1000)');
expect(dstF[5] === 350.12 && dstF[6] === 7.89 && dstF[7] === -12.34, 'vel定点还原 (÷100)');
expect(dstF[8] === EYE_STAND && dstF[9] === 123456, 'eyeHeight/timeMs还原（D-16 共享常量，非字面量）');
expect(dstF[10] === 123.456 && dstF[11] === 123.456, 'dst beyond [0..9] untouched (契约 10 值)');
expect(dstI[0] === 1 && dstI[1] === 1, 'onGround=1, va=1');
expect(dstI[2] === 777 && dstI[3] === 888 && dstI[4] === 999, 'proto slots pass through (耦合期消费器不读)');

// 带 meta 发布（tick 模式）：seg/tick/evt 落槽，且 PSEQ 恢复偶态
const va2 = shm.writeAuthoritative(F2, false, { seg: 3, tick: 41, evt: AUTH_EVT_OPT });
expect(va2 === 2, 'second publish va=2');
expect(rawI32[I_A_PSEQ] % 2 === 0, 'SG-③ PSEQ back to even after publish (seqlock 纪律)');
expect(shm.readAuthoritativeInto(dstF, dstI) === 2, 'read returns va=2');
expect(dstI[0] === 0 && dstI[1] === 2, 'onGround=0, va=2');
expect(dstI[2] === 3 && dstI[3] === 41 && dstI[4] === AUTH_EVT_OPT, 'SG-M1/M2/M3 seg/tick/evt round-trip（tickIndex 配对键=meta 传入值；segId 语义=meta 显式值）');
expect(dstF[3] === -179.5 && dstF[8] === 32.05, 'frame2 values restored');

// 沿用/逐帧语义：meta 只带 tick → seg 沿用；省略 evt → 写 0
shm.writeAuthoritative(F1, false, { tick: 42 });
expect(shm.readAuthoritativeInto(dstF, dstI) === 3, 'third publish va=3');
expect(dstI[2] === 3, 'SG-M3 seg omitted → 沿用（segId 非断窗不变语义）');
expect(dstI[3] === 42, 'SG-M2 tick=42 written（tickIndex 配对键载体）');
expect(dstI[4] === 0, 'SG-③ evt omitted → 写 0 (逐帧量非粘滞量)');
// 无 meta 发布（publishCurrentState 路径）：不递增 tick，沿用 42
shm.writeAuthoritative(F1, false);
expect(shm.readAuthoritativeInto(dstF, dstI) === 4, 'fourth publish va=4');
expect(dstI[3] === 42, 'no-meta publish keeps tick=42 (publishCurrentState 不递增)');
// 跨模式零触碰：tick 模式用过之后，无 meta 发布仍不动协议槽
rawI32[I_A_SEG] = 555;
shm.writeAuthoritative(F1, true);
expect(rawI32[I_A_SEG] === 555, 'coupled publish after tick usage: proto slots still untouched');

// ── 4. seqlock 奇数态 → −1 冲突契约 ─────────────────────────
console.log('[4] PSEQ seqlock contract (SG-③)');
dstF.fill(0);
dstI.fill(0);
Atomics.store(rawI32, I_A_PSEQ, 99); // 模拟写者发布中（奇数态）
const r = shm.readAuthoritativeInto(dstF, dstI);
expect(r === -1, 'SG-③ odd PSEQ → both attempts bail → −1 (读写冲突契约)');
expect(dstI[0] === 0 && dstI[1] === 0, '−1 path: dst content弃用 (未写入)');
Atomics.store(rawI32, I_A_PSEQ, 100);
expect(shm.readAuthoritativeInto(dstF, dstI) >= 1, 'even PSEQ → read succeeds');

// ── 4b. i32 wrap 语义（tick 标签算术 wrap-safe）──────────────
console.log('[4b] i32 wrap semantics');
// I_A_TICK 槽的 i32 回绕：tick 索引以 raw 64Hz 约 2^31/64Hz ≈ 388 天一巡；槽语义
// = mod 2^32（Atomics.store 截断），消费端比较用 i32 距离 `(b−a)|0`。
Atomics.store(rawI32, I_A_TICK, 2147483647);
expect(rawI32[I_A_TICK] === 2147483647, 'i32 max stored as-is');
Atomics.store(rawI32, I_A_TICK, 2147483648);
expect(rawI32[I_A_TICK] === -2147483648, 'i32 wrap: 2^31 → −2^31 (mod 2^32)');
const wrapA = -2147483648;
expect(((wrapA + 1 - wrapA) | 0) === 1, 'wrap-safe i32 diff: 相邻标签距离 = 1');
expect(((wrapA - 1) | 0) === 2147483647, 'prev(i32min) = i32max（wrap 连续，乐观 label 锚不破）');
// PSEQ 的 +2 步进跨回绕仍保奇偶：边界偶值 → +1 奇（写中旗标）→ +2 回绕后仍偶
Atomics.store(rawI32, I_A_PSEQ, 2147483646);
shm.writeAuthoritative(F1, false, { tick: 43 });
expect(rawI32[I_A_PSEQ] % 2 === 0, 'PSEQ +2 wrap preserves parity (边界偶 → 回绕偶)');
expect(shm.readAuthoritativeInto(dstF, dstI) >= 1, 'read path 不因 wrap 误拒');

// ── 5. MsgState 双喂 ─────────────────────────────────────────
console.log('[5] MsgState meta message path');
let lastMsg: Record<string, unknown> | null = null;
(globalThis as unknown as { self?: unknown }).self = {
  postMessage: (m: unknown) => {
    lastMsg = m as Record<string, unknown>;
  },
};
const msg = new MsgState(null);
const mva1 = msg.writeAuthoritative(F1, true);
expect(mva1 === 1, 'MsgState first publish va=1');
expect(lastMsg !== null && !('seg' in lastMsg) && !('tick' in lastMsg) && !('evt' in lastMsg), 'no-meta message shape unchanged');
const dstF2 = new Float64Array(10);
const dstI2 = new Int32Array(5);
expect(msg.readAuthoritativeInto(dstF2, dstI2) === 0, 'MsgState read before recvFrame → 0');
// 模拟 app.ts 转发（把消息里的 meta 交给 recvFrame）
msg.recvFrame(F1, 1);
expect(msg.readAuthoritativeInto(dstF2, dstI2) === 1, 'recvFrame → read returns va=1');
expect(dstI2[2] === 0 && dstI2[3] === 0 && dstI2[4] === 0, 'no-meta message → sticky mirror stays 0');
msg.writeAuthoritative(F2, false, { seg: 5, tick: 7, evt: AUTH_EVT_OPT } satisfies AuthPublishMeta);
expect(lastMsg !== null && lastMsg['seg'] === 5 && lastMsg['tick'] === 7 && lastMsg['evt'] === 256, 'meta message carries seg/tick/evt (双喂载荷)');
msg.recvFrame(F2, 2, { seg: 5, tick: 7, evt: AUTH_EVT_OPT });
expect(msg.readAuthoritativeInto(dstF2, dstI2) === 2, 'read returns va=2');
expect(dstI2[2] === 5 && dstI2[3] === 7 && dstI2[4] === 256, 'sticky mirror round-trip');
expect(dstF2[0] === 101.5 && dstF2[9] === 123471, 'MsgState frame values restored');
// 沿用语义（消息路径与 SAB 一致）
msg.recvFrame(F1, 3, { tick: 8 });
expect(msg.readAuthoritativeInto(dstF2, dstI2) === 3 && dstI2[2] === 5 && dstI2[3] === 8, 'seg sticky / tick updated (消息路径沿用语义)');

// ── 4c. PSEQ 读侧一致性：偶值快照 + 复检 + 代际复检（探针接缝）──
console.log('[4c] PSEQ read-side consistency (even snapshot + recheck, probe seam)');
// 场景 1：读中插入发布（afterEvenSnapshot 接缝）→ 复检翻转 → 重试 → 接受新代。
// 单线程下确定性复现追赶突发期的竞态：读者取的帧值来自上一代双缓冲槽（写者写另一槽），
// 而协议三元组已被新代覆盖 → 复检必翻 → 弃读重试 → 返回新代帧值与新代标签的一致组合。
// 「帧 k 的值 + tick k+1 的标签」这类跨代混合不会出现在返回值里。
{
  const sabC = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
  const shmC = new ShmState(sabC);
  const dFC = new Float64Array(12);
  const dIC = new Int32Array(6);
  const genA = { ...F1, pos: { x: 100, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, eyeHeight: 64, timeMs: 1000 };
  const genB = { ...F2, pos: { x: 200, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, eyeHeight: 64, timeMs: 2000 };
  shmC.writeAuthoritative(genA, true, { seg: 1, tick: 100, evt: 0 }); // 世代 A: va=1
  let inserted = false;
  const rC = shmC.readAuthoritativeInto(dFC, dIC, {
    afterEvenSnapshot: () => {
      if (!inserted) {
        inserted = true;
        // 写者读中插入：发布世代 B（写另一双缓冲槽 + 协议三元组翻新 + V_A=2）
        shmC.writeAuthoritative(genB, false, { seg: 1, tick: 101, evt: 0 });
      }
    },
  });
  expect(rC === 2, '读中写者插入 → 复检翻转 → 重试 → 接受新代 (va=2，非 −1 非 0)');
  expect(dIC[1] === 2 && dIC[3] === 101 && dFC[0] === 200, '重试后值/标签同代一致：va=2 ∧ tick=101 ∧ pos.x=200（无跨代混合返回）');
  expect(dIC[2] === 1 && dIC[0] === 0, 'seg 沿用一致 / onGround 新代 (0)');
  expect(dFC[9] === 2000, 'timeMs 亦为新代 (2000)——全部标量同代');
}
// 场景 2：复检前每次都注入一次 → 两次尝试都翻 → 返回 −1 且 dst 弃用。
{
  const sabD = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
  const shmD = new ShmState(sabD);
  const dFD = new Float64Array(12);
  const dID = new Int32Array(6);
  shmD.writeAuthoritative(F1, true, { seg: 1, tick: 200, evt: 0 });
  let fires = 0;
  const rD = shmD.readAuthoritativeInto(dFD, dID, {
    beforeRecheck: () => {
      fires++;
      shmD.writeAuthoritative(F2, false, { seg: 1, tick: 200 + fires, evt: 0 });
    },
  });
  expect(rD === -1 && fires === 2, '连续两次复检翻转 → −1（两次 attempt 恰好两次探针；dst 弃用契约=消费器跳过本轮、不触发重引导）');
}
// 场景 4（afterVaLoad 接缝）：把「写者整段发布」插在「读者读完 V_A、尚未取偶值快照」之间——
// 读者手里的 V_A = X−1 已陈旧，而偶值快照稳定在新代（PSEQ 奇检与复检都通过），
// 此时只有代际复检能拒。可复检到位后必须重试到同代一致（帧值 / 三元组 / V_A 三者同代）。
{
  const sabE = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
  const shmE = new ShmState(sabE);
  const dFE = new Float64Array(12);
  const dIE = new Int32Array(6);
  const genE1 = { ...F1, pos: { x: 300, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, eyeHeight: 64, timeMs: 3000 };
  const genE2 = { ...F2, pos: { x: 400, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, eyeHeight: 64, timeMs: 4000 };
  shmE.writeAuthoritative(genE1, true, { seg: 1, tick: 300, evt: 0 }); // 世代 X−1: va=1
  let insertedE = false;
  const rE = shmE.readAuthoritativeInto(dFE, dIE, {
    afterVaLoad: () => {
      if (!insertedE) {
        insertedE = true;
        // 写者整段发布世代 X：写另一双缓冲槽 + 三元组翻新 + V_A 递增先于 PSEQ 偶值
        shmE.writeAuthoritative(genE2, false, { seg: 1, tick: 301, evt: 0 });
      }
    },
  });
  expect(rE === 2, 'F1 VA 复检：v1 陈旧 × pseq0 已新代偶值 → 复检拒 → 重试 → 同代接受 (va=2)');
  expect(dIE[1] === 2 && dIE[3] === 301 && dFE[0] === 400, '同代一致：va=2 ∧ tick=301 ∧ pos.x=400（旧实现此处=va=1+tick=301 跨代混合）');
  expect(dIE[2] === 1 && dIE[0] === 0 && dFE[9] === 4000, 'seg 沿用 / onGround 新代 / timeMs 新代——全标量同代');
}
// 场景 5（raw store 级）：不经 writeAuthoritative，直接按写序手工构造停点，锁住写序合同本身——
// 中段（三元组写完、V_A 未递增、PSEQ 恒奇）→ 两次奇检都 bail → −1 冲突契约（dst 弃用）；
// 补完尾段（V_A 递增 → PSEQ 偶值）→ 同代一致。该停点对当前写者是**不可达**的：
// 只有绕过 `writeAuthoritative` 的裸 store 才能构造出来，故它验证的是「读者不依赖写者
// 原子性、只依赖写序」这一契约本身。
{
  const sabF = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
  const shmF = new ShmState(sabF);
  const dFF = new Float64Array(12);
  const dIF = new Int32Array(6);
  const genF1 = { ...F1, pos: { x: 500, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, eyeHeight: 64, timeMs: 5000 };
  shmF.writeAuthoritative(genF1, true, { seg: 9, tick: 400, evt: 0 }); // va=1, tick=400, x=500
  const rawI32F = new Int32Array(sabF);
  const rawB64F = new BigUint64Array(sabF);
  // raw 槽常量（[1] 组的布局核算：i32[0]=V_A、i32[2]=GROUND——两者未导出，测试内就地声明）
  const I_VA_RAW = 0;
  const I_GROUND_RAW = 2;
  const pseqF = Atomics.load(rawI32F, I_A_PSEQ);
  // 中段停点（raw store 级）：PSEQ 置奇 → 帧槽(B_A1) → 三元组与 ground → 【停：V_A 未递增】
  Atomics.store(rawI32F, I_A_PSEQ, pseqF + 1);
  rawB64F[B_A1] = 600n * 100n; rawB64F[B_A1 + 9] = 6000n; // pos.x=600, timeMs=6000
  Atomics.store(rawI32F, I_A_SEG, 9);
  Atomics.store(rawI32F, I_A_TICK, 401);
  Atomics.store(rawI32F, I_A_EVT, 0);
  Atomics.store(rawI32F, I_GROUND_RAW, 0);
  const rF1 = shmF.readAuthoritativeInto(dFF, dIF);
  expect(rF1 === -1, "f' 中段停点（PS 恒奇）→ 两 attempt 奇检 bail → −1 冲突契约（dst 弃用）");
  expect(dIF[1] === 0 && dFF[0] === 0, '−1 path：dst 内容弃用（未写入）');
  // 尾段补完：V_A 递增 → PSEQ 偶值（最后一步）→ 同代一致
  Atomics.store(rawI32F, I_VA_RAW, 2);
  Atomics.store(rawI32F, I_A_PSEQ, pseqF + 2);
  const rF2 = shmF.readAuthoritativeInto(dFF, dIF);
  expect(rF2 === 2, "f' 尾段（VA release→PS 偶）→ 同代接受 (va=2)");
  expect(dIF[1] === 2 && dIF[3] === 401 && dFF[0] === 600 && dFF[9] === 6000 && dIF[0] === 0 && dIF[2] === 9, 'f' + "' 序全量同代：帧值/三元组/ground/seg 一致（零混合形态）");
}
// 场景 3：传输透明——低 8 位的事件值原样落槽，传输层绝不自动补 bit8
//（是否置 OPT 位是发布方的纪律：乐观帧恒置、权威与修订帧不置）。
shm.writeAuthoritative(F1, false, { tick: 44, evt: 1 });
expect(shm.readAuthoritativeInto(dstF, dstI) >= 1 && dstI[4] === 1, 'SG-M4 传输透明：evt=1 原样落槽（bit8 不被传输层自动置位）');
shm.writeAuthoritative(F1, false, { tick: 45, evt: AUTH_EVT_OPT });
expect(shm.readAuthoritativeInto(dstF, dstI) >= 1 && dstI[4] === AUTH_EVT_OPT, 'SG-M1 乐观帧编码：evt=OPT(256) → slot=bit8∧低8≡0');

console.log(`shared-state.protocol.test: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  throw new Error(`shared-state.protocol.test FAILED (${failed})`);
}
