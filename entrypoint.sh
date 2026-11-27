#!/usr/bin/env sh
set -eu

# 给几个关键目录设默认值（可被 docker run -e 覆盖）
: "${DSH_HOME:=/opt/dsh-home}"
: "${AGENTRUN_DIR:=/opt/agentrun}"
: "${DSH_AGENT_CWD:=/workspace}"
export DSH_HOME AGENTRUN_DIR DSH_AGENT_CWD

cd /app/deepseek-harness-adapter

# 1) 依据 agent_metadata 生成 / 刷新 acp profile 到 $DSH_HOME/profiles/acp
#    首次会 pnpm 安装插件依赖（esdk-obs-nodejs/fflate/yaml/agentarts-sdk 等），
#    之后依赖指纹不变会跳过重复安装，只快速重渲染 cordis.patch.yml。
node --input-type=module -e "\
  import { loadAdapterConfig } from './adapter/dist/config.js'; \
  import { materializeProfile } from './adapter/dist/patch.js'; \
  const c = loadAdapterConfig(); \
  const p = materializeProfile(c); \
  console.log('[entrypoint] acp profile ready:', p.profileDir); \
"

# 2) 启动适配器主进程（bootstrapAcpFromAgentMetadata -> loadConfig -> createDshApp）
exec node adapter/dist/main.js