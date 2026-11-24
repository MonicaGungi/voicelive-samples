import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class EntraAuthError extends Error {}

export function loadEntraConfig(env) {
  if (env.VOICELIVE_ENTRA_AUTH !== "true") return null;
  if (env.VOICELIVE_LOCAL_ONLY !== "true") throw new Error("Entra sign-in is currently supported only with VOICELIVE_LOCAL_ONLY=true.");
  const tenantId = (env.ENTRA_TENANT_ID || "").trim().toLowerCase();
  const clientId = (env.ENTRA_CLIENT_ID || "").trim().toLowerCase();
  if (!GUID.test(tenantId) || !GUID.test(clientId)) throw new Error("VOICELIVE_ENTRA_AUTH=true requires ENTRA_TENANT_ID and ENTRA_CLIENT_ID GUIDs.");
  const apiScope = (env.ENTRA_API_SCOPE || `api://${clientId}/access_as_user`).trim();
  const separator = apiScope.lastIndexOf("/");
  const audience = apiScope.slice(0, separator);
  const scopeName = apiScope.slice(separator + 1);
  if (!/^(api|https):\/\/[^\s]+$/.test(audience) || !/^[A-Za-z0-9._-]{1,120}$/.test(scopeName)) throw new Error("ENTRA_API_SCOPE must look like api://<application-id>/<scope>.");
  return { tenantId, clientId, apiScope, audience, scopeName };
}

export function bearerToken(header) {
  return /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header || "")?.[1];
}

export async function resolveEmployeeIdentity(identity, graphToken, config, fetchGraph = fetch) {
  if (typeof graphToken !== "string" || graphToken.length > 16384) throw new EntraAuthError("Microsoft Graph sign-in is required to retrieve your employee ID.");
  let claims;
  try { claims = decodeJwt(graphToken); }
  catch { throw new EntraAuthError("Your Microsoft Graph sign-in is invalid. Sign in again."); }
  let response;
  try {
    response = await fetchGraph("https://graph.microsoft.com/v1.0/me?$select=id,employeeId", {
      headers: { authorization: `Bearer ${graphToken}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch { throw new EntraAuthError("Microsoft Graph is unavailable. Try again later."); }
  if (!response.ok) throw new EntraAuthError("Microsoft Graph could not read your employee ID. Check User.Read consent and sign in again.");
  let profile;
  try { profile = await response.json(); }
  catch { throw new EntraAuthError("Microsoft Graph returned an invalid user profile."); }
  const tenantId = String(claims.tid || "").toLowerCase();
  const objectId = String(claims.oid || "").toLowerCase();
  if (tenantId !== config.tenantId || `${tenantId}:${objectId}` !== identity.userId || String(profile.id || "").toLowerCase() !== objectId || String(claims.azp || claims.appid || "").toLowerCase() !== config.clientId) {
    throw new EntraAuthError("The Microsoft Graph profile does not match your signed-in account.");
  }
  if (typeof profile.employeeId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,15}$/.test(profile.employeeId)) throw new EntraAuthError("Your Entra employee ID must contain 1 to 16 letters, digits, hyphens, or underscores and start with a letter or digit. Contact an administrator.");
  return { ...identity, employeeId: profile.employeeId };
}

export function createEntraTokenVerifier(config, jwks = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`))) {
  return async (token, idToken) => {
    if (typeof token !== "string" || token.length > 16384 || token.split(".").length !== 3) throw new EntraAuthError("Sign in with Microsoft Entra to continue.");
    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: [`https://login.microsoftonline.com/${config.tenantId}/v2.0`, `https://sts.windows.net/${config.tenantId}/`],
        audience: [config.clientId, config.audience],
        algorithms: ["RS256"],
        clockTolerance: 60,
        requiredClaims: ["exp", "oid", "tid"],
      }));
    } catch {
      throw new EntraAuthError("Your sign-in is invalid or expired. Sign in again.");
    }
    if (String(payload.tid).toLowerCase() !== config.tenantId || !GUID.test(String(payload.oid))) throw new EntraAuthError("The token does not identify a user in the configured tenant.");
    // Same registration serves as SPA and API, so only that client may present tokens.
    if (String(payload.azp || payload.appid || "").toLowerCase() !== config.clientId) throw new EntraAuthError("The token was issued to a different application.");
    if (typeof payload.scp !== "string" || !payload.scp.split(" ").includes(config.scopeName)) throw new EntraAuthError("The token is missing this application's delegated API scope.");
    let profile = payload;
    if (idToken) {
      try {
        if (typeof idToken !== "string" || idToken.length > 16384) throw new Error("Invalid profile token");
        const verified = await jwtVerify(idToken, jwks, {
          issuer: [`https://login.microsoftonline.com/${config.tenantId}/v2.0`, `https://sts.windows.net/${config.tenantId}/`],
          audience: config.clientId,
          algorithms: ["RS256"],
          clockTolerance: 60,
          requiredClaims: ["exp", "oid", "tid"],
        });
        if (String(verified.payload.tid).toLowerCase() !== String(payload.tid).toLowerCase() || String(verified.payload.oid).toLowerCase() !== String(payload.oid).toLowerCase()) throw new Error("Profile identity mismatch");
        profile = verified.payload;
      } catch {
        throw new EntraAuthError("The sign-in profile is invalid or does not match your account.");
      }
    }
    const strings = (value) => Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
    return {
      userId: `${String(payload.tid).toLowerCase()}:${String(payload.oid).toLowerCase()}`,
      name: typeof payload.name === "string" ? payload.name : "",
      firstName: typeof profile.given_name === "string" ? profile.given_name : "",
      lastName: typeof profile.family_name === "string" ? profile.family_name : "",
      roles: strings(payload.roles),
      groupIds: strings(payload.groups),
      groupOverage: Boolean(payload.hasgroups || payload._claim_names?.groups),
    };
  };
}
