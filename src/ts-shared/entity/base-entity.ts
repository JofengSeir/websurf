/**
 * `CBaseEntity` 的 1:1 复刻：datamap 分派、`KeyValue`、`AcceptInput`、think。
 *
 * 对照 Source SDK 2013：
 * - `game/server/baseentity.cpp:4348-4475`（`AcceptInput`）
 * - `game/server/baseentity.cpp:2162-2205`（基类输入/输出 DATADESC）
 * - `game/server/baseentity.cpp:4481-4726 / 7181-7202 / 7633-7655`（内置输入实现）
 * - `game/shared/baseentity_shared.cpp:295-315 / 320-496`（`ParseMapData` / `KeyValue`）
 * - `game/server/saverestore_gamedll.cpp:24-118`（`ParseKeyvalue` 的 FIELD_CUSTOM → output）
 *
 * 分派**不是 if/else 链**：外层遍历 `classChain`（派生 → 基类），内层按声明数组顺序，
 * 第一个名字匹配（`Q_stricmp` 大小写不敏感）就立即命中并 return。派生类同名输入遮蔽基类。
 */
import type { EntityBrushVolume, EntityHost, EntityLike, InputData, Vec3 } from './types.js';
import type { KeyValuePair } from './map-data.js';
import { bspVec3ToYup, parseVec3, stripHammerDuplicateSuffix } from './map-data.js';
import { makeOutput, type EntityOutput, type OutputKind } from './entity-io.js';
import {
  FIELD_BOOLEAN,
  FIELD_COLOR32,
  FIELD_FLOAT,
  FIELD_INTEGER,
  FIELD_STRING,
  FIELD_VOID,
  type FieldType,
  Variant,
  atoi,
  atof,
} from './variant.js';

/** 一个输入声明（`DEFINE_INPUTFUNC` / `DEFINE_INPUT`）。 */
export interface InputDef {
  name: string;
  type: FieldType;
  /** 有处理函数 ⇒ `DEFINE_INPUTFUNC`；无 ⇒ 把值写进 `fields[key]`（`DEFINE_INPUT`）。 */
  handler?: (entity: Entity, data: InputData) => void;
  key?: string;
}

/** 一个输出声明（`DEFINE_OUTPUT`）。 */
export interface OutputDef {
  name: string;
  kind: OutputKind;
}

export type KeyFieldType = 'string' | 'float' | 'int' | 'bool' | 'vec3' | 'color32';

/** 一个地图键声明（`DEFINE_KEYFIELD`）。 */
export interface KeyDef {
  name: string;
  type: KeyFieldType;
  defaultValue?: unknown;
  /** 额外副作用（例如解析完还要同步到别的状态）。 */
  apply?: (entity: Entity, raw: string) => void;
}

/** 类描述表；对应 SDK 的 `datamap_t` + `dataDesc[]`。 */
export interface EntityClass {
  name: string;
  /** 基类注册名；链由 registry 在装配时展开成 `classChain`。 */
  base?: string;
  inputs?: InputDef[];
  outputs?: OutputDef[];
  keyfields?: KeyDef[];
  spawn?: (entity: Entity) => void;
  activate?: (entity: Entity) => void;
  think?: (entity: Entity) => void;
  touch?: (entity: Entity, other: Entity) => void;
  startTouch?: (entity: Entity, other: Entity) => void;
  endTouch?: (entity: Entity, other: Entity) => void;
  use?: (entity: Entity, activator: Entity | null, caller: Entity | null, useType: number) => void;
  /** 是否为 brush 实体（有 `model="*N"` 几何），影响 touch 几何查询。 */
  brush?: boolean;
  /** spawnflags 的具名常量，供类实现可读地引用。 */
  spawnFlags?: Record<string, number>;
}

/** 宿主侧运行期能力；由 `EntitySystem` 实现，避免实体层反向依赖系统层。 */
export interface EntityRuntime {
  readonly host: EntityHost;
  now(): number;
  removeEntity(entity: Entity): void;
  log(message: string): void;
  /** 运行期观测事件；实体分派点会把自身身份一并带上。 */
  emit(event: {
    kind: string;
    detail?: string;
    activatorName?: string;
    entityIndex?: number;
    classname?: string;
    targetname?: string;
  }): void;
  getPlayer(): Entity | null;
  /** 未知 classname 的 `On*` 键是否动态注册为输出（默认 true，见文件尾说明）。 */
  allowDynamicOutputs: boolean;
}

