/** 部署前环境检查（占位实现：校验 Node 主版本）。 */
export function checkNodeVersion(version: string = process.version): {
  ok: boolean;
  message: string;
} {
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  const ok = major >= 20;
  return {
    ok,
    message: ok ? `Node ${version} 满足 >= 20 要求` : `Node ${version} 过旧，需要 >= 20`,
  };
}
