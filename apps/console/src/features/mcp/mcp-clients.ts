/** What a client is set up with: where the MCP server is, and what lets it in. */
export type McpSetup = {
  readonly url: string;
  /**
   * How the client is let in: by signing in, where the server is the control plane's and
   * the client asks for a grant itself, or with an API token it is given.
   */
  readonly auth: "oauth" | "token";
  /** The API token to put in, where one was just made; an environment variable stands in without. */
  readonly token: string | undefined;
  /** What the client calls the server. */
  readonly name: string;
};

export type McpCode = {
  readonly value: string;
  readonly filename?: string;
};

export type McpStep = {
  readonly text: string;
  readonly code?: McpCode;
};

export type McpField = { readonly label: string; readonly value: string };

export type McpClient = {
  readonly id: string;
  readonly name: string;
  readonly steps: (setup: McpSetup) => ReadonlyArray<McpStep>;
  /** What is pasted into a client by hand, shown above the steps. */
  readonly fields?: (setup: McpSetup) => ReadonlyArray<McpField>;
};

export const MCP_TOKEN_ENV = "APERTURE_TOKEN";

const quoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** The step that puts the token where the shell that starts the client finds it. */
const exported = (setup: McpSetup): McpStep => ({
  text:
    setup.token === undefined
      ? "Export an Aperture API token in the shell that starts the client."
      : "Export the token in the shell that starts the client.",
  code: {
    value: `export ${MCP_TOKEN_ENV}=${setup.token === undefined ? "apc_..." : quoted(setup.token)}`,
  },
});

/** For a client that takes the token itself, which then needs none exported. */
const exportedWithout = (setup: McpSetup) => (setup.token === undefined ? [exported(setup)] : []);

/** The last step of signing in: the browser opens here, and the person says what the client gets. */
const DECIDE = "Your browser opens here: choose what it may do, and connect it.";

const claudeCode: McpClient = {
  id: "claude-code",
  name: "Claude Code",
  steps: (setup) =>
    setup.auth === "oauth"
      ? [
          {
            text: "Add the server.",
            code: { value: `claude mcp add --transport http ${setup.name} ${quoted(setup.url)}` },
          },
          { text: `Run /mcp inside Claude Code, choose ${setup.name}, and authenticate.` },
          { text: DECIDE },
        ]
      : [
          ...exportedWithout(setup),
          {
            text: "Add the server with the token header.",
            code: {
              value: `claude mcp add --transport http ${setup.name} ${quoted(setup.url)} \\\n  --header ${
                setup.token === undefined
                  ? `"Authorization: Bearer $${MCP_TOKEN_ENV}"`
                  : quoted(`Authorization: Bearer ${setup.token}`)
              }`,
            },
          },
          { text: `Run /mcp inside Claude Code to check that ${setup.name} is connected.` },
        ],
};

const claudeDesktop: McpClient = {
  id: "claude-desktop",
  name: "Claude Desktop",
  steps: (setup) =>
    setup.auth === "oauth"
      ? [
          {
            text: "In Claude Desktop or claude.ai, open Settings → Connectors and add a custom connector with this address.",
            code: { value: setup.url },
          },
          { text: "Choose Connect on the new connector." },
          { text: DECIDE },
        ]
      : [
          {
            text: "Custom connectors in Claude Desktop and claude.ai sign in and cannot send an API token. Sign in instead, or use another client.",
          },
        ],
};

const codex: McpClient = {
  id: "codex",
  name: "Codex",
  steps: (setup) =>
    setup.auth === "oauth"
      ? [
          {
            text: "Add the server.",
            code: { value: `codex mcp add ${setup.name} --url ${quoted(setup.url)}` },
          },
          { text: "Sign in to it.", code: { value: `codex mcp login ${setup.name}` } },
          { text: DECIDE },
        ]
      : [
          // Codex reads a bearer token from the environment only, so the token is always exported.
          exported(setup),
          {
            text: "Add the server.",
            code: {
              value: `codex mcp add ${setup.name} --url ${quoted(setup.url)} \\\n  --bearer-token-env-var ${MCP_TOKEN_ENV}`,
            },
          },
          {
            text: "Or add it to the config file instead.",
            code: {
              filename: "~/.codex/config.toml",
              value: `[mcp_servers.${setup.name}]\nurl = ${JSON.stringify(setup.url)}\nbearer_token_env_var = ${JSON.stringify(MCP_TOKEN_ENV)}\n`,
            },
          },
        ],
};

