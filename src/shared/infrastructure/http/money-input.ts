import { z } from "zod";

/** Shape only; the amount format and currency are validated by Money, the single source of those rules. */
export const MoneyInput = z.object({ amount: z.string(), currency: z.string() });
