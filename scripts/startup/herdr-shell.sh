#!/usr/bin/env bash
# Herdr 项目 pane 的 Bash 入口：保留 herdr.sh 设置的本地 PATH、缓存与 HISTFILE，不加载会覆盖这些环境的全局 Shell 配置。
exec /bin/bash --noprofile --norc -i
