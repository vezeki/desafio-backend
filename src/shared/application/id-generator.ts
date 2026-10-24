import { v7 as uuidv7 } from "uuid";

export interface IdGenerator {
  next(): string;
}

export const ID_GENERATOR = Symbol("IdGenerator");

/** UUID v7: time-ordered, so new rows land at the end of B-tree indexes. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return uuidv7();
  }
}
