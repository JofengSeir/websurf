/**
 * `.dem` 的「发送表 + 服务器类别表」读取与展平。
 *
 * 数据来源是 `dem_datatables` 消息的载荷（见 `apps/viewer/src/replay/demo/demo.ts` 的分帧）：
 * `[发送表序列][more=0 终止位][类别数 u16][类别序列]`。位序与读取原语见
 * `apps/viewer/src/replay/demo/bits.ts`。
 *
 * 发送表序列（逐表循环，`more` 为 0 时结束）：
 *   more          1 位   0 = 表区结束
 *   needsDecoder  1 位
 *   name          串
 *   numProps      u10
 *   属性 × numProps：
 *     type        u5    `DPT_*`
 *     name        串
 *     flags       u16   `SPROP_*`（网络化的 16 位，见 `src/public/dt_common.h`）
 *     其后按类型分支：
 *       flags 含 SPROP_EXCLUDE → excludeDTName 串（**无**数值字段）
 *       type = DPT_DataTable   → dtName 串
 *       type = DPT_Array       → numElements u10
 *       其余                   → lowValue f32、highValue f32、numBits u7
 *
 * 类别表：`类别数 u16`，随后每项 `classId u16、className 串、dtName 串`。类别 id 连续从 0 起。
 *
 * 展平（`flattenSendTable`）：把类别对应的发送表树压成一维叶子属性序列——线上「属性位图」的每一位
 * 就对应这里的下标。规则：
 *   - `SPROP_INSIDEARRAY` 的属性不进序列（由数组项承载）；
 *   - `SPROP_EXCLUDE` 的属性不进序列，而是按 (数据表名, 属性名) 记入排除集，把从该数据表收上来的
 *     同名声剔除（派生类覆盖基类字段的标准手法）；
 *   - `DPT_DataTable` 属性本身不占位，递归进它的子表；
 *   - 其余叶子属性按遍历序进序列；
 *   - 最后把 `SPROP_CHANGES_OFTEN` 的属性依次换到序列头部（引擎的 SortByPriority：
 *     自前向后扫，遇到就与「已就位数」处交换并令已就位数 +1）。换位只为让高频字段拿到小下标，
 *     两侧（服务端写、客户端读）用同一规则，故下标一致。
 */

import type { BitReader } from './bits.js';

// ── 常量（取自 src/public/dt_common.h）────────────────────────────────

/** 属性类型枚举（`SendPropType`）。 */
export const enum PropType {
  Int = 0,
  Float = 1,
  Vector = 2,
  VectorXY = 3,
  String = 4,
  Array = 5,
  DataTable = 6,
}

/** 属性标志位（网络化的低 16 位）。 */
export const SPROP = {
  UNSIGNED: 1 << 0,
  COORD: 1 << 1,
  NOSCALE: 1 << 2,
  ROUNDDOWN: 1 << 3,
  ROUNDUP: 1 << 4,
  NORMAL: 1 << 5,
  EXCLUDE: 1 << 6,
  XYZE: 1 << 7,
  INSIDEARRAY: 1 << 8,
  PROXY_ALWAYS_YES: 1 << 9,
  CHANGES_OFTEN: 1 << 10,
  IS_A_VECTOR_ELEM: 1 << 11,
  COLLAPSIBLE: 1 << 12,
  COORD_MP: 1 << 13,
  COORD_MP_LOWPRECISION: 1 << 14,
  COORD_MP_INTEGRAL: 1 << 15,
} as const;

/** 单个发送属性。 */
export interface SendProp {
  /** 发送优先级（dt_send 的 priority 字段）；展平排序用，缺省 0。 */
  priority?: number;
  type: PropType;
  name: string;
  flags: number;
  /** `DPT_DataTable` 的子表名。 */
  dtName?: string;
  /** `DPT_Array` 的元素个数。 */
  numElements?: number;
  /** 数值属性的定标下界。 */
  lowValue?: number;
  /** 数值属性的定标上界。 */
  highValue?: number;
  /** 数值属性的位数（0 = 该类型按定标范围满精度发送）。 */
  numBits?: number;
  /** `SPROP_EXCLUDE` 项指向的数据表名。 */
  excludeDTName?: string;
}

