/**
 * `variant_t` 的 1:1 复刻。
 *
 * 对照 Source SDK 2013：
 * - `game/server/variant_t.h:24-122`（union + fieldType + 类型严格 getter）
 * - `game/server/cbase.cpp:1319-1380`（`Set` / `SetOther`）
 * - `game/server/cbase.cpp:1390-1563`（`Convert` 矩阵）
 * - `game/server/cbase.cpp:1574-1637`（`ToString`）
 *
 * 硬语义（复刻时最容易写错的）：
 * 1. getter 全部**类型严格**：类型不符返回 0/false/null，只有 `String()` 例外（自动 `ToString()`）。
 * 2. 参数覆盖总是 `FIELD_STRING`，所以 `STRING → {INTEGER,FLOAT,BOOLEAN,VECTOR,COLOR32,EHANDLE}`
 *    这组转换是 I/O 的主力路径；任何未列出的组合 `Convert` 返回 false，`AcceptInput` 会中止该输入。
 * 3. `FIELD_INPUT` 落到 `Set` 的 `default` 分支 ⇒ 变成 `FIELD_VOID`（SDK 2013 的既有行为，
 *    `COutputVariant` 因此丢失参数）。见 `entity-io.ts` 的 `OutputVariant`。
 * 4. 没有自定义 `operator=`，`m_VariantValue = Value` 是逐成员浅拷贝 ⇒ 这里用 `clone()`。
 */
import { g_Runtime } from './runtime.js';
import type { Color32, EntityRef, Vec3 } from './types.js';

export type FieldType =
  | 'void'
  | 'float'
  | 'string'
  | 'vector'
  | 'position_vector'
  | 'integer'
  | 'boolean'
  | 'short'
  | 'character'
  | 'color32'
  | 'ehandle'
  | 'input';

export const FIELD_VOID: FieldType = 'void';
export const FIELD_FLOAT: FieldType = 'float';
export const FIELD_STRING: FieldType = 'string';
export const FIELD_VECTOR: FieldType = 'vector';
export const FIELD_POSITION_VECTOR: FieldType = 'position_vector';
export const FIELD_INTEGER: FieldType = 'integer';
export const FIELD_BOOLEAN: FieldType = 'boolean';
export const FIELD_SHORT: FieldType = 'short';
export const FIELD_CHARACTER: FieldType = 'character';
export const FIELD_COLOR32: FieldType = 'color32';
export const FIELD_EHANDLE: FieldType = 'ehandle';
export const FIELD_INPUT: FieldType = 'input';

/** `NULL_STRING`：string_t 的空值。与空串 `""` 不是一回事（影响参数覆盖判定）。 */
export const NULL_STRING: null = null;

/** C `atoi`：十进制前缀，非数字前缀得 0（不用 parseInt，避免 `0x` 被当成 16 进制）。 */
export function atoi(s: string): number {
  const m = /^\s*([+-]?\d+)/.exec(s);
  if (!m) return 0;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? (n | 0) : 0;
}

/** C `atof`：解析浮点前缀，失败得 0。 */
export function atof(s: string): number {
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(s);
  if (!m) return 0;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) ? n : 0;
}

export class Variant {
  private type: FieldType = FIELD_VOID;
  private iVal = 0;
  private flVal = 0;
  private bVal = false;
  private iszVal: string | null = null;
  private vecVal: Vec3 = [0, 0, 0];
  private rgbaVal: Color32 = { r: 0, g: 0, b: 0, a: 0 };
  private eVal: EntityRef | null = null;

  fieldType(): FieldType {
    return this.type;
  }

