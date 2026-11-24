import { Fragment } from "react";
import { CopyButton } from "#/components/copy-button.tsx";
import type { McpClient, McpCode, McpSetup } from "#/features/mcp/mcp-clients.ts";

const CLIENT_KEY = "aperture.mcp.client";

/** The client that was set up last here: whoever comes back most likely has the same one. */
export const rememberedClient = (clients: ReadonlyArray<McpClient>, fallback: string) => {
  try {
    const kept = localStorage.getItem(CLIENT_KEY);
    return clients.some((client) => client.id === kept) && kept !== null ? kept : fallback;
  } catch {
    // A browser may keep nothing for a page.
    return fallback;
  }
};

export const rememberClient = (id: string) => {
  try {
    localStorage.setItem(CLIENT_KEY, id);
  } catch {
    // Remembered where the browser lets it be.
  }
};

/** What is done to set one client up, in order, with what is pasted where. */
export function McpSteps({ client, setup }: { client: McpClient; setup: McpSetup }) {
  return (
    <>
      {client.fields === undefined ? null : (
        <dl className="aperture:grid aperture:grid-cols-[auto_minmax(0,1fr)] aperture:items-center aperture:gap-x-4 aperture:gap-y-2">
          {client.fields(setup).map((field) => (
            <Fragment key={field.label}>
              <dt className="aperture:text-sm aperture:text-muted-foreground">{field.label}</dt>
              <dd className="aperture:flex aperture:min-w-0 aperture:items-center aperture:gap-1 aperture:rounded-md aperture:bg-muted aperture:py-1 aperture:pr-1 aperture:pl-2.5">
                <code
                  className="aperture:min-w-0 aperture:flex-1 aperture:truncate aperture:font-mono aperture:text-xs"
                  title={field.value}
                >
                  {field.value}
                </code>
                <CopyButton value={field.value} />
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      <ol className="aperture:flex aperture:flex-col aperture:gap-4">
        {client.steps(setup).map((step, index) => (
          <li key={index} className="aperture:flex aperture:min-w-0 aperture:gap-3">
            <span className="aperture:flex aperture:size-5 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:rounded-full aperture:bg-muted aperture:text-xs aperture:font-medium">
              {index + 1}
            </span>
            <div className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:gap-2">
              <p className="aperture:leading-5">{step.text}</p>
              {step.code === undefined ? null : <CodeBlock code={step.code} />}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

function CodeBlock({ code }: { code: McpCode }) {
  return (
    <div className="aperture:flex aperture:min-w-0 aperture:flex-col aperture:gap-1">
      {code.filename === undefined ? null : (
        <span className="aperture:font-mono aperture:text-xs aperture:text-muted-foreground">
          {code.filename}
        </span>
      )}
      <div className="aperture:relative aperture:min-w-0">
        <pre className="aperture:rounded-lg aperture:bg-muted aperture:p-3 aperture:pr-11 aperture:font-mono aperture:text-xs aperture:break-all aperture:whitespace-pre-wrap">
          <code>{code.value}</code>
        </pre>
        <CopyButton
          value={code.value}
          className="aperture:absolute aperture:top-1.5 aperture:right-1.5"
        />
      </div>
    </div>
  );
}

/** Where the server is, to read and to copy. */
export function McpEndpoint({ url }: { url: string }) {
  return (
    <div className="aperture:flex aperture:min-w-0 aperture:items-center aperture:gap-1 aperture:rounded-md aperture:bg-muted aperture:py-1 aperture:pr-1 aperture:pl-2.5">
      <code
        data-console-mcp-endpoint
        className="aperture:min-w-0 aperture:flex-1 aperture:truncate aperture:font-mono aperture:text-xs"
        title={url}
      >
        {url}
      </code>
      <CopyButton value={url} />
    </div>
  );
}
