import type { InitialProjectInput, ProjectIdea } from "./types";

const MAX_IDEA_TEXT = 64_000;

/** Idea text is source material: validation must never trim or reinterpret it. */
export function normalizeProjectIdea(value: unknown): ProjectIdea {
  const input = record(value, "Project Idea");
  const originalInput = ideaText(input.originalInput, "Idea original input", true);
  return {
    originalInput,
    brief: ideaText(input.brief ?? "", "Idea brief"),
    completionCriteria: ideaText(input.completionCriteria ?? "", "Idea completion criteria")
  };
}

export function normalizeInitialProject(value: unknown): InitialProjectInput {
  const input = record(value, "Initial Project");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 200) fail("Initial Project name must contain 1 to 200 characters.");
  return { name: input.name.trim(), idea: normalizeProjectIdea(input.idea) };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function ideaText(value: unknown, label: string, required = false): string {
  if (typeof value !== "string" || value.length > MAX_IDEA_TEXT || (required && !value.trim())) fail(`${label} must be ${required ? "nonempty text" : "text"} of at most ${MAX_IDEA_TEXT} characters.`);
  return value;
}
function fail(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }
