import { getBearerTokenProvider } from "@azure/identity";

export function createLocalClaimsResolver(credential, tokenProvider = getBearerTokenProvider(credential, "https://ai.azure.com/.default")) {
  let boundUserId;
  return async () => {
    const token = await tokenProvider();
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (!claims.tid || !claims.oid) throw new Error("Azure CLI must be signed in with a Microsoft Entra user identity.");
    const userId = `${claims.tid}:${claims.oid}`;
    if (boundUserId && boundUserId !== userId) throw new Error("Azure CLI identity changed. Restart the backend before using another account.");
    boundUserId = userId;
    return {
      userId,
      roles: Array.isArray(claims.roles) ? claims.roles.filter(role => typeof role === "string") : [],
      groupIds: Array.isArray(claims.groups) ? claims.groups.filter(group => typeof group === "string") : [],
      groupOverage: Boolean(claims.hasgroups || claims._claim_names?.groups),
    };
  };
}

export function createLocalIdentityResolver(credential, tokenProvider) {
  const resolveClaims = createLocalClaimsResolver(credential, tokenProvider);
  return async () => (await resolveClaims()).userId;
}