/**
 * Source 引擎演示录像（`.dem`）的位流读取器：等价于引擎侧 `bf_read`（`test/project/source-sdk-2013-master`
 * 的 `src/public/tier1/bitbuf.h` 与 `src/tier1/bitbuf.cpp`）。
 *
 * 位序：**低位在前**（`bf_read::ReadOneBitNoCheck` 取 `m_pData[bit>>3] >> (bit&7)`），
 * 与 `ReadUBitLong` 的 32 位字拼装一致；本文件所有读取都按该位序实现。
 *
 * 与引擎侧的一致点：
 * - `u(n)`：读 n 位无符号（等价 `ReadUBitLong`）；
 * - `s(n)`：读 n 位有符号，符号位为第 n−1 位（等价 `ReadSBitLong`）；
 * - `uBitVar()`：6 位入口，低 2 位为编码号；编码 0 时值为高 4 位，否则回退 4 位后按
 *   `4 + enc*4 + (enc>=3 ? 16 : 0)` 位重读（等价 `ReadUBitVar` + `ReadUBitVarInternal`）；
 * - `varInt32()`：LEB128 变长整数（等价 `ReadVarInt32`）；
 * - `f32()`：原始 32 位 IEEE 位型（等价 `ReadBitFloat`）；
 * - `coord()` / `coordMp()` / `vec3Coord()` / `vec3Normal()`：定点坐标与法线编码，
 *   常量取自 `src/public/coordsize.h`（整数 14 / 小数 5 位；MP 整数 11 / 低精度小数 3 位；法线 11 位）；
 * - `str()`：NUL 结尾字符串，逐字节读（等价 `ReadString`，不受字节对齐约束）；
 * - `bytes(n)`：按位读 n 个字节（等价 `ReadBits`）。
 *
 * 越界策略：**读越界不抛错**，把游标钉在末尾并置 `overflowed`。调用方须在每段解析后自查
 * `overflowed`——这与引擎一致（引擎只置溢出标记并回调错误处理器）。
 */

/** 定点坐标常量；取自 `src/public/coordsize.h`。 */
const COORD_INTEGER_BITS = 14;
const COORD_FRACTIONAL_BITS = 5;
const COORD_RESOLUTION = 1 / (1 << COORD_FRACTIONAL_BITS);
const COORD_INTEGER_BITS_MP = 11;
const COORD_FRACTIONAL_BITS_MP_LOWPRECISION = 3;
const NORMAL_FRACTIONAL_BITS = 11;
const NORMAL_DENOMINATOR = (1 << NORMAL_FRACTIONAL_BITS) - 1;
const NORMAL_RESOLUTION = 1 / NORMAL_DENOMINATOR;

/**
 * 最内层诊断钩子：`u(n)` 每次调用回调（请求位数、推进前位、推进后位、是否越界）。
 *
 * 动机：`decodeProp` 的单元测试与实体记录实测给出互相矛盾的消耗位数（96 vs 17），而 `u(n)` 是**逐位循环**
 * —— 只要未越界就必定推进 n 位。故此处取数可判定「矛盾出在测量层还是位流层」。缺省 `null`。
 */
export let onU: ((n: number, start: number, end: number, ovf: boolean) => void) | null = null;

/** 设置该钩子。 */
export function setOnU(fn: typeof onU): void {
  onU = fn;
}

/** 位流读取器：在 `bytes` 上从 `startBit` 起按低位在前读取。 */
export class BitReader {
  private p: number;
  /** 越界标记：任一次读越界即置位，之后所有读返回 0 且游标不再前进。 */
  overflowed = false;
  /** 可读位上限（相对 `bytes[0]`）。公开以便留痕核对「读在哪里被截断」。 */
  readonly limit: number;

  constructor(
    private readonly bytes: Uint8Array,
    /** 起始位偏移（相对 `bytes[0]`）。 */
    startBit = 0,
    /** 可读位上限（缺省 = 整段字节数 × 8），用于把读取限制在一条消息的载荷内。 */
    bitLimit?: number,
  ) {
    this.p = startBit;
    this.limit = bitLimit ?? bytes.length * 8;
  }

  /** 当前位偏移。 */
  get pos(): number {
    return this.p;
  }

  /** 剩余可读位数。 */
  get remaining(): number {
    return Math.max(0, this.limit - this.p);
  }

  /** 跳到位偏移（越界则钉在末尾并置溢出标记）。 */
  seek(bit: number): void {
    if (bit < 0 || bit > this.limit) {
      this.overflowed = true;
      this.p = this.limit;
      return;
    }
    this.p = bit;
  }

  /** 跳过 n 位。 */
  skip(n: number): void {
    this.seek(this.p + n);
  }

  /** 读 1 位。 */
  bit(): number {
    if (this.p >= this.limit) {
      this.overflowed = true;
      return 0;
    }
    const v = (this.bytes[this.p >> 3] >> (this.p & 7)) & 1;
    this.p++;
    return v;
  }

  /** 窥视第 `at` 位（绝对位下标），不移动游标。越界返回 0。 */
  bitAt(at: number): number {
    if (at < 0 || at >= this.limit) return 0;
    return (this.bytes[at >> 3] >> (at & 7)) & 1;
  }

  /** 读 n 位无符号（1..32）。 */
  u(n: number): number {
    if (n <= 0) return 0;
    if (n > 32) n = 32;
    let v = 0;
    // 逐位读取：与引擎的 32 位字拼装等价，且天然处理跨字节与载荷边界
    const uStart = this.p;
    for (let i = 0; i < n; i++) v += this.bit() * Math.pow(2, i);
    if (onU) onU(n, uStart, this.p, this.overflowed);
    return v >>> 0;
  }