/** `TICK_NEVER_THINK`：没有待执行的 think。 */
export const TICK_NEVER_THINK = -1;

function keyFieldValue(type: KeyFieldType, raw: string): unknown {
  switch (type) {
    case 'string':
      return raw;
    case 'float':
      return atof(raw);
    case 'int':
      return atoi(raw);
    case 'bool':
      return atoi(raw) !== 0;
    case 'vec3':
      return parseVec3(raw);
    case 'color32': {
      const n = (raw.match(/-?\d+/g) ?? []).map((s) => Number.parseInt(s, 10));
      return { r: n[0] ?? 0, g: n[1] ?? 0, b: n[2] ?? 0, a: n[3] ?? 255 };
    }
    default:
      return raw;
  }
}

/** 一个地图实体实例。 */
export class Entity implements EntityLike {
  readonly index: number;
  readonly classChain: readonly EntityClass[];
  readonly runtime: EntityRuntime;

  classname: string;
  targetname = '';
  hammerid = '';
  spawnflags = 0;
  origin: Vec3 = [0, 0, 0];
  angles: Vec3 = [0, 0, 0];
  model = '';
  /** 原样保留的键值序列（含重复键），不参与分派，只供类实现与宿主读取。 */
  readonly props: KeyValuePair[] = [];
  /** Y-up 世界坐标的 brush 凸包（由 Rust `export_entity_io` 提供）。 */
  volumes: EntityBrushVolume[] = [];

  /** 输出名（小写）→ 输出对象。 */
  readonly outputs = new Map<string, EntityOutput>();
  /** `DEFINE_KEYFIELD` 写入的字段，以及类实现自己的运行期状态。 */
  readonly fields = new Map<string, unknown>();

  disabled = false;
  markedForDeletion = false;
  /** `m_bDisabled` 与 `FSOLID_TRIGGER` 是两个独立状态（SDK InputToggle 只翻后者）。 */
  triggerSolidFlag = true;
  nextThink: number = TICK_NEVER_THINK;
  thinkFn: ((entity: Entity) => void) | null = null;
  /** `m_hTouchingEntities`：只记录通过 `PassesTriggerFilters` 的实体。 */
  readonly touchingEntities: Entity[] = [];
  /** 几何层 touchlink（所有接触对，不看 filter）；touchStamp 帧心跳用。 */
  readonly touchLinks: Map<Entity, { stamp: number; startTouch: boolean }> = new Map();
  touchStamp = 0;
  checkUntouch = false;

  constructor(
    index: number,
    classname: string,
    pairs: readonly KeyValuePair[],
    classChain: readonly EntityClass[],
    runtime: EntityRuntime,
  ) {
    this.index = index;
    this.classname = classname;
    this.classChain = classChain;
    this.runtime = runtime;
    for (const p of pairs) this.props.push({ key: p.key, value: p.value });

    // 按 datamap 链声明输出对象（派生 → 基类，派生优先）。
    for (const cls of classChain) {
      for (const def of cls.outputs ?? []) {
        const k = def.name.toLowerCase();
        if (!this.outputs.has(k)) this.outputs.set(k, makeOutput(def.kind));
      }
      for (const def of cls.keyfields ?? []) {
        if (def.defaultValue !== undefined && !this.fields.has(def.name.toLowerCase())) {
          this.fields.set(def.name.toLowerCase(), def.defaultValue);
        }
      }
    }
  }

