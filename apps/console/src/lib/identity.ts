/** What signs people in and out, as a browser asks it. Its cookies are the browser's to carry. */
const post = async (path: string, body: object) => {
  const answer = await fetch(`/api/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!answer.ok) {
    const said: unknown = await answer.json().catch(() => null);
    const message =
      typeof said === "object" &&
      said !== null &&
      "message" in said &&
      typeof said.message === "string"
        ? said.message
        : `It answered ${answer.status}`;
    throw new Error(message);
  }
};

export const signIn = (email: string, password: string) =>
  post("/sign-in/email", { email, password });

export const signOut = () => post("/sign-out", {});

/** Sets a password with the token of a setup link. */
export const setPassword = (token: string, newPassword: string) =>
  post("/reset-password", { token, newPassword });
