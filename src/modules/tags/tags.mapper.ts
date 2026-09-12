import type { TagDto } from "./tags.schemas.js";
import type { TagRow } from "./tags.repository.js";

/** Converts a persistence row to the tag wire DTO. */
export function toTagDto(row: TagRow): TagDto {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.createdAt.toISOString(),
  };
}