  // ── 字段便捷访问 ──
  get<T = unknown>(name: string): T | undefined {
    return this.fields.get(name.toLowerCase()) as T | undefined;
  }
  set(name: string, value: unknown): void {
    this.fields.set(name.toLowerCase(), value);
  }
  getNumber(name: string, fallback = 0): number {
    const v = this.get<unknown>(name);
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  }
  getBool(name: string, fallback = false): boolean {
    const v = this.get<unknown>(name);
    return typeof v === 'boolean' ? v : fallback;
  }
  getString(name: string, fallback = ''): string {
    const v = this.get<unknown>(name);
    return typeof v === 'string' ? v : fallback;
  }
  /** 取地图上写的原始键（大小写不敏感，首个匹配）。 */
  getRaw(key: string): string | undefined {
    const lower = key.toLowerCase();
    for (const p of this.props) if (p.key.toLowerCase() === lower) return p.value;
    return undefined;
  }
  /** 取该键的全部值（Source 允许重复 outputs 键）。 */
  getAllRaw(key: string): string[] {
    const lower = key.toLowerCase();
    return this.props.filter((p) => p.key.toLowerCase() === lower).map((p) => p.value);
  }

  hasSpawnFlags(bit: number): boolean {
    return (this.spawnflags & bit) !== 0;
  }
  addSpawnFlags(bit: number): void {
    this.spawnflags |= bit;
  }
  removeSpawnFlags(bit: number): void {
    this.spawnflags &= ~bit;
  }
  spawnFlagOf(name: string): number {
    for (const cls of this.classChain) {
      const v = cls.spawnFlags?.[name];
      if (v !== undefined) return v;
    }
    return 0;
  }
  hasNamedSpawnFlag(name: string): boolean {
    const bit = this.spawnFlagOf(name);
    return bit !== 0 && this.hasSpawnFlags(bit);
  }

  nameMatches(query: string): boolean {
    // NamesMatch 的实际实现在 entity-list.ts；这里走同一规则避免重复实现。
    return nameMatchesImpl(query, this.targetname);
  }
  classMatches(query: string): boolean {
    return nameMatchesImpl(query, this.classname);
  }
  isPlayer(): boolean {
    return this.classname === 'player' || this === this.runtime.getPlayer();
  }
  isAlive(): boolean {
    if (this.isPlayer()) return this.runtime.host.getPlayerState().alive;
    return !this.markedForDeletion;
  }

  // ── ParseMapData / KeyValue ──
  parseMapData(pairs: readonly KeyValuePair[]): void {
    for (const p of pairs) this.keyValue(p.key, p.value);
  }

  /**
   * `CBaseEntity::KeyValue`（baseentity_shared.cpp:320-496）。
   * 返回 false 表示「这个键没人认」——SDK 会静默丢弃（仅 `ent_debugkeys` 时打印）。
   */
  keyValue(rawKey: string, rawValue: string): boolean {
    const key = stripHammerDuplicateSuffix(rawKey);
    const lower = key.toLowerCase();

    // `targetname` 是硬编码特判，不在 datamap 里（baseentity_shared.cpp:441-445）。
    if (lower === 'targetname') {
      this.targetname = rawValue;
      return true;
    }
    if (lower === 'classname') {
      this.classname = rawValue;
      return true;
    }
    if (lower === 'model') {
      this.model = rawValue;
      return true;
    }
    if (lower === 'origin') {
      // entities lump 里是 BSP Z-up；本层统一用项目物理的 Y-up（见 map-data.ts 注释）。
      this.origin = bspVec3ToYup(parseVec3(rawValue));
      return true;
    }
    if (lower === 'angles') {
      this.angles = parseVec3(rawValue);
      return true;
    }
    if (lower === 'spawnflags') {
      this.spawnflags = atoi(rawValue);
      return true;
    }
    if (lower === 'hammerid') {
      this.hammerid = rawValue;
      return true;
    }
    if (lower === 'parentname') {
      this.set('parentname', rawValue);
      return true;
    }

    // datamap 顺序：派生 → 基类；第一个匹配即 return true。
    for (const cls of this.classChain) {
      for (const def of cls.keyfields ?? []) {
        if (def.name.toLowerCase() !== lower) continue;
        this.set(def.name, keyFieldValue(def.type, rawValue));
        def.apply?.(this, rawValue);
        return true;
      }
      for (const def of cls.outputs ?? []) {
        if (def.name.toLowerCase() !== lower) continue;
        this.outputs.get(lower)?.parseEventAction(rawValue);
        return true;
      }
    }

    // 扩展（非 SDK 严格行为）：未知类 / 未声明输出的 `On*` 键动态注册为 COutputEvent。
    // 引擎会丢弃这些键；这里保留是为了让未建模的实体类（如地图专有类）仍能被 I/O 链 fire，
    // 且不会污染已注册类的严格分派。所有动态注册都会记一条诊断日志。
    if (this.runtime.allowDynamicOutputs && /^on/i.test(key)) {
      if (!this.outputs.has(lower)) {
        this.outputs.set(lower, makeOutput('event'));
        this.runtime.log(`dynamic output ${this.classname}.${key}`);
      }
      this.outputs.get(lower)?.parseEventAction(rawValue);
      return true;
    }
    return false;
  }

