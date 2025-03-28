import { Google } from "arctic";
import type { Context } from "hono";
import { env } from "hono/adapter";
import { generateId } from "lucia";

import type { DatabaseUserAttributes } from "../../auth/lucia-auth";
import type { AppContext } from "../../context";
import { oauthAccountTable } from "../../database/oauth.accounts";
import { userTable } from "../../database/users";
import { fetchRefreshToken } from "../user/user.controller";

const googleClient = (c: Context<AppContext>) =>
  new Google(env(c).GOOGLE_CLIENT_ID, env(c).GOOGLE_CLIENT_SECRET, `${env(c).API_DOMAIN}/auth/google/callback`);

const getGoogleAuthorizationUrl = async ({
  c,
  state,
  codeVerifier,
}: {
  c: Context<AppContext>;
  state: string;
  codeVerifier: string;
}) => {
  const google = googleClient(c);
  const url = await google.createAuthorizationURL(state, codeVerifier, {
    scopes: [
      "profile",
      "email",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
    ],
  });
  url.searchParams.append("prompt", "consent");
  url.searchParams.append("access_type", "offline");
  return url.toString();
};

interface GoogleUser {
  sub: string;
  name: string;
  email: string;
  email_verified: boolean;
  picture: string;
}
const createGoogleSession = async ({
  c,
  idToken,
  codeVerifier,
  sessionToken,
}: {
  c: Context<AppContext>;
  idToken: string;
  codeVerifier: string;
  sessionToken?: string;
}) => {
  const google = googleClient(c);

  const tokens = await google.validateAuthorizationCode(idToken, codeVerifier);
  console.log({ tokens });
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
    },
  });
  const user: GoogleUser = (await response.json()) as GoogleUser;
  const existingAccount = await c.get("db").query.oauthAccounts.findFirst({
    where: (account, { eq }) => eq(account.providerUserId, user.sub.toString()),
  });
  let existingUser: DatabaseUserAttributes | null = null;
  if (sessionToken) {
    const sessionUser = await c.get("lucia").validateSession(sessionToken);
    if (sessionUser.user) {
      existingUser = sessionUser.user as DatabaseUserAttributes;
    }
  } else {
    const response = await c.get("db").query.users.findFirst({
      where: (u, { eq }) => eq(u.email, user.email),
    });
    if (response) {
      existingUser = response;
    }
  }
  if (existingUser?.emailVerified && user.email_verified && !existingAccount) {
    await c.get("db").insert(oauthAccountTable).values({
      providerUserId: user.sub,
      provider: "google",
      userId: existingUser.id,
    });
    const session = await c.get("lucia").createSession(existingUser.id, {});
    return session;
  }

  if (existingAccount) {
    const session = await c.get("lucia").createSession(existingAccount.userId, {});
    return session;
  }
  const userId = generateId(15);
  let username = user.name;
  const existingUsername = await c.get("db").query.users.findFirst({
    where: (u, { eq }) => eq(u.username, username),
  });
  if (existingUsername) {
    username = `${username}-${generateId(5)}`;
  }
  await c
    .get("db")
    .insert(userTable)
    .values({
      id: userId,
      username,
      email: user.email,
      emailVerified: user.email_verified ? 1 : 0,
      profilePictureUrl: user.picture,
      refreshToken: tokens.refreshToken ?? "",
    });
  await c.get("db").insert(oauthAccountTable).values({
    providerUserId: user.sub,
    provider: "google",
    userId,
  });
  const session = await c.get("lucia").createSession(userId, {});
  return session;
};

const getAccessToken = async (c: Context<AppContext>) => {
  const google = googleClient(c);
  const refreshToken = await fetchRefreshToken(c, c.get("user")?.id ?? "");
  if (!refreshToken) {
    throw new Error("No refresh token found");
  }
  const tokens = await google.refreshAccessToken(refreshToken);
  return tokens.accessToken;
};

export { getGoogleAuthorizationUrl, createGoogleSession, getAccessToken, googleClient };