  // ── 类型严格的 getter（variant_t.h:44-51） ──
  bool(): boolean {
    return this.type === FIELD_BOOLEAN ? this.bVal : false;
  }
  int(): number {
    return this.type === FIELD_INTEGER ? this.iVal : 0;
  }
  float(): number {
    return this.type === FIELD_FLOAT ? this.flVal : 0;
  }
  stringID(): string | null {
    return this.type === FIELD_STRING ? this.iszVal : null;
  }
  string(): string {
    return this.type === FIELD_STRING ? (this.iszVal ?? '') : this.toString();
  }
  vector3D(): Vec3 {
    return this.type === FIELD_VECTOR || this.type === FIELD_POSITION_VECTOR
      ? [this.vecVal[0], this.vecVal[1], this.vecVal[2]]
      : [0, 0, 0];
  }
  color32(): Color32 {
    return { ...this.rgbaVal };
  }
  entity(): EntityRef | null {
    return this.type === FIELD_EHANDLE ? this.eVal : null;
  }

  // ── setter（variant_t.h:55-64） ──
  setVoid(): this {
    this.type = FIELD_VOID;
    this.iVal = 0;
    return this;
  }
  setBool(v: boolean): this {
    this.bVal = Boolean(v);
    this.type = FIELD_BOOLEAN;
    return this;
  }
  /** `SetString(string_t)`：null 代表 NULL_STRING。 */
  setString(v: string | null): this {
    this.iszVal = v;
    this.type = FIELD_STRING;
    return this;
  }
  setInt(v: number): this {
    this.iVal = v | 0;
    this.type = FIELD_INTEGER;
    return this;
  }
  setFloat(v: number): this {
    this.flVal = v;
    this.type = FIELD_FLOAT;
    return this;
  }
  setEntity(v: EntityRef | null): this {
    this.eVal = v;
    this.type = FIELD_EHANDLE;
    return this;
  }
  setVector3D(v: Vec3): this {
    this.vecVal = [v[0], v[1], v[2]];
    this.type = FIELD_VECTOR;
    return this;
  }
  setPositionVector3D(v: Vec3): this {
    this.vecVal = [v[0], v[1], v[2]];
    this.type = FIELD_POSITION_VECTOR;
    return this;
  }
  setColor32(r: number, g: number, b: number, a = 255): this {
    this.rgbaVal = { r: r | 0, g: g | 0, b: b | 0, a: a | 0 };
    this.type = FIELD_COLOR32;
    return this;
  }

  /**
   * `variant_t::Set(fieldtype_t, void*)`：按声明类型写入。
   * `FIELD_INPUT` **没有 case**，落 `default` ⇒ VOID（`cbase.cpp:1344-1347`）。
   */
  setFromField(ftype: FieldType, data: unknown): this {
    this.type = ftype;
    switch (ftype) {
      case FIELD_BOOLEAN:
        return this.setBool(Boolean(data));
      case FIELD_CHARACTER:
      case FIELD_SHORT:
      case FIELD_INTEGER:
        return this.setInt(typeof data === 'number' ? data : atoi(String(data)));
      case FIELD_STRING:
        return this.setString(data === null ? null : String(data));
      case FIELD_FLOAT:
        return this.setFloat(typeof data === 'number' ? data : atof(String(data)));
      case FIELD_VECTOR:
        return this.setVector3D((data as Vec3) ?? [0, 0, 0]);
      case FIELD_POSITION_VECTOR:
        return this.setPositionVector3D((data as Vec3) ?? [0, 0, 0]);
      case FIELD_COLOR32: {
        const c = data as Color32;
        return this.setColor32(c?.r ?? 0, c?.g ?? 0, c?.b ?? 0, c?.a ?? 255);
      }
      case FIELD_EHANDLE:
        return this.setEntity((data as EntityRef | null) ?? null);
      case FIELD_INPUT:
      case FIELD_VOID:
      default:
        return this.setVoid();
    }
  }

  /** 逐成员浅拷贝（SDK 默认 `operator=`）。 */
  clone(): Variant {
    const v = new Variant();
    v.type = this.type;
    v.iVal = this.iVal;
    v.flVal = this.flVal;
    v.bVal = this.bVal;
    v.iszVal = this.iszVal;
    v.vecVal = [this.vecVal[0], this.vecVal[1], this.vecVal[2]];
    v.rgbaVal = { ...this.rgbaVal };
    v.eVal = this.eVal;
    return v;
  }