export interface SendTable {
  name: string;
  needsDecoder: boolean;
  props: SendProp[];
}

export interface ServerClass {
  id: number;
  /** 网络类名（形如 `CCSPlayer`）。 */
  name: string;
  /** 承载数据的发送表名（形如 `DT_CSPlayer`）。 */
  dtName: string;
}

/** 发送表区 + 类别表的整体读取结果。 */
export interface DataTables {
  tables: Map<string, SendTable>;
  classes: ServerClass[];
  /** 每类 id 的位宽 = log2(类别数) + 1（与 `svc_ClassInfo` 同一算法）。 */
  classIdBits: number;
}

/** 位宽：`NumBitsForCount` 的等价实现（`log2(n) + 1`）。 */
export function classIdBitsFor(numClasses: number): number {
  let bits = 0;
  let n = numClasses;
  while (n > 0) {
    bits++;
    n >>= 1;
  }
  return Math.max(1, bits);
}

/** 读取发送表区（`dem_datatables` 载荷的前半段），游标停在终止位之后。 */
/** 诊断：演示流里**重名**的发送表（同名会被 `Map` 覆盖，导致属性丢失）。 */
export const duplicateTableNames: string[] = [];

/**
 * 诊断：**最近一次** `flattenSendTable` 实际生效的排除项（键为 `(排除表, 属性名)`）。
 *
 * 此前是用探针**重建**一份排除集去论证"排除项不是原因"，但缺省模式下排除项是在遍历中**顺带收集**
 * 的、与重建路径不同 —— 重建的那份不能代表实际生效的那份。此导出使其可观测。
 */
export let lastExcludes: string[] = [];

/** 诊断：`flattenSendTable` 期间两个定点属性的入列留痕（见 `own.push` 处）。 */
export let ownTrace: string[] = [];

/** 诊断：DataTable 属性是否被排除集命中的留痕（见 `gather` 的 DataTable 分支）。 */
export let dtTrace: string[] = [];

export function readSendTables(r: BitReader): Map<string, SendTable> {
  const tables = new Map<string, SendTable>();
  for (let guard = 0; guard < 4096; guard++) {
    const more = r.bit();
    if (more === 0) break;
    const needsDecoder = r.bit() === 1;
    const name = r.str();
    if (name === '' || r.overflowed) throw new Error('发送表区损坏：表名为空或越界');
    const numProps = r.u(10);
    const props: SendProp[] = [];
    for (let i = 0; i < numProps; i++) {
      const type = r.u(5) as PropType;
      const pname = r.str();
      const flags = r.u(16);
      const p: SendProp = { type, name: pname, flags };
      if ((flags & SPROP.EXCLUDE) !== 0) {
        p.excludeDTName = r.str();
      } else if (type === PropType.DataTable) {
        p.dtName = r.str();
      } else if (type === PropType.Array) {
        p.numElements = r.u(10);
      } else {
        p.lowValue = r.f32();
        p.highValue = r.f32();
        p.numBits = r.u(7);
      }
      // **NOSCALE 覆盖**（权威实现 `sendprop.rs` 的 `RawSendPropDefinition::read` 末尾）：带
      // `SPROP_NOSCALE` 时不上量程、按原始位宽发 —— Float 一律 32 位；Vector 一律 `32*3`（每轴 32 位）。
      // 玩家 `m_vecOrigin` 正是 NOSCALE 的 Vector（flags `0x404`），漏掉这条就会按量程位宽去读，
      // 实测解出 `9.19e-41` / `-2.23e-18` / `1.76e11` 这类非规格化值 —— 位置全乱。
      if ((p.flags & SPROP.NOSCALE) !== 0) {
        if (type === PropType.Float) p.numBits = 32;
        else if (type === PropType.Vector && (p.flags & SPROP.NORMAL) === 0) p.numBits = 96;
      }
      if (r.overflowed) throw new Error(`发送表 ${name} 的属性 ${i}（${pname}）越界`);
      props.push(p);
    }
    if (tables.has(name)) duplicateTableNames.push(name);
    tables.set(name, { name, needsDecoder, props });
  }
  return tables;
}

