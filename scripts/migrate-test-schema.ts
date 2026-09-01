import { createIsolatedTestDatabase } from "../tests/support/test-database.js";

const testDatabase = await createIsolatedTestDatabase();
try {
  console.log(`Migrated isolated test schema: ${testDatabase.schemaName}`);
} finally {
  await testDatabase.cleanup();
}
