/** What a client is set up with: where the session's MCP server is, and what lets it in. */
export type McpSetup = {
  readonly url: string;
  /** The API token to put in, where one was just made; a placeholder stands in without. */
  readonly token: string | undefined;
};

export type McpSnippet = {
  readonly label: string;
  readonly value: string;
};

export type McpClient = {
  readonly id: string;
  readonly name: string;
  readonly snippets: (setup: McpSetup) => ReadonlyArray<McpSnippet>;
};

const NAME = "aperture";

const header = (setup: McpSetup) => `Bearer ${setup.token ?? "<API token>"}`;

const quoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const json = (value: unknown) => JSON.stringify(value, null, 2);

export const mcpClients: ReadonlyArray<McpClient> = [
  {
    id: "claude-code",
    name: "Claude Code",
    snippets: (setup) => [
      {
        label: "Run in a terminal",
        value: `claude mcp add --transport http ${NAME} ${quoted(setup.url)} \\\n  --header ${quoted(`Authorization: ${header(setup)}`)}`,
      },
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    snippets: (setup) => [
      {
        label: "~/.cursor/mcp.json",
        value: json({
          mcpServers: { [NAME]: { url: setup.url, headers: { Authorization: header(setup) } } },
        }),
      },
    ],
  },
  {
    id: "vscode",
    name: "VS Code",
    snippets: (setup) => [
      {
        label: ".vscode/mcp.json",
        value: json({
          servers: {
            [NAME]: { type: "http", url: setup.url, headers: { Authorization: header(setup) } },
          },
        }),
      },
    ],
  },
  {
    id: "generic",
    name: "Other",
    snippets: (setup) => [
      { label: "URL", value: setup.url },
      { label: "Transport", value: "Streamable HTTP" },
      { label: "Header", value: `Authorization: ${header(setup)}` },
    ],
  },
];
