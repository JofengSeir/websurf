
import fs from 'node:fs';
import path from 'node:path';
const ROOT=process.cwd();
const SPEC='documents/norms/agent-workflow.md';
const B='<!-- AGENT-WORKFLOW-CORE:BEGIN -->';
const E='<!-- AGENT-WORKFLOW-CORE:END -->';
const spec=fs.readFileSync(SPEC,'utf8').replace(/\r\n/g,'\n');
const i=spec.indexOf(B), j=spec.indexOf(E);
if(i<0||j<0) { console.log('[H] 规范文件缺少核心块标记'); process.exit(1); }
const CORE=spec.slice(i,j+E.length).replace(/\n+$/,'');
const TARGETS=['AGENTS.md','CLAUDE.md','GEMINI.md','.github/copilot-instructions.md','.windsurfrules','.clinerules/00-agent-workflow.md','.cursor/rules/project.mdc'];
const bad=[];
for(const rel of TARGETS){
  const p=path.join(ROOT,rel);
  if(!fs.existsSync(p)){ bad.push(rel+' 不存在'); continue; }
  const t=fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n');
  if(!t.includes(CORE)) bad.push(rel+' 的核心块与规范不一致');
  if(!/agent-workflow\.md/.test(t)) bad.push(rel+' 未指向 documents/norms/agent-workflow.md');
}
// 反向：规范里登记的工具入口应与生成器目标一致（防止新增工具漏登记）
const gen=fs.readFileSync('src/scripts/gen-agent-entrypoints.mjs','utf8');
for(const rel of TARGETS){
  const token=rel==='AGENTS.md'?'AGENTS.md':rel;
  if(!gen.includes(token.replace(/\\\\/g,'/')) && rel!=='AGENTS.md') bad.push('生成器缺少目标 '+rel);
}
console.log('[H] agent 入口同源：目标 '+TARGETS.length+' 个｜不一致 '+bad.length);
bad.forEach(x=>console.log('   '+x));
process.exit(bad.length?1:0);
