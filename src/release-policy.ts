export function mainGitDeploymentsAreDisabled(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rules = Object.entries(value as Record<string, unknown>);
  return rules.length === 1 && rules[0][0] === "main" && rules[0][1] === false;
}
