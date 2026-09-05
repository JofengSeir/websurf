/**
 * 规则文件解析：.js 脚本与规则 JSON 统一入口。
 *
 * 判定：trim 后以 `{` 开头按规则 JSON 处理（version===1 且有 scriptSrc 才有效），
 * 其余一律按裸脚本文本处理——脚本是「求值为 (raw, i, H) => Frame 的单表达式」，
 * 由 compileScript 编译。深链 ?rule= 与「载入规则脚本」共用这里。
 */

import type { RuleConfig } from './types.js';
import { defaultRule } from './types.js';

export type RuleFileResult =
  | { kind: 'json'; rule: RuleConfig }
  | { kind: 'script'; rule: RuleConfig }
  | null;

export function ruleFromText(text: string, name: string): RuleFileResult {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<RuleConfig>;
      if (parsed?.version === 1 && typeof parsed.scriptSrc === 'string') {
        return { kind: 'json', rule: { ...defaultRule(), ...parsed } as RuleConfig };
      }
      return null; // 是 JSON 但不是规则文件
    } catch {
      // 以 { 开头却解析失败：坏掉的规则 JSON，不当作脚本
      return null;
    }
  }
  return { kind: 'script', rule: { ...defaultRule(), name, scriptSrc: text } };
}
