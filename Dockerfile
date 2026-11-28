# syntax=docker/dockerfile:1

###############################################################################
# 阶段 1：构建 adapter/runtime/shared 的 TypeScript 产物
###############################################################################
FROM node:26-bookworm AS build

ARG PNPM_VERSION=12.21.0
ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /src/deepseek-harness-adapter

# 先只放依赖清单，命中构建缓存
COPY deepseek-harness-adapter/package.json \
     deepseek-harness-adapter/pnpm-workspace.yaml \
     deepseek-harness-adapter/pnpm-lock.yaml \
     deepseek-harness-adapter/tsconfig.base.json \
     deepseek-harness-adapter/tsconfig.check.json ./

COPY deepseek-harness-adapter/shared   shared
COPY deepseek-harness-adapter/adapter  adapter
COPY deepseek-harness-adapter/runtime  runtime
COPY deepseek-harness-adapter/plugins  plugins
COPY deepseek-harness-adapter/profile  profile

RUN npm install -g pnpm@${PNPM_VERSION} \
 && pnpm config set registry "${NPM_REGISTRY}" \
 && pnpm install --frozen-lockfile \
 && pnpm build

###############################################################################
# 阶段 2：运行时（内置 DSH CLI + pnpm + 运行时依赖）
###############################################################################
FROM node:26-bookworm-slim AS runtime

ARG PNPM_VERSION=12.21.0
ARG DSH_VERSION=0.2.2-rc.3
ARG NPM_REGISTRY=https://registry.npmmirror.com

ENV NODE_ENV=production \
    AGENT_SERVER_HOST=0.0.0.0 \
    AGENT_SERVER_PORT=18092

WORKDIR /app/deepseek-harness-adapter

# apt 走阿里源（避免 deb.debian.org 卡顿）
RUN sed -i 's/deb\.debian\.org/mirrors.aliyun.com/g; s/security\.debian\.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

# pnpm（供安装运行时依赖 + 启动时生成 acp profile）
RUN npm config set registry "${NPM_REGISTRY}" \
 && npm install -g pnpm@${PNPM_VERSION} \
 && pnpm config set registry "${NPM_REGISTRY}"

# DSH CLI
RUN npm install -g "@deepseek-ai/dsh@${DSH_VERSION}"

# 复制构建产物（保留相对层级，patch.ts 依赖 ../../profile、../../plugins）
COPY --from=build /src/deepseek-harness-adapter/package.json ./
COPY --from=build /src/deepseek-harness-adapter/pnpm-workspace.yaml ./
COPY --from=build /src/deepseek-harness-adapter/pnpm-lock.yaml ./
COPY --from=build /src/deepseek-harness-adapter/shared   shared
COPY --from=build /src/deepseek-harness-adapter/adapter  adapter
COPY --from=build /src/deepseek-harness-adapter/runtime  runtime
COPY --from=build /src/deepseek-harness-adapter/plugins  plugins
COPY --from=build /src/deepseek-harness-adapter/profile  profile

# 关键修复：安装运行时依赖（yaml、@huaweicloud/agentarts-sdk 等 + workspace 链接）
RUN pnpm install --frozen-lockfile --prod

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

VOLUME ["/opt/dsh-home", "/opt/agentrun", "/workspace"]

EXPOSE 18092
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]