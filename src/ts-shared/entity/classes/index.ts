/**
 * 实体类装配入口：`EntitySystem` 构造时调用一次 `installEntityClasses()`。
 *
 * 注册顺序即 datamap 基类依赖顺序（基类先注册，`resolveClassChain` 才能展开链）。
 * 与 SDK 的差别只在「注册方式」：C++ 靠静态 `LINK_ENTITY_TO_CLASS` 在 DLL 加载时
 * 自动注册，TS 侧必须显式调一次；类本身的 inputs/outputs/keyfields 全部按
 * `BEGIN_DATADESC` 顺序声明，分派逻辑没有任何按 classname 写的分支。
 */
import { setNameMatcher } from '../base-entity.js';
import { namesMatch } from '../entity-list.js';
import { clearRegistry } from './registry.js';
import { registerBaseClasses } from './base.js';
import { registerTriggerClasses } from './triggers.js';
import { registerLogicClasses } from './logic.js';
import { registerBrushClasses } from './brush.js';
import { registerFilterClasses } from './filters.js';
import { registerMiscClasses } from './misc.js';
import { registerExtrasClasses } from './extras.js';

let installed = false;

/** 幂等安装。`force=true` 用于测试 / 热重载：清空注册表与链缓存后重装。 */
export function installEntityClasses(force = false): void {
  if (installed && !force) return;
  if (force) clearRegistry();
  // `Entity.nameMatches` / `classMatches` 复用 `NamesMatch` 的唯一实现。
  setNameMatcher(namesMatch);
  registerBaseClasses();
  registerFilterClasses();
  registerTriggerClasses();
  registerLogicClasses();
  registerBrushClasses();
  registerMiscClasses();
  // 装饰/特效实体（env_sprite / prop_dynamic / info_particle_system / point_worldtext）
  // 必须在 Misc 之后：Misc 不再注册 info_particle_system，这里给出带 I/O 的完整类。
  registerExtrasClasses();
  installed = true;
}

export { registerClass, getClass, registeredClassnames, resolveClassChain, isKindOf } from './registry.js';
export { invokeStartTouch, invokeEndTouch, invokeTouch, passesTriggerFilters } from './base.js';
export { invokeUse } from './misc.js';
