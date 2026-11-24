import { describe, expect, it } from "vite-plus/test";
import { cookieMatchesHosts, toStateCookie } from "../src/capture.ts";

const cookie = (more: Partial<chrome.cookies.Cookie>): chrome.cookies.Cookie => ({
  name: "sid",
  value: "v",
  domain: "example.com",
  hostOnly: true,
  path: "/",
  secure: true,
  httpOnly: false,
  sameSite: "unspecified",
  session: true,
  storeId: "0",
  ...more,
});

describe("a cookie of someone's browser, as a session takes it", () => {
  it("one for a host alone, that ends with the browser and says nothing of sites", () => {
    expect(toStateCookie(cookie({}))).toEqual({
      name: "sid",
      value: "v",
      domain: "example.com",
      hostOnly: true,
      path: "/",
      httpOnly: false,
      secure: true,
    });
  });

  it("one for a domain, kept from scripts, until a time, for its own site alone", () => {
    const taken = toStateCookie(
      cookie({
        domain: ".example.com",
        hostOnly: false,
        httpOnly: true,
        session: false,
        expirationDate: 1_900_000_000.5,
        sameSite: "strict",
      }),
    );
    expect(taken).toMatchObject({
      domain: ".example.com",
      hostOnly: false,
      httpOnly: true,
      expires: 1_900_000_000.5,
      sameSite: "Strict",
    });
  });

  it("one that goes anywhere is said to", () => {
    expect(toStateCookie(cookie({ sameSite: "no_restriction" })).sameSite).toBe("None");
    expect(toStateCookie(cookie({ sameSite: "lax" })).sameSite).toBe("Lax");
  });

  it("one kept apart for a site keeps the site, and whether a frame of another was between", () => {
    const apart = { topLevelSite: "https://shop.example" };
    expect(toStateCookie(cookie({ partitionKey: apart })).partitionKey).toEqual({
      topLevelSite: "https://shop.example",
      hasCrossSiteAncestor: false,
    });
    const between = { ...apart, hasCrossSiteAncestor: true };
    expect(toStateCookie(cookie({ partitionKey: between })).partitionKey).toEqual(between);
  });
});

describe("the cookies a frame could send", () => {
  const hosts = new Set(["app.example.com"]);

  it("its host's, and those of the domains above it", () => {
    expect(cookieMatchesHosts(cookie({ domain: "app.example.com" }), hosts)).toBe(true);
    expect(cookieMatchesHosts(cookie({ domain: ".example.com" }), hosts)).toBe(true);
    expect(cookieMatchesHosts(cookie({ domain: ".Example.com" }), hosts)).toBe(true);
  });

  it("none of a host beside it, below it, or that only ends alike", () => {
    expect(cookieMatchesHosts(cookie({ domain: "other.example.com" }), hosts)).toBe(false);
    expect(cookieMatchesHosts(cookie({ domain: "deep.app.example.com" }), hosts)).toBe(false);
    expect(cookieMatchesHosts(cookie({ domain: "ple.com" }), hosts)).toBe(false);
  });
});
