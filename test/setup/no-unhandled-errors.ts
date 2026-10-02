/**
 * Mocha root hooks: any unhandled promise rejection or uncaught exception during a test fails that
 * test, instead of being logged and forgotten (or crashing the run far from its cause). The server
 * runs next to the console's OSC and meter clients, where either would take control of the console
 * down with it.
 */
const pending: unknown[] = [];
const record = (err: unknown): void => {
  pending.push(err);
};

export const mochaHooks = {
  beforeAll(): void {
    process.on("unhandledRejection", record);
    process.on("uncaughtException", record);
  },
  afterEach(): void {
    if (pending.length === 0) return;
    const errors = pending.splice(0);
    const detail = errors.map((err) => (err instanceof Error ? (err.stack ?? err.message) : String(err))).join("\n---\n");
    throw new Error(`${errors.length} unhandled rejection(s)/exception(s) during this test:\n${detail}`);
  },
  afterAll(): void {
    process.off("unhandledRejection", record);
    process.off("uncaughtException", record);
  },
};
