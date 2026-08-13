/**
 * The package's canonical structural guards.
 *
 * These narrow only enough to safely probe an unknown value's fields; every
 * property stays `unknown`. Anything with a real contract should be narrowed on
 * a discriminant instead.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow a frame by its `type` discriminant without asserting the rest. */
export function frameType(value: unknown): string | undefined {
	return isRecord(value) && typeof value.type === "string" ? value.type : undefined;
}