  /** `variant_t::Convert`（`cbase.cpp:1390-1563`）；转换失败返回 false。 */
  convert(newType: FieldType): boolean {
    if (newType === this.type) return true;
    if (newType === FIELD_VOID) {
      this.setVoid();
      return true;
    }
    // "FIELD_INPUT accepts the variant type directly"（cbase.cpp:1409）
    if (newType === FIELD_INPUT) return true;

    switch (this.type) {
      case FIELD_INTEGER:
        if (newType === FIELD_FLOAT) {
          this.setFloat(this.iVal);
          return true;
        }
        if (newType === FIELD_BOOLEAN) {
          this.setBool(this.iVal !== 0);
          return true;
        }
        break;
      case FIELD_FLOAT:
        if (newType === FIELD_INTEGER) {
          this.setInt(Math.trunc(this.flVal));
          return true;
        }
        if (newType === FIELD_BOOLEAN) {
          this.setBool(this.flVal !== 0);
          return true;
        }
        break;
      case FIELD_STRING: {
        const s = this.iszVal ?? '';
        if (newType === FIELD_INTEGER) {
          this.setInt(atoi(s));
          return true;
        }
        if (newType === FIELD_FLOAT) {
          this.setFloat(atof(s));
          return true;
        }
        if (newType === FIELD_BOOLEAN) {
          this.setBool(atoi(s) !== 0);
          return true;
        }
        if (newType === FIELD_VECTOR || newType === FIELD_POSITION_VECTOR) {
          const nums: string[] = s.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [];
          const vec: Vec3 = [
            nums.length > 0 ? Number.parseFloat(nums[0]) : 0,
            nums.length > 1 ? Number.parseFloat(nums[1]) : 0,
            nums.length > 2 ? Number.parseFloat(nums[2]) : 0,
          ];
          if (newType === FIELD_POSITION_VECTOR) this.setPositionVector3D(vec);
          else this.setVector3D(vec);
          return true;
        }
        if (newType === FIELD_COLOR32) {
          const nums = (s.match(/-?\d+/g) ?? []).map((n) => Number.parseInt(n, 10));
          this.setColor32(nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 255);
          return true;
        }
        if (newType === FIELD_EHANDLE) {
          const resolve = g_Runtime.resolveEntityByName;
          this.setEntity(this.iszVal !== null && resolve ? resolve(this.iszVal) : null);
          return true;
        }
        break;
      }
      case FIELD_EHANDLE:
        if (newType === FIELD_STRING) {
          if (this.eVal) this.setString(this.eVal.targetname);
          return true;
        }
        break;
      default:
        break;
    }
    return false;
  }

  /** `variant_t::ToString`（仅用于 debug / 非 STRING 类型的 `String()` 回退）。 */
  toString(): string {
    switch (this.type) {
      case FIELD_STRING:
        return this.iszVal ?? '';
      case FIELD_BOOLEAN:
        return this.bVal ? 'true' : 'false';
      case FIELD_INTEGER:
        return String(this.iVal);
      case FIELD_FLOAT:
        return String(this.flVal);
      case FIELD_COLOR32:
        return `${this.rgbaVal.r} ${this.rgbaVal.g} ${this.rgbaVal.b} ${this.rgbaVal.a}`;
      case FIELD_VECTOR:
      case FIELD_POSITION_VECTOR:
        return `[${this.vecVal[0]} ${this.vecVal[1]} ${this.vecVal[2]}]`;
      case FIELD_EHANDLE:
        return this.eVal ? this.eVal.targetname : '<<null entity>>';
      case FIELD_VOID:
        return '';
      default:
        return 'No conversion to string';
    }
  }

  // ── 便捷构造（不对应 SDK 成员，仅减少调用点样板） ──
  static void(): Variant {
    return new Variant();
  }
  static fromString(v: string | null): Variant {
    return new Variant().setString(v);
  }
  static fromFloat(v: number): Variant {
    return new Variant().setFloat(v);
  }
  static fromInt(v: number): Variant {
    return new Variant().setInt(v);
  }
  static fromBool(v: boolean): Variant {
    return new Variant().setBool(v);
  }
}
