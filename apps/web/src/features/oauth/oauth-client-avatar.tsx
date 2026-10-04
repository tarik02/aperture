import { Avatar, AvatarFallback, AvatarImage } from "@aperture-browser/ui/components/avatar";
import type { OAuthClient } from "@aperture-browser/api-client";

interface OAuthClientAvatarProps {
  client: OAuthClient;
  size?: "default" | "sm" | "lg";
}

export function OAuthClientAvatar({ client, size = "default" }: OAuthClientAvatarProps) {
  return (
    <Avatar size={size} className="aperture:rounded-md aperture:after:rounded-md">
      {client.logoUri !== null ? (
        <AvatarImage
          src={client.logoUri}
          alt=""
          referrerPolicy="no-referrer"
          className="aperture:rounded-md"
        />
      ) : null}
      <AvatarFallback className="aperture:rounded-md">
        {client.name.trim().charAt(0).toUpperCase() || "?"}
      </AvatarFallback>
    </Avatar>
  );
}