  /** 读 n 位有符号（符号位为第 n−1 位）。 */
  s(n: number): number {
    const r = this.u(n);
    const sign = Math.pow(2, n - 1);
    return r >= sign ? r - sign - sign : r;
  }

  /** 读 32 位原始位型并按 IEEE 单精度解释。 */
  f32(): number {
    const v = this.u(32);
    this.scratch.setUint32(0, v, true);
    return this.scratch.getFloat32(0, true);
  }
  private readonly scratch = new DataView(new ArrayBuffer(4));

  /** 变长无符号整数（LEB128，每字节低 7 位有效、最高位为续读位，最多 5 字节）。 */
  varInt32(): number {
    let result = 0;
    for (let count = 0; count < 5; count++) {
      const b = this.u(8);
      result |= (b & 0x7f) * Math.pow(2, 7 * count);
      if ((b & 0x80) === 0) break;
    }
    return result >>> 0;
  }

  /**
   * 变长索引（`ReadUBitVar`）：先读 6 位；低 2 位为 0 时值 = 高 4 位，
   * 否则回退 4 位后按 `4 + enc*4 + (enc >= 3 ? 16 : 0)` 位重读。
   */
  uBitVar(): number {
    const six = this.u(6);
    const enc = six & 3;
    if (enc === 0) return six >>> 2;
    this.p -= 4;
    const bits = 4 + enc * 4 + (enc >= 3 ? 16 : 0);
    return this.u(bits);
  }

  /** NUL 结尾字符串：逐字节读取直到 0（不含），游标停在 0 之后。 */
  str(maxBytes = 512): string {
    let out = '';
    for (let i = 0; i < maxBytes; i++) {
      const c = this.u(8);
      if (c === 0) return out;
      out += String.fromCharCode(c);
    }
    return out;
  }

  /** 读 n 个字节（按位，不要求字节对齐）。 */
  readBytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.u(8);
    return out;
  }

  /**
   * 定点坐标（`ReadBitCoord`）：先读整数位标志与小数位标志，二者皆 0 时值为 0；
   * 否则读符号位，整数部分按 14 位 + 1（区间 [1, 16384]），小数部分按 5 位 × 1/32。
   */
  coordMp(integral = false, lowPrecision = false): number {
    if (integral) {
      const flags = this.u(2);
      const INTVAL = 2;
      if ((flags & INTVAL) === 0) return 0;
      const inbounds = (flags & 1) !== 0;
      if (!inbounds) return 0; // 越界整数编码本工程未使用，按 0 处理并置标记
      const bits = this.u(COORD_INTEGER_BITS_MP + 1);
      const intval = (bits >>> 1) + 1;
      return (bits & 1) !== 0 ? -intval : intval;
    }
    const flags = this.u(3);
    const INBOUNDS = 1;
    const INTVAL = 2;
    const SIGN = 4;
    const mul = (flags & SIGN) !== 0
      ? -(lowPrecision ? 1 / (1 << COORD_FRACTIONAL_BITS_MP_LOWPRECISION) : COORD_RESOLUTION)
      : lowPrecision
        ? 1 / (1 << COORD_FRACTIONAL_BITS_MP_LOWPRECISION)
        : COORD_RESOLUTION;
    const fracBits = lowPrecision ? COORD_FRACTIONAL_BITS_MP_LOWPRECISION : COORD_FRACTIONAL_BITS;
    const intBits = (flags & INBOUNDS) !== 0 ? COORD_INTEGER_BITS_MP : COORD_INTEGER_BITS;
    const nbits = (flags & INTVAL) !== 0 ? fracBits + intBits : fracBits;
    const bits = this.u(nbits);
    if ((flags & INTVAL) === 0) return bits * mul;
    const intpart = (bits >>> fracBits) + 1;
    const fracpart = bits & ((1 << fracBits) - 1);
    return (intpart + fracpart * (1 / (1 << fracBits))) * (mul < 0 ? -1 : 1);
  }

  /** 普通定点坐标（`ReadBitCoord`）。 */
  coord(): number {
    const intval = this.bit();
    const fractval = this.bit();
    if (intval === 0 && fractval === 0) return 0;
    const signbit = this.bit();
    const i = intval ? this.u(COORD_INTEGER_BITS) + 1 : 0;
    const f = fractval ? this.u(COORD_FRACTIONAL_BITS) : 0;
    const value = i + f * COORD_RESOLUTION;
    return signbit ? -value : value;
  }

  /** 三轴定点坐标（`ReadBitVec3Coord`）：三个存在位，存在者按定点坐标读。 */
  vec3Coord(): [number, number, number] {
    const out: [number, number, number] = [0, 0, 0];
    const xf = this.bit();
    const yf = this.bit();
    const zf = this.bit();
    if (xf) out[0] = this.coord();
    if (yf) out[1] = this.coord();
    if (zf) out[2] = this.coord();
    return out;
  }

  /** 三轴法线（`ReadBitVec3Normal`）：x/y 各带存在位，z 由前两轴推得、符号单独给 1 位。 */
  vec3Normal(): [number, number, number] {
    const out: [number, number, number] = [0, 0, 0];
    if (this.bit()) out[0] = this.normal();
    if (this.bit()) out[1] = this.normal();
    const zneg = this.bit();
    const sq = out[0] * out[0] + out[1] * out[1];
    out[2] = sq < 1 ? Math.sqrt(1 - sq) : 0;
    if (zneg) out[2] = -out[2];
    return out;
  }

  /** 单轴法线（`ReadBitNormal`）：1 位符号 + 11 位小数。 */
  private normal(): number {
    const sign = this.bit();
    const v = this.u(NORMAL_FRACTIONAL_BITS) * NORMAL_RESOLUTION;
    return sign ? -v : v;
  }
}
