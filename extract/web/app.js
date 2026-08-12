// bsp-extract web 入口:导入 bsp → wasm 解析 → 导出 GLB。
import init, { bsp_to_glb, bsp_info } from '../pkg/bsp_extract.js';

let wasmReady = false;
let currentBytes = null;

const drop = document.getElementById('drop');
const fileInput = document.getElementById('file');
const metaEl = document.getElementById('meta');
const actions = document.getElementById('actions');
const exportBtn = document.getElementById('export');
const errEl = document.getElementById('err');

async function boot() {
  await init();
  wasmReady = true;
  errEl.style.display = 'none';
}

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

exportBtn.addEventListener('click', async () => {
  if (!currentBytes) return;
  exportBtn.disabled = true;
  exportBtn.textContent = '导出中…';
  try {
    const glb = bsp_to_glb(currentBytes);
    download(glb, 'map.glb');
  } catch (e) {
    showErr(String(e));
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = '导出 GLB';
  }
});

async function handleFile(file) {
  if (!wasmReady) await boot();
  showErr('');
  metaEl.style.display = 'none';
  actions.style.display = 'none';
  try {
    const buf = await file.arrayBuffer();
    currentBytes = new Uint8Array(buf);
    const info = JSON.parse(bsp_info(currentBytes));
    renderMeta(file.name, info);
    actions.style.display = 'flex';
    exportBtn.disabled = false;
  } catch (e) {
    currentBytes = null;
    showErr(`解析失败:${e}`);
  }
}

function renderMeta(name, info) {
  metaEl.innerHTML = `
    <div><span class="k">文件</span> ${esc(name)}</div>
    <div><span class="k">BSP 版本</span> v${info.version} · mapRevision ${info.mapRevision}</div>
    <div><span class="k">Lump</span> ${info.lumpsPresent} 个(压缩 ${info.lumpsCompressed})</div>
    <div><span class="k">实体</span> ${info.entities} · <span class="k">PAK 条目</span> ${info.pakEntries}</div>
    <div><span class="k">几何</span> ${info.materialGroups} 材质组 · ${info.vertices} 顶点 · ${info.triangles} 三角形</div>`;
  metaEl.style.display = 'block';
}

function download(bytes, filename) {
  const blob = new Blob([bytes], { type: 'model/gltf-binary' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function showErr(msg) { errEl.textContent = msg; errEl.style.display = msg ? 'block' : 'none'; }

boot().catch((e) => showErr(`wasm 加载失败:${e}`));