  // ── AcceptInput ──
  /**
   * `CBaseEntity::AcceptInput`（baseentity.cpp:4348-4475）。
   * 大小写不敏感；datamap 派生→基类首匹配即返回；类型转换失败 return false。
   */
  acceptInput(
    name: string,
    activator: EntityLike | null,
    caller: EntityLike | null,
    value: Variant,
    outputID: number,
  ): boolean {
    if (this.markedForDeletion) return false;
    const lower = name.toLowerCase();
    for (const cls of this.classChain) {
      for (const def of cls.inputs ?? []) {
        if (def.name.toLowerCase() !== lower) continue;

        // 唯一豁免：FIELD_VOID → FIELD_STRING（允许空串）。
        if (value.fieldType() !== def.type) {
          if (!(value.fieldType() === FIELD_VOID && def.type === FIELD_STRING)) {
            if (!value.convert(def.type)) {
              this.runtime.log(`bad input/output link: ${this.classname}.${name}`);
              return false;
            }
          } else {
            // 引擎不改 fieldType，只让 String() 拿到 ""；这里显式转成空串以稳定下游读取。
            value.setString('');
          }
        }
        const data: InputData = { activator, caller, value, outputID };
        if (def.handler) def.handler(this, data);
        else if (def.key) this.set(def.key, variantToFieldValue(value));
        this.runtime.emit({
          kind: 'input',
          detail: `${this.classname}.${def.name}`,
          activatorName: activator?.targetname,
          entityIndex: this.index,
          classname: this.classname,
          targetname: this.targetname,
        });
        return true;
      }
    }
    this.runtime.log(`unhandled input: (${name}) -> (${this.classname},${this.targetname})`);
    return false;
  }

  // ── 输出触发 ──
  output(name: string): EntityOutput | null {
    return this.outputs.get(name.toLowerCase()) ?? null;
  }
  /** 无参数输出：`COutputEvent::FireOutput`。 */
  fire(name: string, activator: EntityLike | null, caller: EntityLike | null, delay = 0): void {
    const out = this.output(name);
    if (!out) return;
    // COutputEvent 走 fire()；带类型参数的输出用 VOID 触发（保持「无覆盖」语义）。
    if ('fire' in out && typeof (out as { fire?: unknown }).fire === 'function') {
      (out as unknown as { fire: (a: EntityLike | null, c: EntityLike | null, d?: number) => void }).fire(
        activator,
        caller,
        delay,
      );
    } else {
      out.fireOutput(Variant.void(), activator, caller, delay);
    }
  }
  /** 带参数输出：`CEntityOutputTemplate::Set` → `FireOutput(m_Value, ...)`。 */
  fireValue(name: string, value: Variant, activator: EntityLike | null, caller: EntityLike | null): void {
    const out = this.output(name);
    if (!out) return;
    if ('set' in out && typeof (out as { set?: unknown }).set === 'function') {
      (out as unknown as { set: (v: unknown, a: EntityLike | null, c: EntityLike | null) => void }).set(
        variantToFieldValue(value),
        activator,
        caller,
      );
    } else {
      out.fireOutput(value.clone(), activator, caller);
    }
  }

