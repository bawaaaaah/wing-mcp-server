import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Wraps `server` so every `registerTool` call (and the deprecated `tool()` overload — it returns
 * the same `RegisteredTool` shape, so a module using it must not be a loophole around whatever
 * calls this) is reported to `onRegister` before its handle is returned.
 *
 * Deliberately a `Proxy` rather than a hand-typed facade: `registerTool`'s generic, heavily
 * overloaded signature (see the SDK's `mcp.d.ts`) is awkward to redeclare faithfully, and a facade
 * would have to enumerate every other member (`registerResource`, `registerPrompt`,
 * `sendToolListChanged`, …) to pass them through. Everything not intercepted here is forwarded to
 * the real server, `this`-bound to it, so calling through the proxy behaves identically to calling
 * the real server directly — including a plugin that registers resources on the same object.
 *
 * Meant to be thrown away once whatever registration pass it wrapped returns; it adds no ongoing
 * cost afterwards; nothing keeps a reference to the proxy itself.
 */
export function recordRegisteredTools(
  server: McpServer,
  onRegister: (name: string, tool: RegisteredTool) => void,
): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === "registerTool" || prop === "tool") {
        const original = Reflect.get(target, prop, target) as (...args: unknown[]) => RegisteredTool;
        return (...args: unknown[]): RegisteredTool => {
          const handle = original.apply(target, args);
          const name = args[0];
          if (typeof name === "string") onRegister(name, handle);
          return handle;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as McpServer;
}
