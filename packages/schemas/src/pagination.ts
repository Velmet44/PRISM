import { z } from "zod";

export const CursorPagination = z.object({
  cursor: z.string().min(1).optional(),
  order: z.enum(["asc", "desc"]),
  limit: z.number().int().min(1).max(200),
});
export type CursorPagination = z.infer<typeof CursorPagination>;

export const SNAPSHOT_HEADER = "x-prism-snapshot";