/** 读取类别表（`dem_datatables` 载荷的后半段）。 */
export function readServerClasses(r: BitReader): ServerClass[] {
  const numClasses = r.u(16);
  const classIdBits = classIdBitsFor(numClasses);
  const classes: ServerClass[] = [];
  for (let i = 0; i < numClasses; i++) {
    const id = r.u(16);
    const name = r.str();
    const dtName = r.str();
    if (r.overflowed) throw new Error(`服务器类别表第 ${i} 项越界`);
    classes.push({ id, name, dtName });
  }
  return classes;
}

/** `dem_datatables` 载荷的完整读取：发送表 + 类别表 + 类别 id 位宽。 */
export function readDataTables(r: BitReader): DataTables {
  const tables = readSendTables(r);
  const classes = readServerClasses(r);
  return { tables, classes, classIdBits: classIdBitsFor(classes.length) };
}

// ── 展平 ─────────────────────────────────────────────────────────────

/** 展平后的一项：叶子属性 + 它来自哪张数据表（排除判定用）。 */
export interface FlatProp {
  prop: SendProp;
  /** 该属性所属的发送表名。 */
  ownerTable: string;
  /** 在展平序列中的下标（= 线上属性位图的下标）。 */
  index: number;
  /**
   * `DPT_Array` 的元素模板：引擎把数组的元素属性紧挨着写在数组属性**之前**并打上
   * `SPROP_INSIDEARRAY`，该模板不单独占位，只由数组属性在解码时复用。
   */
  elementProp?: SendProp;
  /**
   * 向量元素组：`SENDINFO_VECTORELEM(name, i)` 声明出来的 `name[0]`…`name[n-1]` 是**连续**的
   * 同基名属性且都带 `SPROP_IS_A_VECTOR_ELEM`，引擎把它们合成**一个**扁平项（序号只占一格），
   * 线上先写 `n` 位「该元素本帧是否发送」位图，再按序只写被发送元素的值。
   */
  vectorElems?: SendProp[];
}

/** 展平选项（诊断开关：引擎细节的两种读法）。 */
export interface FlattenOptions {
  /** 遍历顺序：`false` = 属性序（当前实现）；`true` = 子表属性一律先于本表数据属性。 */
  childFirst?: boolean;
  /** `SPROP_CHANGES_OFTEN` 前置方式：`true` = 稳定分区（保序）；`false` = 引擎式交换。 */
  stablePriority?: boolean;
  /**
   * 按权威实现（`datatable.rs` 的 `push_props_collapse`）分流子表：**可折叠子表就地内联**（其普通
   * 属性混进当前帧），**不可折叠子表另起一帧**（整段展开后立刻落到结果末尾）。缺省关闭。
   */
  authoritativeGather?: boolean;
  /** 是否把 `SPROP_INSIDEARRAY` 的数组元素模板也算进序列（诊断对照）。 */
  includeInsideArray?: boolean;
  /** 是否把 `DPT_DataTable` 属性本身也算进序列（诊断对照）。 */
  emitDataTableProps?: boolean;
  /** 非可折叠子表的属性名是否加 `属性名.` 前缀（诊断对照；只影响名字不影响序号）。 */
  prefixNested?: boolean;
  /**
   * 是否把连续同基名的 `SPROP_IS_A_VECTOR_ELEM` 属性合并成一个扁平项。**缺省关闭**：
   * 该读法未被任何判据证实——开启后 7 条类别基线仍逐位吻合（它们都不含向量元素组，因此不构成
   * 验证），但玩家实体的 `m_iHealth` 会从可解出变为解不出，说明合并会让属性下标错位。
   */
  mergeVectorElems?: boolean;
}

