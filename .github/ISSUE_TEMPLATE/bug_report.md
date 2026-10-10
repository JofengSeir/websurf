---
name: Bug 报告
about: 报告一个 bug 帮助我们改进
title: "[Bug] "
labels: bug
assignees: ''
---

**描述问题**

简洁清晰地描述这个 bug。

**所属工程**

- [ ] debug（`apps/debug`，调试台：碰撞/路径/平面检视、录制）
- [ ] game（`apps/game`，游玩：物理 + 面板）
- [ ] viewer（`apps/viewer`，查看器 + 回放）
- [ ] 共享层（`src/`，**三端**均受影响）

**复现步骤**

1. 打开 ...
2. 点击 ...
3. 出现错误

**预期行为**

你期望发生什么？

**实际行为**

实际发生了什么？（可附截图；浏览器 DevTools Console 报错信息请一并粘贴）

**环境**

- 浏览器及版本：
- 操作系统：
- 地图文件：
- 运行模式：SAB 共享内存（HTTP + COOP/COEP） / 消息回退（file:// 或静态部署）
