const TOKEN_PREFIX = "apt_";

export function parseTokenId(rawToken: string): string | null {
  const trimmed = rawToken.trim();
  if (!trimmed.startsWith(TOKEN_PREFIX)) {
    return null;
  }

  const rest = trimmed.slice(TOKEN_PREFIX.length);
  const separator = rest.indexOf("_");
  if (separator <= 0) {
    return null;
  }

  const tokenId = rest.slice(0, separator);
  const secret = rest.slice(separator + 1);
  if (!tokenId || !secret) {
    return null;
  }

  return tokenId;
}

export function maskTokenId(tokenId: string): string {
  if (tokenId.length <= 8) {
    return tokenId;
  }

  return `${tokenId.slice(0, 4)}…${tokenId.slice(-4)}`;
}
