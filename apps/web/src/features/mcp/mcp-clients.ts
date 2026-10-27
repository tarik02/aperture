export type McpAuthMode = "oauth" | "token";

export type McpSetupInput = {
  /** Full MCP endpoint URL, including any `browserTools` query. */
  url: string;
  auth: McpAuthMode;
  /** Real token to embed literally; `null` uses the `APERTURE_TOKEN` env var instead. */
  token: string | null;
  /** Server name registered in the client, e.g. `aperture`. */
  serverName: string;
};

export type McpCodeBlock = {
  language: "bash" | "json" | "toml";
  value: string;
  filename?: string;
};

export type McpSetupStep = {
  text: string;
  code?: McpCodeBlock;
};

export type McpField = { label: string; value: string };

export type McpClient = {
  id: string;
  name: string;
  description: string;
  steps: (input: McpSetupInput) => McpSetupStep[];
  /** Values to paste into a client by hand, shown instead of steps when present. */
  fields?: (input: McpSetupInput) => McpField[];
};

export const MCP_TOKEN_ENV = "APERTURE_TOKEN";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function exportStep(input: McpSetupInput): McpSetupStep[] {
  if (input.auth !== "token") {
    return [];
  }
  return [
    {
      text:
        input.token === null
          ? "Export your Aperture API token in the shell that starts the client."
          : "Export the token in the shell that starts the client.",
      code: {
        language: "bash",
        value: `export ${MCP_TOKEN_ENV}=${input.token === null ? "apt_..." : shellQuote(input.token)}`,
      },
    },
  ];
}

/** Steps that only need the env var when no literal token is embedded. */
function envExportStep(input: McpSetupInput): McpSetupStep[] {
  return input.token === null ? exportStep(input) : [];
}

export function mcpOAuthDiscoveryUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}/.well-known/oauth-protected-resource${parsed.pathname}`;
}

const claudeCode: McpClient = {
  id: "claude-code",
  name: "Claude Code",
  description: "Terminal coding agent",
  steps: (input) => {
    const add = `claude mcp add --transport http ${input.serverName} ${shellQuote(input.url)}`;
    if (input.auth === "oauth") {
      return [
        { text: "Add the server.", code: { language: "bash", value: add } },
        {
          text: `Start Claude Code, run /mcp, pick ${input.serverName} and sign in to Aperture in the browser.`,
        },
      ];
    }
    const header =
      input.token === null
        ? `"Authorization: Bearer $${MCP_TOKEN_ENV}"`
        : shellQuote(`Authorization: Bearer ${input.token}`);
    return [
      ...envExportStep(input),
      {
        text: "Add the server with the token header.",
        code: { language: "bash", value: `${add} \\\n  --header ${header}` },
      },
      { text: `Run /mcp inside Claude Code to check that ${input.serverName} is connected.` },
    ];
  },
};

const claudeApps: McpClient = {
  id: "claude-desktop",
  name: "Claude Desktop",
  description: "Desktop app and claude.ai",
  steps: (input) => {
    if (input.auth !== "oauth") {
      return [
        {
          text: "Custom connectors in Claude Desktop and claude.ai sign in with OAuth and cannot send an API token. Use Claude Code or the generic setup instead.",
        },
      ];
    }
    return [
      { text: "Open Settings → Connectors and choose Add custom connector." },
      {
        text: "Name it Aperture and paste the server URL.",
        code: { language: "bash", value: input.url },
      },
      { text: "Choose Connect and approve access on the Aperture consent page." },
    ];
  },
};

const codex: McpClient = {
  id: "codex",
  name: "Codex",
  description: "CLI and IDE extension",
  steps: (input) => {
    const name = input.serverName;
    if (input.auth === "oauth") {
      return [
        {
          text: "Add the server.",
          code: { language: "bash", value: `codex mcp add ${name} --url ${shellQuote(input.url)}` },
        },
        {
          text: "Or add it to the config file instead.",
          code: {
            language: "toml",
            filename: "~/.codex/config.toml",
            value: `[mcp_servers.${name}]\nurl = ${tomlString(input.url)}\n`,
          },
        },
        {
          text: "Sign in to Aperture.",
          code: { language: "bash", value: `codex mcp login ${name}` },
        },
      ];
    }
    // Codex reads bearer tokens from an env var only, so a literal token goes into the export.
    return [
      ...exportStep(input),
      {
        text: "Add the server.",
        code: {
          language: "bash",
          value: `codex mcp add ${name} --url ${shellQuote(input.url)} \\\n  --bearer-token-env-var ${MCP_TOKEN_ENV}`,
        },
      },
      {
        text: "Or add it to the config file instead.",
        code: {
          language: "toml",
          filename: "~/.codex/config.toml",
          value: `[mcp_servers.${name}]\nurl = ${tomlString(input.url)}\nbearer_token_env_var = ${tomlString(MCP_TOKEN_ENV)}\n`,
        },
      },
    ];
  },
};

const cursor: McpClient = {
  id: "cursor",
  name: "Cursor",
  description: "AI code editor",
  steps: (input) => {
    const server: Record<string, unknown> = { url: input.url };
    if (input.auth === "token") {
      server.headers = {
        Authorization: `Bearer ${input.token ?? `\${env:${MCP_TOKEN_ENV}}`}`,
      };
    }
    return [
      ...envExportStep(input),
      {
        text: "Add the server to your Cursor MCP config.",
        code: {
          language: "json",
          filename: "~/.cursor/mcp.json",
          value: json({ mcpServers: { [input.serverName]: server } }),
        },
      },
      input.auth === "oauth"
        ? {
            text: `Open Cursor Settings → MCP, choose Connect next to ${input.serverName} and sign in to Aperture.`,
          }
        : { text: `Open Cursor Settings → MCP and check that ${input.serverName} is enabled.` },
    ];
  },
};

const vscode: McpClient = {
  id: "vscode",
  name: "VS Code",
  description: "GitHub Copilot agent mode",
  steps: (input) => {
    const server: Record<string, unknown> = { type: "http", url: input.url };
    const config: Record<string, unknown> = { servers: { [input.serverName]: server } };
    if (input.auth === "token") {
      server.headers = {
        Authorization: `Bearer ${input.token ?? "${input:aperture-token}"}`,
      };
      if (input.token === null) {
        config.inputs = [
          {
            type: "promptString",
            id: "aperture-token",
            description: "Aperture API token",
            password: true,
          },
        ];
      }
    }
    return [
      {
        text: "Add the server to your workspace MCP config.",
        code: { language: "json", filename: ".vscode/mcp.json", value: json(config) },
      },
      input.auth === "oauth"
        ? { text: "Choose Start above the server entry and allow VS Code to sign in to Aperture." }
        : input.token === null
          ? { text: "Choose Start above the server entry and paste your API token when asked." }
          : { text: "Choose Start above the server entry." },
      { text: "Open Copilot Chat in agent mode; the Aperture tools appear in the tools picker." },
    ];
  },
};

const gemini: McpClient = {
  id: "gemini-cli",
  name: "Gemini CLI",
  description: "Terminal agent",
  steps: (input) => {
    const server: Record<string, unknown> = { httpUrl: input.url };
    if (input.auth === "token") {
      server.headers = {
        Authorization: `Bearer ${input.token ?? `\${${MCP_TOKEN_ENV}}`}`,
      };
    }
    return [
      ...envExportStep(input),
      {
        text: "Add the server to your Gemini CLI settings.",
        code: {
          language: "json",
          filename: "~/.gemini/settings.json",
          value: json({ mcpServers: { [input.serverName]: server } }),
        },
      },
      input.auth === "oauth"
        ? { text: `Start Gemini CLI and run /mcp auth ${input.serverName} to sign in.` }
        : { text: "Start Gemini CLI and run /mcp to check the connection." },
    ];
  },
};

const generic: McpClient = {
  id: "generic",
  name: "Other clients",
  description: "Any client that speaks Streamable HTTP",
  steps: () => [],
  fields: (input) => [
    { label: "Name", value: input.serverName },
    { label: "Transport", value: "Streamable HTTP" },
    { label: "URL", value: input.url },
    ...(input.auth === "oauth"
      ? [{ label: "OAuth discovery", value: mcpOAuthDiscoveryUrl(input.url) }]
      : [{ label: "Header", value: `Authorization: Bearer ${input.token ?? "<API token>"}` }]),
  ],
};

export const mcpClients: readonly McpClient[] = [
  claudeCode,
  claudeApps,
  codex,
  cursor,
  vscode,
  gemini,
  generic,
];

export const DEFAULT_MCP_CLIENT_ID = claudeCode.id;