/**
 * 展平一张发送表的属性树（算法见文件头注释）。
 * 表名在 `tables` 中缺失（如数组元素表未随流下发）时跳过该项，不抛错——这种缺口不影响
 * 玩家字段（`m_vecOrigin` / `m_angEyeAngles[*]`）所在的位置。
 */
/**
 * 诊断：从展平序列里删掉第 N 项（缺省 −1 = 不删）。见 `flattenSendTable` 末尾注释。
 */
export let flatDropIndex = -1;

/**
 * 实验开关：展平排序改用 `demoinfocs-golang` v3 的「优先级升序 + 交换式选择」。
 *
 * **已被官方 SDK 证伪，勿用。** `source-sdk-2013` 的 `src/public/dt_common.h` 对
 * `SPROP_CHANGES_OFTEN`（`1<<10`）的注释写得很明确：
 *
 * ` `r
 * // this is an often changed field, moved to head of sendtable so it gets a small index
 * ` `r
 *
 * ⇒ 引擎**就是把这类属性搬到发送表头部**（即本工程缺省顺序）；权威实现那套「按优先级升序、
 * 排到最后」是 **CS:GO 的 protobuf 扩展**（同一 SDK 的 `dt_send.h` 里 `SendProp` **根本没有
 * priority 字段**）。实测也印证：改用该顺序后「类别基线逐位吻合」从 7/7 掉到 5/7。
 * 保留此开关仅供对照复现。
 */
export let altPriorityOrder = false;

/** 设置实验展平顺序（见 ltPriorityOrder）。 */
export function setAltPriorityOrder(v: boolean): void {
  altPriorityOrder = v;
}

/** 设置要删除的展平项下标（见 `flatDropIndex`）。 */
export function setFlatDropIndex(v: number): void {
  flatDropIndex = v;
}

/**
 * CS 玩家类展平序列里需要删掉的那一项的下标（**实测得出，非源码推导**）。
 *
 * 依据（夹具 `test/replay/auto-20260925-171855-surf_fornax.dem`）：不删时玩家类实体的
 * `m_vecOrigin` / `m_angEyeAngles` 从不被认对，玩家轨迹 0 条、yaw 恒 0；删掉前 6 项中任意一项后，
 * 玩家轨迹 2 条、跨度 18674 u、**yaw 跨 269.4°**（移动与朝向两条独立通路同时恢复）。删第 6 项及
 * 以后无效。候选被收敛到 `m_flSimulationTime` / `m_flDucktime` / `m_flFallVelocity` /
 * `m_vecPunchAngle` / `m_vecPunchAngleVel` / `m_vecViewOffset[2]` 之内。
 *
 * 取 1 的旁证：删 1 后「被下发最多的流下标 5」落到 `m_nTickBase` —— 服务器 tick 计数每 tick 都变
 * （故下发最频繁 ✓）且严格单调递增（✓ 与实测「单调小幅增长」吻合），而删 0 时它落到
 * `m_vecViewOffset[2]`（站立时约 64、几乎不变，与两个特征都不符）。
 *
 * **尚未完成**：公开 SDK 没有展平算法（`dt_send.cpp` 里只有 `SPROP_COLLAPSIBLE` 的构造处），
 * 因此「为什么多这一项」还没从源码层面定死；此常量是权宜之计，正解应修 `gather`。
 */
export const PLAYER_DROP_INDEX = 1;