  // ── think ──
  setThink(fn: (entity: Entity) => void, delay = 0): void {
    this.thinkFn = fn;
    this.nextThink = this.runtime.now() + delay;
  }
  clearThink(): void {
    this.thinkFn = null;
    this.nextThink = TICK_NEVER_THINK;
  }
  /** `GetNextThink() > curtime` —— trigger_multiple 的冷却判据。 */
  hasPendingThink(): boolean {
    return this.nextThink > this.runtime.now();
  }
  serviceThink(now: number): void {
    if (this.thinkFn === null || this.nextThink > now || this.nextThink === TICK_NEVER_THINK) return;
    const fn = this.thinkFn;
    this.clearThink();
    fn(this);
  }

  // ── 生命周期 ──
  spawn(): void {
    for (const cls of this.classChain) cls.spawn?.(this);
  }
  activate(): void {
    for (const cls of this.classChain) cls.activate?.(this);
  }
  kill(): void {
    if (this.markedForDeletion) return;
    this.set('ownerNotified', true);
    this.remove();
  }
  remove(): void {
    if (this.markedForDeletion) return;
    this.markedForDeletion = true;
    this.runtime.removeEntity(this);
  }

  /** `Use` 输入的宿主实现：`CBaseEntity::Use` 默认无行为，子类可覆盖。 */
  use(activator: Entity | null, caller: Entity | null, useType: number): void {
    for (const cls of this.classChain) {
      if (cls.use) {
        cls.use(this, activator, caller, useType);
        return;
      }
    }
  }
}

/**
 * `CBaseEntity::RunScriptCodeInput` / `InputRunScriptFile` / `InputCallScriptFunction`
 * 的公共部分（baseentity.cpp:7208-7300）：把 activator / caller 注入脚本作用域后执行，
 * 结束再清空。SDK 里作用域由 `ValidateScriptScope()` 建；宿主没有 VM 时等价于
 * ValidateScriptScope 失败 ⇒ 静默丢弃，但仍发一条事件供调试面板观测。
 */
function scriptInput(
  entity: Entity,
  data: InputData,
  kind: 'code' | 'file' | 'function',
  code: string,
): void {
  entity.runtime.emit({ kind: 'vscript', detail: `${kind}:${code.slice(0, 120)}` });
  const evalScript = entity.runtime.host.evalScript;
  if (!evalScript) return;
  const ref = (e: EntityLike | null) => (e ? { targetname: e.targetname, classname: e.classname } : null);
  evalScript(code, {
    kind,
    entity: { targetname: entity.targetname, classname: entity.classname },
    activator: ref(data.activator),
    caller: ref(data.caller),
  });
}

function variantToFieldValue(v: Variant): unknown {
  switch (v.fieldType()) {
    case FIELD_VOID:
      return null;
    case FIELD_BOOLEAN:
      return v.bool();
    case FIELD_INTEGER:
      return v.int();
    case FIELD_FLOAT:
      return v.float();
    case FIELD_STRING:
      return v.string();
    case FIELD_COLOR32:
      return v.color32();
    default:
      return v.toString();
  }
}

// 由 entity-list.ts 注入，避免 base-entity ↔ entity-list 的运行时循环。
let nameMatchesImpl: (query: string, name: string | null) => boolean = () => false;
export function setNameMatcher(fn: (query: string, name: string | null) => boolean): void {
  nameMatchesImpl = fn;
}