const cursor: McpClient = {
  id: "cursor",
  name: "Cursor",
  steps: (setup) => [
    ...(setup.auth === "oauth" ? [] : exportedWithout(setup)),
    {
      text: "Add the server to your Cursor MCP config.",
      code: {
        filename: "~/.cursor/mcp.json",
        value: json({
          mcpServers: {
            [setup.name]: {
              url: setup.url,
              ...(setup.auth === "oauth"
                ? {}
                : {
                    headers: {
                      Authorization: `Bearer ${setup.token ?? `\${env:${MCP_TOKEN_ENV}}`}`,
                    },
                  }),
            },
          },
        }),
      },
    },
    ...(setup.auth === "oauth"
      ? [
          { text: `Open Cursor Settings → MCP and choose to sign in next to ${setup.name}.` },
          { text: DECIDE },
        ]
      : [{ text: `Open Cursor Settings → MCP and check that ${setup.name} is enabled.` }]),
  ],
};

const vscode: McpClient = {
  id: "vscode",
  name: "VS Code",
  steps: (setup) => {
    const asked = setup.auth === "token" && setup.token === undefined;
    return [
      {
        text: "Add the server to your workspace MCP config.",
        code: {
          filename: ".vscode/mcp.json",
          value: json({
            servers: {
              [setup.name]: {
                type: "http",
                url: setup.url,
                ...(setup.auth === "oauth"
                  ? {}
                  : {
                      headers: {
                        Authorization: `Bearer ${setup.token ?? "${input:aperture-token}"}`,
                      },
                    }),
              },
            },
            ...(asked
              ? {
                  inputs: [
                    {
                      type: "promptString",
                      id: "aperture-token",
                      description: "Aperture API token",
                      password: true,
                    },
                  ],
                }
              : {}),
          }),
        },
      },
      {
        text: asked
          ? "Choose Start above the server entry and paste your API token when asked."
          : "Choose Start above the server entry.",
      },
      ...(setup.auth === "oauth" ? [{ text: `Allow VS Code to sign in. ${DECIDE}` }] : []),
      { text: "Open Copilot Chat in agent mode; the Aperture tools appear in the tools picker." },
    ];
  },
};

const gemini: McpClient = {
  id: "gemini-cli",
  name: "Gemini CLI",
  steps: (setup) => [
    ...(setup.auth === "oauth" ? [] : exportedWithout(setup)),
    {
      text: "Add the server to your Gemini CLI settings.",
      code: {
        filename: "~/.gemini/settings.json",
        value: json({
          mcpServers: {
            [setup.name]: {
              httpUrl: setup.url,
              ...(setup.auth === "oauth"
                ? {}
                : {
                    headers: { Authorization: `Bearer ${setup.token ?? `\${${MCP_TOKEN_ENV}}`}` },
                  }),
            },
          },
        }),
      },
    },
    ...(setup.auth === "oauth"
      ? [
          { text: "Start Gemini CLI and sign in.", code: { value: `/mcp auth ${setup.name}` } },
          { text: DECIDE },
        ]
      : [{ text: "Start Gemini CLI and run /mcp to check the connection." }]),
  ],
};

const other: McpClient = {
  id: "generic",
  name: "Other clients",
  steps: () => [],
  fields: (setup) => [
    { label: "Name", value: setup.name },
    { label: "Transport", value: "Streamable HTTP" },
    { label: "URL", value: setup.url },
    setup.auth === "oauth"
      ? { label: "Authorization", value: "OAuth, as the server tells it" }
      : { label: "Header", value: `Authorization: Bearer ${setup.token ?? "<API token>"}` },
  ],
};

export const mcpClients: ReadonlyArray<McpClient> = [
  claudeCode,
  claudeDesktop,
  codex,
  cursor,
  vscode,
  gemini,
  other,
];

export const DEFAULT_MCP_CLIENT = claudeCode.id;