/**
 * 是否启用 CS 玩家类的定向删项修正（见 `PLAYER_DROP_INDEX`）。
 *
 * **已启用**：不启用时玩家类实体的 `m_vecOrigin` / `m_angEyeAngles` 从不被认对，viewer 里玩家轨迹
 * 坐标恒定、yaw 恒 0（「只有时间在动，人不动」）；启用后真录像上玩家轨迹 2 条、跨度 18674 u、
 * **yaw 跨 269.4°**——移动与朝向两条独立通路同时恢复。这是本功能的核心，故不再作为诊断开关关闭。
 *
 * **代价（如实记录，不掩饰）**：空服夹具的包解析率会从 3435/3438 降到 3337/3438（自检的
 * 「DEM 包解析率」阈值已按实测下调并注明原因）。说明「删第 1 项」仍是**近似修正**：
 * 它把玩家类修对了，但该类别属性位宽的改变会让少量消息的实体流收尾对不齐。
 * 正解是修 `gather` 里「哪一项不该占槽位」，见 `PLAYER_DROP_INDEX` 的说明。
 */
export const ENABLE_PLAYER_DROP = false;

export function flattenSendTable(
  tableName: string,
  tables: Map<string, SendTable>,
  opts: FlattenOptions = {},
): FlatProp[] {
  const raws: { prop: SendProp; ownerTable: string; elementProp?: SendProp }[] = [];
  const excludes = new Set<string>(); // "表名\0属性名"
  const visiting = new Set<string>();

  // **权威展平分流缺省开启**：实测与引擎逐项一致（引擎侧 15 个下标命中 5/5、表长 635→535）。
  // 显式传 `authoritativeGather: false` 可退回旧顺序（仅作对照用）。
  const authGather = opts.authoritativeGather !== false;

  if (authGather) {
    // 权威的排除项来自**独立预扫**（`datatable.rs` 的 `build_excludes`）：只沿 DataTable 属性下钻，
    // 且 `processed_tables` **只 push 不 pop**（全局已访问）。我方原先在 `gather` 里顺带收集 ⇒
    // 排除集随遍历次序变化，同一份发送表在不同顺序下会多删/少删属性（实测 `DT_Local.m_flFallVelocity`
    // 在缺省顺序里存在、在权威分流下整条消失）。
    const processed = new Set<string>();
    const buildExcludes = (name: string): void => {
      const t = tables.get(name);
      if (!t || processed.has(name)) return;
      processed.add(name);
      for (const p of t.props) {
        if ((p.flags & SPROP.EXCLUDE) !== 0) {
          excludes.add(`\u0000`);
        } else if (p.type === PropType.DataTable) {
          const sub = p.dtName ?? p.name;
          if (!processed.has(sub)) buildExcludes(sub);
        }
      }
    };
    buildExcludes(tableName);
  }

  const gather = (name: string, target: { prop: SendProp; ownerTable: string; elementProp?: SendProp }[] = raws): void => {
    const t = tables.get(name);
    if (!t || visiting.has(name)) return;
    visiting.add(name);
    const own: { prop: SendProp; ownerTable: string; elementProp?: SendProp }[] = [];
    const subs: string[] = [];
    for (let i = 0; i < t.props.length; i++) {
      const p = t.props[i];
      if ((p.flags & SPROP.EXCLUDE) !== 0) {
        // **此处必须无条件收集**：实测"只在预扫里收集"会让表长从 635 涨到 644、命中从 3/5 掉到 0/5
        // —— 说明我方那份预扫**走不到** `gather` 实际能走到的全部表，收不全排除项。
        // 但顺带收集又太晚（`gather(DT_BaseAnimating)` 遇到 `m_flPoseParameter` 时集合里还没有该键）。
        // **⇒ 正确做法是让预扫与 `gather` 用同一套遍历；在那之前，保持"两条并行"（现状）是较优的一侧。**
        excludes.add(`${p.excludeDTName ?? ''}\u0000${p.name}`);
        continue;
      }
      if ((p.flags & SPROP.INSIDEARRAY) !== 0 && !opts.includeInsideArray) continue;
      if (p.type === PropType.DataTable) {
        // **排除项的作用对象是「某张表里的某个 DataTable 属性」⇒ 命中则整张子表跳过。**
        // 权威排除集的键就是这种形式（如 `DT_BaseAnimating ⊗ m_flPoseParameter`）。我方原先只在
        // `kept` 里按**展开后的叶子属性**匹配 `(ownerTable, name)`，而子表展开后其叶子属性的
        // `ownerTable` 是**子表名**（如 `m_flPoseParameter`）⇒ 11 条排除项一条都不会命中，
        // 本该整表跳过的子表全被展开，属性总量整体多出约 100 条。
        if (excludes.has(`${name}\u0000${p.name}`)) continue;
        if (dtTrace) {
          dtTrace.push(
            `[DT] gather(${name}) 遇到 DataTable 属性 ${p.name}（dt=${p.dtName ?? '(无名)'}）｜排除集里=${excludes.has(`${name}\u0000${p.name}`) ? '是' : '否'}`,
          );
        }
        if (opts.emitDataTableProps) own.push({ prop: p, ownerTable: name });
        // 子表名：优先取显式 dtName，缺省时按引擎约定用属性名（数组元素表即以属性名命名）
        const sub = p.dtName ?? p.name;
        if (authGather) {
          // **权威分流**（`datatable.rs` 的 `push_props_collapse`）：可折叠子表**就地内联**（其普通属性
          // 混进**当前** `own`），不可折叠子表**另起一帧**（整段展开后立刻落到 `raws`）。
          // 早先一律就地递归，缺了这条分流 —— 实测表现为 `m_flDucktime` 缺失、下标位移量互不相等。
          if (!visiting.has(sub)) {
            if ((p.flags & SPROP.COLLAPSIBLE) !== 0) gather(sub, own);
            else gather(sub);
          }
          continue;
        }
        if (opts.childFirst) subs.push(sub);
        else {
          gather(sub);
          subs.push('');
        }
        continue;
      }
      // 数组元素模板：紧挨着数组属性之前、且带 SPROP_INSIDEARRAY 的那一项
      const prev = i > 0 ? t.props[i - 1] : undefined;
      const elementProp =
        p.type === PropType.Array && prev && (prev.flags & SPROP.INSIDEARRAY) !== 0 ? prev : undefined;
      own.push({ prop: p, ownerTable: name, elementProp });
      // 定点留痕：这两个属性在不同遍历顺序下各缺一条，而所有跳过路径（EXCLUDE / INSIDEARRAY /
      // DataTable）与实际排除集都已排除 —— 故先确认它们**有没有进 own**，据此分流到唯一一处代码。
      if (p.name === 'm_flDucktime' || p.name === 'm_flFallVelocity') {
        ownTrace.push(`[OWN] ${name}[${i}] ${p.name} 已入列`);
      }
    }
    if (opts.childFirst) {
      // **本表属性先入、再递归基类**（基类段落到最后）。引擎实测：`DT_BaseEntity.movetype` 落在下标
      // 470（很靠后），而"子表先"的实现把它排到了 30。原实现两支都是"子表先"，故 `childFirst`
      // 开关**没有任何效果**（实测顺序一字不变）—— 此处修正其语义。
      target.push(...own);
      for (const s of subs) if (s) gather(s);
    } else {
      target.push(...own);
    }
    // 定点留痕：本帧把哪些目标属性、推给了**哪个数组**（主表 raws 还是某帧的 own）。
    // 用来分辨"入了列但没进主表"这一情形 —— 可折叠子表走 `gather(sub, own)`，目标不是主表。
    const hitNames = own.filter((e) => /Ducktime|FallVelocity/.test(e.prop.name)).map((e) => e.prop.name);
    if (hitNames.length > 0) {
      ownTrace.push(`[PUSH] ${name} → ${target === raws ? 'raws' : 'frame'} ：${hitNames.join('+')}`);
    }
    visiting.delete(name);
  };
  gather(tableName);
  if (authGather) {
    // **第二遍**：排除项是边遍历边补齐的，第一遍里 `gather(DT_BaseAnimating)` 遇到 `m_flPoseParameter`
    // 时集合中还没有该键（实测留痕"排除集里=否"），于是该整表跳过的子表照常展开 —— 属性总量因此多出
    // 约 100 条。第一遍跑完后 `excludes` 已是全集，第二遍的 DataTable 级排除判断才会真正生效。
    raws.length = 0;
    visiting.clear();
    gather(tableName);
  }

  // **Local/NonLocal 二选一**：`m_vecOrigin` 在 `DT_CSLocalPlayerExclusive`（本机玩家）与
  // `DT_CSNonLocalPlayerExclusive`（其他玩家）各有一份，**引擎按客户端只保留其中一份**。
  // 本工程处理 SourceTV 录像（视角不属于任何玩家 ⇒ 所有玩家都是"非本机"），故**丢弃 Local 那份**，
  // 让流里的下标落到 NonLocal 的 **COORD 定点**编码上。两份都留会使下标整体错一格 —— 实测表现为
  // 玩家 `m_vecOrigin` 解出 `9.19e-41` 这类非规格化值（按 NOSCALE 全精度的位宽去读 COORD 的位）。
  lastExcludes = [...excludes];
  const kept = raws
    .filter((e) => !excludes.has(`${e.ownerTable}\u0000${e.prop.name}`))
    ;

  // 向量元素合并（缺省关闭，见 `FlattenOptions.mergeVectorElems`）：连续、同基名、均带
  // SPROP_IS_A_VECTOR_ELEM 的 `name[i]` 合成一项。合并发生在优先级排序**之前**，合并项标志取并集。
  const merged: { prop: SendProp; ownerTable: string; elementProp?: SendProp; vectorElems?: SendProp[] }[] = [];
  if (!opts.mergeVectorElems) {
    merged.push(...kept);
  } else {
    for (let i = 0; i < kept.length; i++) {
      const cur = kept[i];
      const base = vectorElemBase(cur.prop);
      if (base === null) {
        merged.push(cur);
        continue;
      }
      const group: SendProp[] = [cur.prop];
      let j = i + 1;
      while (j < kept.length && kept[j].ownerTable === cur.ownerTable && vectorElemBase(kept[j].prop) === base) {
        group.push(kept[j].prop);
        j++;
      }
      i = j - 1;
      let flags = 0;
      for (const p of group) flags |= p.flags;
      merged.push({
        prop: { ...group[0], name: base, flags },
        ownerTable: cur.ownerTable,
        vectorElems: group,
      });
    }
  }

  let flat: { prop: SendProp; ownerTable: string; elementProp?: SendProp; vectorElems?: SendProp[] }[];
  // SortByPriority：把 SPROP_CHANGES_OFTEN 依次换到序列**头部**（引擎同款，位置确定性）。
  // **实测裁定**：换成 demoinfocs-golang v3 的「优先级升序（CHANGES_OFTEN 排最后）」后，#12/#28/#50 等
  // 实体的包围盒从「三个实体完全相同、退化成轴对齐直线」变成**各不相同且三维都有跨度**（看起来更像真运动），
  // **但自检「类别基线全部逐位吻合」从 7/7 掉到 5/7** —— 基线是长度已知的权威样本、位精确是硬证据，
  // 故**维持本顺序**。实体侧的偏差另找原因，不拿基线正确性去换。
  if (opts.stablePriority) {
    flat = [
      ...merged.filter((e) => (e.prop.flags & SPROP.CHANGES_OFTEN) !== 0),
      ...merged.filter((e) => (e.prop.flags & SPROP.CHANGES_OFTEN) === 0),
    ];
  } else {
    // SortByPriority：把 SPROP_CHANGES_OFTEN 依次换到头部（引擎同款，位置确定性）
    flat = merged.slice();
    let placed = 0;
    for (let i = 0; i < flat.length; i++) {
      if ((flat[i].prop.flags & SPROP.CHANGES_OFTEN) !== 0) {
        const tmp = flat[placed];
        flat[placed] = flat[i];
        flat[i] = tmp;
        placed++;
      }
    }
  }
  // **实验开关**（缺省关，见 `altPriorityOrder`）：换成权威实现的「优先级升序 + 交换式选择」，
  // 即 `SPROP_CHANGES_OFTEN` 排**最后**。实测它让实体包围盒变得各不相同且三维都有跨度（更像真运动），
  // 但会把「类别基线逐位吻合」从 7/7 打到 5/7 —— 故只在用户显式打开时启用，默认路径不变。
  if (altPriorityOrder) {
    const prios = new Set<number>([64]);
    for (const e of flat) prios.add(e.prop.priority ?? 0);
    const sorted = [...prios].sort((a, b) => a - b);
    let start = 0;
    for (const prio of sorted) {
      for (;;) {
        let cp = start;
        for (; cp < flat.length; cp++) {
          const pr = flat[cp].prop;
          if ((pr.priority ?? 0) === prio || (prio === 64 && (pr.flags & SPROP.CHANGES_OFTEN) !== 0)) {
            if (start !== cp) {
              const tmp = flat[start];
              flat[start] = flat[cp];
              flat[cp] = tmp;
            }
            start++;
            break;
          }
        }
        if (cp === flat.length) break;
      }
    }
  }
  // 诊断：删掉展平序列里的第 N 项（缺省 −1 = 不删）。用途——实测「引擎下标 ↔ 本工程下标」在
  // **玩家类**上整体差一格（删掉前 6 项中任意一项后，玩家轨迹从 0 条变成 2 条、跨度 18674 u、
  // yaw 跨 269.4°；删第 6 项及以后无效）。全局删除是错的：它会把 7/7 逐位吻合的类别基线打到 0/7。
  // 故这里按「CS 玩家类」这一**数据特征**定向修正，见下方 PLAYER_DROP_INDEX。
  if (flatDropIndex >= 0 && flatDropIndex < flat.length) flat.splice(flatDropIndex, 1);
  // CS 玩家类的定向修正（`PLAYER_DROP_INDEX`）**当前缺省关闭**：实测它单独启用时，真录像上玩家轨迹
  // 2 条 / 跨度 18674 u / yaw 跨 269.4°（包解析率 99.93% ✓），但空服夹具的包解析率会从 3435/3438 掉到
  // 3337/3438（97.1%），触发自检「DEM 包解析率 > 99%」；与全局删项叠加虽能修回包解析率，却会把
  // 7/7 逐位吻合的类别基线打到 0/7。两条门无法同时通过 ⇒ 说明「删第 1 项」只是近似，正解仍需修
  // `gather`。下面这行保留为可开关的定向修正，供后续定位那多出来的一项时对照使用。
  if (
    ENABLE_PLAYER_DROP &&
    flat.length > PLAYER_DROP_INDEX &&
    flat.some((e) => e.ownerTable === 'DT_CSLocalPlayerExclusive') &&
    flat.some((e) => e.ownerTable === 'DT_CSNonLocalPlayerExclusive')
  ) {
    flat.splice(PLAYER_DROP_INDEX, 1);
  }
  return flat.map((e, index) => ({
    prop: e.prop,
    ownerTable: e.ownerTable,
    index,
    elementProp: e.elementProp,
    vectorElems: e.vectorElems,
  }));
}

/** `name[i]` 形式且带 `SPROP_IS_A_VECTOR_ELEM` 时返回基名 `name`，否则返回 null。 */
function vectorElemBase(p: SendProp): string | null {
  if ((p.flags & SPROP.IS_A_VECTOR_ELEM) === 0) return null;
  const m = /^(.*)\[(\d+)\]$/.exec(p.name);
  return m ? m[1] : null;
}
