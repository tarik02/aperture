import { cn } from "@aperture-browser/ui/utils";
import { IdCard, KeyRound } from "lucide-react";
import auth0 from "#/features/provider/marks/auth0.svg";
import authelia from "#/features/provider/marks/authelia.svg";
import authentik from "#/features/provider/marks/authentik.svg";
import dex from "#/features/provider/marks/dex.svg";
import github from "#/features/provider/marks/github.svg";
import gitlab from "#/features/provider/marks/gitlab.svg";
import google from "#/features/provider/marks/google.svg";
import kanidm from "#/features/provider/marks/kanidm.svg";
import keycloak from "#/features/provider/marks/keycloak.svg";
import microsoft from "#/features/provider/marks/microsoft.svg";
import okta from "#/features/provider/marks/okta.svg";
import pocketId from "#/features/provider/marks/pocket-id.svg";
import zitadel from "#/features/provider/marks/zitadel.svg";

/**
 * The marks that are drawn, by what a provider says its own is: the id of what is known
 * of it. Where each is from is told beside the files.
 */
const MARKS: Readonly<Record<string, string>> = {
  auth0,
  authelia,
  authentik,
  dex,
  entra: microsoft,
  github,
  gitlab,
  google,
  kanidm,
  keycloak,
  okta,
  "pocket-id": pocketId,
  zitadel,
};

type ProviderMarkProps = {
  /** Which provider's mark, as the provider says; none said, or one that is not drawn. */
  icon: string | null | undefined;
  /** What it speaks, where that is known: one with no mark of its own is told by it. */
  kind?: "oidc" | "oauth2" | undefined;
  className?: string;
};

/**
 * A provider's mark, in the colour of the text around it whatever the theme: the file is
 * what the colour shows through. One with no mark of its own has a key, or a card where
 * it is known to speak OpenID Connect.
 */
export function ProviderMark({ icon, kind, className }: ProviderMarkProps) {
  const src = icon === null || icon === undefined ? undefined : MARKS[icon];
  if (src === undefined) {
    const Generic = kind === "oidc" ? IdCard : KeyRound;
    return (
      <Generic aria-hidden data-provider-mark="" className={cn("aperture:size-4", className)} />
    );
  }
  const mask = `url("${src}") center / contain no-repeat`;
  return (
    <span
      aria-hidden
      data-provider-mark={icon}
      className={cn(
        "aperture:inline-block aperture:size-4 aperture:shrink-0 aperture:bg-current",
        className,
      )}
      style={{ mask, WebkitMask: mask }}
    />
  );
}
