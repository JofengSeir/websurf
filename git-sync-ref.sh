#!/usr/bin/env bash
# 根治本环境 git tracking ref 不持久问题
# 现象：git fetch/push 成功但 origin/main 等 tracking ref 跨命令回退旧值，
#       git status 恒显示 [ahead N]/[behind N]。
# 根因：本 Bash 沙箱的"临时文件+rename 原子写"批次不跨命令持久；
#       但"直写目标文件"可持久。tracking ref 被 pack 进 .git/packed-refs，故直写它覆盖。
# 用法：bash git-sync-ref.sh          # 从远端权威同步全部 tracking ref
set -e
cd "$(dirname "$0")"
echo "远端权威 refs:"
git ls-remote origin 'refs/heads/*'
echo "更新 .git/packed-refs 中的 refs/remotes/origin/* ..."
for remote_ref in $(git ls-remote origin 'refs/heads/*' | awk '{print $2}'); do
  short="${remote_ref#refs/heads/}"
  tracking="refs/remotes/origin/${short}"
  sha=$(git ls-remote origin "$remote_ref" | awk '{print $1}')
  if [ -f .git/packed-refs ]; then
    sed -i "s|^.* ${tracking}$|${sha} ${tracking}|" .git/packed-refs || true
  fi
  # 顺带写 loose ref（覆盖 packed；不冲突则冗余）
  mkdir -p ".git/$(dirname "$tracking")"
  printf '%s\n' "$sha" > ".git/${tracking}"
  echo "  ${tracking} -> ${sha}"
done
echo "=== 复核 ==="
git status -sb | head -1
