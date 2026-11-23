/**
 * 增强插件：运行时伤害/生命（消费 `entity:damage`，给玩家补一个最小 HP/护甲模型）。
 *
 * 解决什么缺口（BSP 审计 §3.7）：
 *   `trigger_hurt` 等实体在 TS 实体层已经能判定「玩家被伤害」并 `host.damagePlayer()`，
 *   但宿主是旁观实现（src/ts-shared/entity/attach.ts:65 → `entity:damage`，detail=`${amount}/${type}`），
 *   玩家没有一个可被扣减的生命值模型，所以伤害在画面上不存在。
 *
 * 本插件只做三件事：
 *   1. 消费 `entity:damage` 事件，扣 HP（有护甲时按 Source 语义吸收 1/3）；
 *   2. HP 归零 → 记死亡、按 Source 语义传回本图主出生点（`context.spawn`）并重置；
 *   3. 把 HP/护甲/最近伤害/死亡次数写进面板状态行（`statusText`）。
 *
 * 边界（故意不碰）：
 *   - 不改物理链、不改渲染链、不接管坠落/越界死亡（那些由既有 `game`/死亡阈值流程负责）；
 *   - 没有 `context.spawn`（地图无玩家出生点）时只重置 HP，不传送，并只提示一次；
 *   - 护甲当前没有任何拾取来源，字段保留给后续「拾取物」插件，值为 0。
 *
 * 默认关闭：宿主不装载本模块、不订阅事件，零成本。
 */
import type {
  EnhancePlugin,
  EnhanceRuntime,
  EnhanceSceneContext,
} from '../../../../../src/ts-shared/enhance/plugin.js';
import type { EntityEvent } from '../../../../../src/ts-shared/entity/types.js';

/** 玩家最大 HP（Source 默认玩家 100；本插件不读地图 sv_*，保持最小模型）。 */
const MAX_HP = 100;
/** 护甲吸收比例：Source `ArmorAbsorbDamage` 对子弹伤害是 1/3（这里对所有类型统一近似）。 */
const ARMOR_ABSORB_FRACTION = 1 / 3;
/** 状态行最多显示的伤害类型名长度（避免畸形 detail 把面板撑爆）。 */
const MAX_TYPE_TEXT = 24;

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 解析 `entity:damage` 的 detail：`${amount}/${type}`（type 可能为空、amount 可能是小数/负数）。 */
export function parseDamageDetail(detail: string): { amount: number; type: string } | null {
  const slash = detail.indexOf('/');
  const amountText = slash >= 0 ? detail.slice(0, slash) : detail;
  const typeText = slash >= 0 ? detail.slice(slash + 1) : '';
  const amount = Number.parseFloat(amountText);
  if (!Number.isFinite(amount)) return null;
  return { amount: Math.max(0, amount), type: typeText.slice(0, MAX_TYPE_TEXT) };
}

export interface DamageHealthState {
  hp: number;
  armor: number;
  deaths: number;
  respawns: number;
  lastDamage: string;
  spawn?: number[];
  spawnYawDeg?: number;
}

/** 纯函数：把一次伤害应用到状态上，返回是否死亡（不改 runtime，便于单测/复用）。 */
export function applyDamage(state: DamageHealthState, amount: number, type: string): boolean {
  const damage = Math.max(0, Math.min(MAX_HP * 10, amount));
  state.lastDamage = type ? `${clampInt(damage, 0, MAX_HP * 10)}（${type}）` : `${clampInt(damage, 0, MAX_HP * 10)}`;
  let remaining = damage;
  if (state.armor > 0) {
    const absorbed = Math.min(state.armor, Math.ceil(damage * ARMOR_ABSORB_FRACTION));
    state.armor -= absorbed;
    remaining = damage - absorbed;
  }
  state.hp = Math.max(0, state.hp - remaining);
  return state.hp <= 0;
}

/** 纯函数：重置为满状态（死亡重生/换图时用）。 */
export function resetVitals(state: DamageHealthState): void {
  state.hp = MAX_HP;
  state.armor = 0;
  state.lastDamage = '—';
}

export async function createDamageHealthPlugin(runtime: EnhanceRuntime): Promise<EnhancePlugin> {
  const state: DamageHealthState = { hp: MAX_HP, armor: 0, deaths: 0, respawns: 0, lastDamage: '—' };
  let loaded = false;
  let warnedNoSpawn = false;

  const respawn = (): void => {
    resetVitals(state);
    if (state.spawn && state.spawn.length === 3) {
      runtime.teleport(state.spawn, state.spawnYawDeg);
      state.respawns += 1;
      runtime.log(`死亡重生：传回出生点（第 ${state.respawns} 次）`);
    } else if (!warnedNoSpawn) {
      warnedNoSpawn = true;
      runtime.log('本图没有可用出生点数据：HP 归零只重置生命值、不传送');
    }
  };

  return {
    id: 'damage-health',
    onMapLoad(context: EnhanceSceneContext) {
      loaded = true;
      warnedNoSpawn = false;
      state.deaths = 0;
      state.respawns = 0;
      state.spawn = context.spawn ? [...context.spawn] : undefined;
      state.spawnYawDeg = context.spawnYawDeg;
      resetVitals(state);
      runtime.log('运行时伤害/生命：已挂到当前地图');
    },
    onEvent(event: EntityEvent) {
      if (event.kind === 'entity:damage') {
        const parsed = parseDamageDetail(event.detail ?? '');
        if (!parsed) return;
        const died = applyDamage(state, parsed.amount, parsed.type);
        if (died) {
          state.deaths += 1;
          runtime.log(`HP 归零：死亡 ${state.deaths} 次`);
          respawn();
        }
        return;
      }
      if (event.kind === 'entity:removePlayer') {
        // Source 的 Kill/RemovePlayer 语义：直接算一次死亡并重生（不额外扣血）。
        state.deaths += 1;
        state.lastDamage = 'removePlayer';
        runtime.log(`收到 removePlayer：按死亡处理（第 ${state.deaths} 次）`);
        respawn();
      }
    },
    statusText() {
      if (!loaded) return '';
      const spawnText = state.spawn ? '' : '；无出生点（死亡不传送）';
      return (
        `HP ${state.hp}/${MAX_HP} 护甲 ${state.armor}；` +
        `最近伤害 ${state.lastDamage}；死亡 ${state.deaths} 次、重生 ${state.respawns} 次${spawnText}`
      );
    },
    dispose() {
      loaded = false;
      resetVitals(state);
    },
  };
}
