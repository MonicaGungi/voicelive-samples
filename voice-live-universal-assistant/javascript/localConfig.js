export function configureLocalAgent(env) {
  if (env.VOICELIVE_LOCAL_ONLY !== "true") return;
  const projectUrl = new URL(env.AZURE_EXISTING_AIPROJECT_ENDPOINT);
  const projectMatch = projectUrl.pathname.match(/^\/api\/projects\/([^/]+)\/?$/);
  const agentMatch = env.AZURE_EXISTING_AGENT_ID?.match(/^([^:]+)(?::(\d+))?$/);
  if (projectUrl.protocol !== "https:" || !projectUrl.hostname.endsWith(".services.ai.azure.com") || !projectMatch || !agentMatch) {
    throw new Error("Expected a Foundry HTTPS project endpoint and agent name with an optional :version in .env");
  }
  env.AZURE_VOICELIVE_ENDPOINT = projectUrl.origin;
  env.AZURE_VOICELIVE_PROJECT = decodeURIComponent(projectMatch[1]);
  env.AZURE_VOICELIVE_AGENT_NAME = agentMatch[1];
  if (agentMatch[2]) env.AZURE_VOICELIVE_AGENT_VERSION = agentMatch[2];
  else delete env.AZURE_VOICELIVE_AGENT_VERSION;
  env.VOICELIVE_MODE = "agent";
  env.VOICELIVE_ALLOW_ANONYMOUS = "true";
  env.VOICELIVE_ALLOW_CLIENT_AGENT_OVERRIDE = "false";
}

export function isPromptRoleTestingEnabled(env) {
  if (env.VOICELIVE_PROMPT_ROLE_TESTING !== "true") return false;
  if (env.VOICELIVE_LOCAL_ONLY !== "true") throw new Error("Prompt-selected role testing is only available in local-only mode.");
  return true;
}