-- A user's own copy of a shared default category. The default stays for
-- everyone else; for this user it is hidden and the copy is used instead.
-- Additive: no existing rows change.
CREATE TABLE "category_overrides" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "default_category_id" uuid NOT NULL REFERENCES "categories"("id") ON DELETE CASCADE,
  "category_id" uuid NOT NULL REFERENCES "categories"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "default_category_id")
);

CREATE UNIQUE INDEX "category_overrides_category_uniq"
  ON "category_overrides" ("category_id");
