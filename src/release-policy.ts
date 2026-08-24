export function mainGitDeploymentsAreDisabled(value: unknown): boolean {
  return !mainGitDeploymentsAreEnabled(value);
}

export function mainGitDeploymentsAreEnabled(value: unknown): boolean {
  if (value === undefined || value === true) return true;
  if (value === false || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const rules = Object.entries(value as Record<string, unknown>);
  if (!rules.length) return true;

  // Vercel enables an unspecified branch by default and lets a matching true
  // rule override matching false rules. We support the only broad rule this
  // repository permits (`*`) and fail closed on other glob-shaped rules.
  if (rules.some(([pattern, enabled]) => (pattern === "main" || pattern === "*") && enabled === true)) return true;
  if (rules.some(([pattern, enabled]) => (pattern === "main" || pattern === "*") && enabled === false)) return false;
  return rules.every(([pattern, enabled]) => /^[A-Za-z0-9._/-]+$/.test(pattern) && typeof enabled === "boolean");
}

export function verifiedProductionDomainNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const domain = entry as Record<string, unknown>;
    const name = typeof domain.name === "string" ? domain.name.trim().toLowerCase() : "";
    const gitBranch = typeof domain.gitBranch === "string" ? domain.gitBranch.trim() : "";
    const customEnvironmentId = typeof domain.customEnvironmentId === "string" ? domain.customEnvironmentId.trim() : "";
    return name && domain.verified === true && !gitBranch && !customEnvironmentId ? [name] : [];
  }))].sort();
}
