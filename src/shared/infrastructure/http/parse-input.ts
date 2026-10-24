import type { z } from "zod";
import { InvalidInputError } from "../../application/errors.ts";

/** Validates input at the HTTP boundary; any failure becomes a 400 with every issue listed. */
export function parseInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InvalidInputError(
      "invalid request",
      result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  return result.data;
}
