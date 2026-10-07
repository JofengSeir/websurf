
import fs from 'node:fs';
import path from 'node:path';
const ROOT=process.cwd();
const SPEC='documents/norms/agent-workflow.md';
const B='<!-- AGENT-WORKFLOW-CORE:BEGIN -->';
const E='<!-- AGENT-WORKFLOW-CORE:END -->';
function readCore(){
  const t=fs.readFileSync(SPEC,'utf8').replace(/\r\n/g,'\n');
  const i=t.indexOf(B), j=t.indexOf(E);
  if(i<0||j<0||j<i) throw new Error('规范文件缺少核心块标记');
  return t.slice(i, j+E.length).replace(/\n+$/,'');
}
const CORE=readCore();
const NOTE='> 本文件是薄适配层：规则正文见 documents/norms/agent-workflow.md；本文件内的工作流核心块由 src/scripts/gen-agent-entrypoints.mjs 生成，请勿手改。';
const w=(rel,text)=>{ const p=path.join(ROOT,rel); fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p, text.replace(/\r?\n/g,'\r\n'), 'utf8'); return rel; };
const done=[];
// 1) AGENTS.md：核心块紧跟在 H1 之后插入/替换（保证截断时也能读到）
{
  const p=path.join(ROOT,'AGENTS.md');
  let t=fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n');
  const block=CORE+'\n';
  if(t.includes(B)){
    const i=t.indexOf(B), j=t.indexOf(E)+E.length;
    t=t.slice(0,i)+block+t.slice(j).replace(/^\n+/,'\n');
  } else {
    const nl=t.indexOf('\n');
    const head=t.slice(0,nl+1);
    t=head+'\n'+block+'\n'+t.slice(nl+1).replace(/^\n+/,'');
  }
  fs.writeFileSync(p,t.replace(/\n/g,'\r\n'),'utf8');
  done.push('AGENTS.md (patch)');
}
// 2) 薄适配文件
done.push(w('CLAUDE.md', ['# Claude Code 入口','',NOTE,'',CORE,''].join('\n')));
done.push(w('GEMINI.md', ['# Gemini CLI 入口','',NOTE,'',CORE,''].join('\n')));
done.push(w('.github/copilot-instructions.md', ['# GitHub Copilot 入口','',NOTE,'',CORE,''].join('\n')));
done.push(w('.windsurfrules', ['# Windsurf 入口','',NOTE,'',CORE,''].join('\n')));
done.push(w('.cline/rules/00-agent-workflow.md', ['# Cline / Roo Code 入口（.cline/rules 目录形态）','',NOTE,'',CORE,''].join('\n')));
done.push(w('.cursorrules', ['# Cursor 入口（旧式 .cursorrules，Cline 亦自动探测）','',NOTE,'',CORE,''].join('\n')));
done.push(w('.clinerules/00-agent-workflow.md', ['# Cline / Roo Code 入口','',NOTE,'',CORE,''].join('\n')));
done.push(w('.cursor/rules/project.mdc', [
  '---',
  'description: WebSurf 通用 agent 工作流（唯一待办看板 TODO.md + 三条硬禁令 + 自检门禁）',
  'globs:',
  'alwaysApply: true',
  '---',
  '',
  NOTE,
  '',
  CORE,
  ''
].join('\n')));
console.log('生成完成：');
done.forEach(d=>console.log('  '+d));
console.log('核心块 '+Buffer.byteLength(CORE,'utf8')+' B');