// ── CBaseEntity 的 datamap（baseentity.cpp:2162-2205） ──
export const BaseEntityClass: EntityClass = {
  name: 'base',
  outputs: [
    { name: 'OnUser1', kind: 'event' },
    { name: 'OnUser2', kind: 'event' },
    { name: 'OnUser3', kind: 'event' },
    { name: 'OnUser4', kind: 'event' },
  ],
  keyfields: [
    { name: 'target', type: 'string', defaultValue: '' },
    { name: 'master', type: 'string', defaultValue: '' },
    { name: 'globalname', type: 'string', defaultValue: '' },
    { name: 'rendercolor', type: 'color32' },
    { name: 'renderamt', type: 'int', defaultValue: 255 },
    { name: 'gravity', type: 'float', defaultValue: 1 },
    { name: 'health', type: 'int', defaultValue: 0 },
    { name: 'StartDisabled', type: 'bool', defaultValue: false },
  ],
  inputs: [
    { name: 'SetTeam', type: FIELD_INTEGER, key: 'teamnum' },
    { name: 'Alpha', type: FIELD_INTEGER, key: 'renderamt' },
    { name: 'AlternativeSorting', type: FIELD_BOOLEAN, key: 'alternativesorting' },
    { name: 'Color', type: FIELD_COLOR32, key: 'rendercolor' },
    { name: 'SetParent', type: FIELD_STRING, key: 'parentname' },
    { name: 'SetParentAttachment', type: FIELD_STRING, key: 'parentattachment' },
    { name: 'ClearParent', type: FIELD_VOID, key: 'parentattachment' },
    { name: 'SetDamageFilter', type: FIELD_STRING, key: 'damagefilter' },
    { name: 'AddContext', type: FIELD_STRING, key: 'context' },
    { name: 'RemoveContext', type: FIELD_STRING, key: 'context' },
    { name: 'ClearContext', type: FIELD_VOID, key: 'context' },
    { name: 'EnableDamageForces', type: FIELD_VOID, key: 'damageforces' },
    { name: 'DisableDamageForces', type: FIELD_VOID, key: 'damageforces' },
    { name: 'EnableShadow', type: FIELD_VOID, key: 'shadow' },
    { name: 'DisableShadow', type: FIELD_VOID, key: 'shadow' },
    { name: 'DispatchEffect', type: FIELD_STRING, key: 'effect' },
    { name: 'DispatchResponse', type: FIELD_STRING, key: 'response' },
    // VScript 四个输入在 baseentity.cpp:2197-2200 是 DEFINE_INPUTFUNC（不是 DEFINE_INPUT）：
    // 都要先 ValidateScriptScope，并在执行期把 activator / caller 注入脚本作用域，之后清掉。
    // InputRunScript 还负责把 Hammer 的反引号转义还原成双引号（baseentity.cpp:7260-7279）。
    {
      name: 'RunScriptFile',
      type: FIELD_STRING,
      handler: (e, d) => scriptInput(e, d, 'file', d.value.string()),
    },
    {
      name: 'RunScriptCode',
      type: FIELD_STRING,
      handler: (e, d) => scriptInput(e, d, 'code', d.value.string().replace(/`/g, '"')),
    },
    {
      name: 'CallScriptFunction',
      type: FIELD_STRING,
      handler: (e, d) => scriptInput(e, d, 'function', d.value.string()),
    },
    {
      name: 'TerminateScriptScope',
      type: FIELD_VOID,
      handler: (e) => e.runtime.host.terminateScriptScope?.(e.index),
    },
    {
      name: 'Kill',
      type: FIELD_VOID,
      handler: (e) => e.kill(),
    },
    {
      name: 'KillHierarchy',
      type: FIELD_VOID,
      handler: (e) => {
        // 子实体先删，再删自己（baseentity.cpp:4637-4655）。
        for (const child of [...(e.get<Entity[]>('children') ?? [])]) child.kill();
        e.kill();
      },
    },
    {
      name: 'Use',
      type: FIELD_VOID,
      handler: (e, d) => {
        // "Use" 把 nOutputID 当 USE_TYPE 用（baseentity.cpp:4513-4516）。
        e.use(
          d.activator as Entity | null,
          d.caller as Entity | null,
          d.outputID,
        );
      },
    },
    {
      name: 'AddOutput',
      type: FIELD_STRING,
      handler: (e, d) => {
        const s = d.value.string();
        const sp = s.indexOf(' ');
        if (sp < 0) {
          e.runtime.log('AddOutput input fired with bad string');
          return;
        }
        const outName = s.slice(0, sp);
        // Hammer 不允许参数里出现逗号，用冒号转义；这里全换回逗号再走 KeyValue
        // （baseentity.cpp:7641-7649）。
        const action = s.slice(sp + 1).replace(/:/g, ',');
        e.keyValue(outName, action);
      },
    },
    ...([1, 2, 3, 4] as const).map(
      (n): InputDef => ({
        name: `FireUser${n}`,
        type: FIELD_STRING,
        // 输入值被忽略，纯转发 activator（baseentity.cpp:7181-7202）。
        handler: (e, d) => e.fire(`OnUser${n}`, d.activator, e),
      }),
    ),
  ],
};
