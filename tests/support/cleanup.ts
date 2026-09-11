/** Runs ordered teardown without allowing one failure to skip later actions. */
export async function runCleanupActions(
  actions: readonly (() => void | Promise<void>)[],
  message: string,
): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error: unknown) {
      failures.push(error);
    }
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, message, { cause: failures[0] });
  }
}
