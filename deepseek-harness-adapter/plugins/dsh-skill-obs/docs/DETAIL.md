# dsh-skill-obs — OBS skill downloader

## 用途

在容器启动阶段，将 `agent_metadata.skills` 声明的技能包从 OBS 全量拉取到 SFS 挂载目录，并在首个模型调用前完成解压与 frontmatter 修复。

## 时序

- apply 阶段启动下载（异步，不阻塞 DSH 挂载）；
- `agent/pre-step` 等待下载完成，保证模型调用前目录就绪；
- `skill-filesystem.customSkillDirs` 通过 `!!js` 静态指向挂载目录。

## 输入

- `agent_metadata.skills`：`skillId:skillName:skillVer` 逗号分隔列表；
- `agent_metadata.user_bucket`：OBS 桶名；
- `AGENTRUN_SKILLS_DIR`：挂载目录（默认 `/home/agentarts/skills`）；
- `HUAWEICLOUD_SDK_AK` / `HUAWEICLOUD_SDK_SK` / `HUAWEICLOUD_SDK_SECURITY_TOKEN`：OBS 签名凭证。

## 输出

`{ mountDir, dirs, items: [{ id, name, ok, dir, fixed, error }], warnings }`。
