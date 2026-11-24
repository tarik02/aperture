import { Api } from "@aperture-browser/control-api";
import { createFileRoute } from "@tanstack/react-router";
import * as OpenApi from "effect/http-api/OpenApi";

export const Route = createFileRoute("/openapi.json")({
  server: {
    handlers: {
      // The document the control plane serves at `/api/control/openapi.json`, made as it makes it.
      GET: () => Response.json(OpenApi.fromApi(Api)),
    },
  },
});
