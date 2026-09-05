# WebSurf-viewer — 打包产物（single，唯一）

`dist/` 是唯一产物目录（`npm run build:dist`，在 `viewer/` 下）。**纯静态产物，部署侧
不需要 Node / Rust / wasm-pack。** 同一份产物两种用法：

| 用法 | 说明 |
|---|---|
| **双击打开**（file://） | 直接双击 `index.html`——WASM + 解析 Worker 已内嵌，浏览器打开即可用 |
| **本地服务器 / 部署** | `play.cmd` / `play.sh`（起服务器 + 自动开浏览器）、`python serve.py 8090`、`npx serve -l 8090 .`、或任意静态托管 |

## 目录结构

```
dist/
├── index.html                 应用页（classic script；双击或拖进浏览器均可）
├── app.js                     单文件 IIFE：内嵌 WASM(base64) + 录像 Worker（Blob URL）
├── styles.css
├── assets/maps/               示例录像 + 配套规则（HTTP 深链演示用；file:// 下走面板文件选择）
│   ├── surf_null_4.replay.json
│   └── surf_null_4.rule.json
├── serve.py                   静态服务器（python serve.py [port]，默认 8090）
├── play.cmd                   双击 = 起服务器 + 自动打开浏览器（Windows）★
├── play.sh                    同左（macOS/Linux）★
├── README.md / .nojekyll
```

## 双击启动（play.cmd / play.sh）

- Windows：双击 `play.cmd`；macOS/Linux：`bash play.sh`（或 `./play.sh`）。
- 默认端口 8090，支持首参覆盖：`play.cmd 9000` / `./play.sh 9000`。
- 启动后延时 1 秒自动打开浏览器；打印普通页与示例录像深链两种地址；关闭窗口即停服（Ctrl+C 亦可）。
- **工具链**：优先 `python`；缺失时给出中文提示并自动改用 Node 备选 `npx --yes serve -l <port> .`
  （自动安装运行，无需交互）；python 与 npx 都缺失时打印两条指引并退出。

## file:// 与 HTTP 的差异

- file:// 下：WASM、Worker 全部内嵌/Blob，正常可用；地图与录像用页面里
  「选择 BSP 地图…」/「选择 JSON 录像…」按钮或直接拖入窗口。
- HTTP 下额外支持 URL 深链（免点选文件，可分享）：
  `index.html?replay=assets/maps/surf_null_4.replay.json&rule=assets/maps/surf_null_4.rule.json`
  （`?bsp=` / `?replay=` / `?rule=` 任意组合，相对路径相对页面解析，也支持带 CORS 头的绝对 URL）。

## 朝向诊断（录像回放）

「录像」面板 →「朝向诊断」：只用录像自身数据判定映射链**保角自洽**（源/viewer 双空间
「移动方向 vs 首帧朝向」夹角相等 |差|≤1°；绝对夹角不作失败条件——surf 起跑常侧身）；
不自洽时点「一键修正朝向」自动调整 yaw 偏移并重导（pitch 不参与自动修正）。详见
`viewer/README.md` 与 `viewer/docs/overview.md`。

## 部署

整包上传 `dist/` 到任意静态托管（GitHub Pages 已有 `.nojekyll`；Cloudflare Pages / Netlify /
nginx 发布目录指向 `dist/`）。跨域引用远端 BSP/录像时资源方需返回 CORS 头。

## CORS

- 同站点资源无需任何头。
- 录像/规则/地图放在其他域名（OSS、CDN）时，资源方需返回 `Access-Control-Allow-Origin`。

## 参考 nginx 片段

```nginx
server {
  listen 80;
  server_name example.com;
  root /var/www/websurf-viewer/dist;
  index index.html;

  location ~ \.wasm$ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    default_type application/wasm;
  }
  location ~ \.bsp$ {
    default_type application/octet-stream;
  }
  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

## 与源码版的差异

- `dist/` 是 `src/app.ts` + `src/worker/parse-worker.ts` 的 esbuild 产物，single 额外内嵌
  WASM/Worker（见 `scripts/build-dist.mjs`）。
- 深链自动加载（`?bsp= / ?replay= / ?rule=`）在 HTTP（dev、dist）下可用；file:// 下被浏览器拦截。