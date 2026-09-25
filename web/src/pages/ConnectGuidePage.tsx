import { useState, type JSX } from "react";
import { useAuthKind } from "../api/queries.js";
import { getToken } from "../auth/token-store.js";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail (permissions, non-secure context) — the text is still selectable
      // in the code block itself, so there's nothing more useful to do here than stay silent.
    }
  }

  return (
    <button type="button" className="copy-button" onClick={() => void copy()}>
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

/** `display` (defaults to `code`) is what's rendered on screen; `code` is always what gets copied —
 * this split lets a code block show a masked token while still copying the real one, matching the
 * "Access token" row's own reveal/copy split above. */
function CodeBlock({ code, display }: { code: string; display?: string }) {
  return (
    <div className="code-block">
      <pre>
        <code>{display ?? code}</code>
      </pre>
      <CopyButton text={code} />
    </div>
  );
}

/**
 * The snippets carry the server's auth token only when this browser already holds it — i.e. signed
 * in with it. A browser signed in with a passkey holds a web session token instead, which /mcp does
 * not accept, and the server deliberately never hands the master token to a session: the snippets
 * then show a placeholder and say where to read the real one. Masked by default as a
 * shoulder-surfing/screen-share safeguard.
 */
const TOKEN_PLACEHOLDER = "YOUR_TOKEN";

export function ConnectGuidePage(): JSX.Element {
  const authKind = useAuthKind().data?.kind;
  const token = authKind === "static" ? (getToken() ?? TOKEN_PLACEHOLDER) : TOKEN_PLACEHOLDER;
  const hasToken = token !== TOKEN_PLACEHOLDER;
  const [revealed, setRevealed] = useState(false);
  const mcpOrigin = window.location.origin;
  const mcpUrl = `${mcpOrigin}/mcp`;
  const maskedToken = hasToken ? "•".repeat(Math.min(token.length, 24) || 24) : TOKEN_PLACEHOLDER;

  const displayToken = revealed || !hasToken ? token : maskedToken;
  const claudeCodeCmd = `claude mcp add --transport http --header "Authorization: Bearer ${token}" wing ${mcpUrl}`;
  const claudeCodeCmdDisplay = `claude mcp add --transport http --header "Authorization: Bearer ${displayToken}" wing ${mcpUrl}`;
  const hermesYaml = `mcp_servers:\n  wing:\n    url: "${mcpUrl}"\n    headers:\n      Authorization: "Bearer ${token}"`;
  const hermesYamlDisplay = `mcp_servers:\n  wing:\n    url: "${mcpUrl}"\n    headers:\n      Authorization: "Bearer ${displayToken}"`;
  const inspectorCmd = "npx @modelcontextprotocol/inspector";
  const curlCmd = `curl -X POST "${mcpUrl}" \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;
  const curlCmdDisplay = `curl -X POST "${mcpUrl}" \\\n  -H "Authorization: Bearer ${displayToken}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;
  const stdioClaudeCodeCmd =
    "claude mcp add wing -- npx -y @bawaaaaah/wing-mcp-server --stdio --no-http --config /absolute/path/to/config.json";
  const stdioJson = [
    "{",
    '  "mcpServers": {',
    '    "wing": {',
    '      "command": "npx",',
    '      "args": [',
    '        "-y", "@bawaaaaah/wing-mcp-server",',
    '        "--stdio", "--no-http",',
    '        "--config", "/absolute/path/to/config.json"',
    "      ]",
    "    }",
    "  }",
    "}",
  ].join("\n");

  return (
    <div className="page">
      <h2>Connect an MCP client</h2>
      <p>
        This server speaks standard MCP (Model Context Protocol) over Streamable HTTP. Any MCP-compatible client can
        control the Wing console through it once it has the endpoint URL and access token below — or, if your client
        is on the same machine as the console, it can skip the network entirely and run its own copy over stdio; see
        the card below for that.
      </p>

      <section className="card">
        <h3>Your connection details</h3>
        <dl className="kv-list">
          <dt>Endpoint URL</dt>
          <dd>
            <code>{mcpUrl}</code> <CopyButton text={mcpUrl} />
          </dd>
          <dt>Access token</dt>
          <dd>
            {hasToken ? (
              <>
                <code>{revealed ? token : maskedToken}</code>{" "}
                <button type="button" className="mixer-mute" onClick={() => setRevealed((r) => !r)}>
                  {revealed ? "Hide" : "Reveal"}
                </button>{" "}
                <CopyButton text={token} />
              </>
            ) : (
              <>
                You signed in with a passkey, so this browser never received the server's auth token. Read it on the
                server with <code>wing-mcp-server --print-token</code> (under Docker,{" "}
                <code>docker exec &lt;container&gt; node dist/cli.js --print-token</code>) — the snippets below show{" "}
                <code>{TOKEN_PLACEHOLDER}</code> in its place.
              </>
            )}
          </dd>
        </dl>
        <p className="meters-status">
          Every request to this endpoint needs an <code>Authorization: Bearer &lt;token&gt;</code> header — there's no
          query-param fallback for <code>/mcp</code> itself. Clients that only support OAuth (like claude.ai below)
          can connect too: their login flow asks for this token (or one of your passkeys) once, then the client
          receives tokens of its own — never this one — which you can revoke from the Overview page.
        </p>
      </section>

      <section className="card">
        <h3>Run it locally instead (stdio)</h3>
        <p>
          Everything above connects to <em>this</em> running server over the network. If your MCP client and the
          console are reachable from the same machine, it can spawn its own copy of the server over stdio instead —
          no endpoint URL or token to copy, since the client owns the process. Point <code>--config</code> at an
          absolute path: the client picks the working directory, not you, so the server's usual{" "}
          <code>./data/config.json</code> can land somewhere unexpected.
        </p>
        <CodeBlock code={stdioClaudeCodeCmd} />
        <p>Or, for a client configured by JSON (Claude Desktop, Witsy's importer, and most others):</p>
        <CodeBlock code={stdioJson} />
        <p className="meters-status">
          HTTP stays on by default even with <code>--stdio</code> — this dashboard is still reachable for as long as
          that client session runs — so add <code>--no-http</code> as above unless you want both. Either way, the
          server's lifetime becomes that client's session: closing it ends the process. See{" "}
          <a
            href="https://github.com/bawaaaaah/wing-mcp-server/blob/main/docs/install-npm.md#connecting-an-mcp-client"
            target="_blank"
            rel="noreferrer"
          >
            the npm install guide
          </a>{" "}
          for more.
        </p>
      </section>

      <section className="card">
        <h3>Claude Code (CLI)</h3>
        <p>Run once, from any directory:</p>
        <CodeBlock code={claudeCodeCmd} display={claudeCodeCmdDisplay} />
        <p className="meters-status">
          Add <code>--scope user</code> to make it available in every project instead of just the current one. Check{" "}
          <code>claude mcp add --help</code> if this flag set doesn't match your installed CLI version. Verify with{" "}
          <code>claude mcp list</code>.
        </p>
      </section>

      <section className="card">
        <h3>Claude Desktop</h3>
        <ol>
          <li>
            Open <strong>Settings → Connectors → Add custom connector</strong>.
          </li>
          <li>Paste the endpoint URL above.</li>
          <li>
            In the <strong>Request headers</strong> section, add a header named <code>Authorization</code> with value{" "}
            <code>Bearer {displayToken}</code>.
          </li>
        </ol>
        <p className="meters-status">Custom request headers for remote connectors are a newer Claude Desktop feature — if you don't see that section, update the app.</p>
      </section>

      <section className="card">
        <h3>Witsy</h3>
        <ol>
          <li>
            Open <strong>Connectors</strong> from the app's menu bar, then click <strong>Add MCP server…</strong>.
          </li>
          <li>
            Set <strong>Type</strong> to <strong>Streamable HTTP</strong> and paste the endpoint URL above.
          </li>
          <li>
            In the <strong>Custom HTTP Headers</strong> table that appears, add a row: key <code>Authorization</code>,
            value <code>Bearer {displayToken}</code>.
          </li>
          <li>Save.</li>
        </ol>
        <p className="meters-status">
          Witsy's "Import from JSON" button only accepts local stdio-style entries (<code>command</code>/<code>args</code>) —
          add the header through the key/value table above, not that importer.
        </p>
      </section>

      <section className="card">
        <h3>Hermes (Nous Research)</h3>
        <p>
          Add an entry under <code>mcp_servers</code> in <code>~/.hermes/config.yaml</code>:
        </p>
        <CodeBlock code={hermesYaml} display={hermesYamlDisplay} />
        <p className="meters-status">
          Then run <code>/reload-mcp</code> in an active chat session (or restart Hermes) to pick it up. The CLI, TUI,
          and desktop app all read this same config file.
        </p>
      </section>

      <section className="card">
        <h3>claude.ai (web)</h3>
        <p>
          claude.ai's remote connectors only support OAuth, not custom headers — this server speaks OAuth too. You
          approve claude.ai once; it then holds its own revocable tokens (listed on the Overview page).
        </p>
        <ol>
          <li>
            Open <strong>Settings → Connectors → Add custom connector</strong>.
          </li>
          <li>Give it a name and paste the endpoint URL above; leave everything else blank and submit.</li>
          <li>
            claude.ai should register itself automatically and open an approval page on this server. Approve with
            one of your passkeys, or paste your access token there and confirm — that's the only place the token
            needs to be entered.
          </li>
        </ol>
        <p className="meters-status">
          If claude.ai instead shows a form asking for OAuth app credentials up front (client ID/secret,
          authorization/token endpoints), that means it couldn't reach this server's automatic registration — check
          that <code>PUBLIC_URL</code> is set to this server's real public HTTPS address and reachable from the
          internet, not just this browser. If it still needs manual values: authorization endpoint{" "}
          <code>{mcpOrigin}/authorize</code>, token endpoint <code>{mcpOrigin}/token</code>, scopes blank, token
          endpoint auth method <code>none</code>. A client ID/secret can't be filled in ahead of time here since it's
          normally issued automatically during registration — ask if you get stuck on that field specifically.
        </p>
      </section>

      <section className="card">
        <h3>MCP Inspector (for testing/debugging)</h3>
        <CodeBlock code={inspectorCmd} />
        <p>
          In the Inspector's UI, choose transport <strong>Streamable HTTP</strong>, paste the endpoint URL, and add
          the same <code>Authorization</code> header as above.
        </p>
      </section>

      <section className="card">
        <h3>Raw HTTP</h3>
        <p>For scripting or any client without built-in MCP support:</p>
        <CodeBlock code={curlCmd} display={curlCmdDisplay} />
      </section>
    </div>
  );
}
