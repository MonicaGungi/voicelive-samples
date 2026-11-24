import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const defaultPath = fileURLToPath(new URL("./projects.config.json", import.meta.url));

export function loadProjectConfig(path = defaultPath) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed.projects)) throw new Error("Project configuration must contain a projects array.");
  const ids = new Set();
  for (const project of parsed.projects) {
    if (typeof project.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(project.id)) throw new Error("Configured project IDs must be stable slugs.");
    if (ids.has(project.id)) throw new Error(`Duplicate configured project ID: ${project.id}`);
    ids.add(project.id);
    if (typeof project.name !== "string" || !project.name.trim()) throw new Error(`Configured project ${project.id} needs a name.`);
    if (Object.hasOwn(project, "memoryScope")) throw new Error(`Configured project ${project.id} must not set memoryScope; cloud memory is private per user and project.`);
    if (project.agentVersion !== undefined && (typeof project.agentVersion !== "string" || !/^\d+$/.test(project.agentVersion))) throw new Error(`Configured project ${project.id} has an invalid agent version.`);
    if (project.knowledgeToolLabel !== undefined && (typeof project.knowledgeToolLabel !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(project.knowledgeToolLabel))) throw new Error(`Configured project ${project.id} has an invalid knowledge tool label.`);
    if (project.knowledgeToolEndpoint) {
      let endpoint;
      try { endpoint = new URL(project.knowledgeToolEndpoint); } catch { throw new Error(`Configured project ${project.id} has an invalid knowledge endpoint.`); }
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error(`Configured project ${project.id} has an invalid knowledge endpoint.`);
    }
  }
  return parsed.projects;
}

export function projectAccess(project, identity) {
  return Boolean(project && typeof identity?.userId === "string" && identity.userId.trim());
}

export function loadProjectBindings(path = defaultPath) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const projects = loadProjectConfig(path);
  const bindings = parsed.projectBindings || [];
  if (!Array.isArray(bindings)) throw new Error("Project bindings must be an array.");
  const projectIds = new Set(projects.map(project => project.id));
  const endpoints = new Set(projects.filter(project => project.knowledgeToolEndpoint).map(project => project.knowledgeToolEndpoint.toLowerCase()));
  const sources = new Set();
  for (const binding of bindings) {
    if (typeof binding.projectId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(binding.projectId) || projectIds.has(binding.projectId)) throw new Error("Project bindings require unique user-created project IDs.");
    if (typeof binding.agentVersion !== "string" || !/^\d+$/.test(binding.agentVersion)) throw new Error("Project bindings require a pinned agent version.");
    if (typeof binding.knowledgeToolLabel !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(binding.knowledgeToolLabel)) throw new Error("Project binding has an invalid knowledge tool label.");
    let endpoint;
    try { endpoint = new URL(binding.knowledgeToolEndpoint); } catch { throw new Error("Project binding has an invalid knowledge endpoint."); }
    if (endpoint.protocol !== "https:" || !/^[a-z0-9-]+\.search\.windows\.net$/.test(endpoint.hostname) || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^\/knowledgebases\/[a-z0-9-]+\/mcp$/.test(endpoint.pathname)) throw new Error("Project binding has an invalid knowledge endpoint.");
    if (typeof binding.knowledgeSource !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(binding.knowledgeSource)) throw new Error("Project binding has an invalid file knowledge source.");
    const endpointKey = endpoint.href.toLowerCase();
    const sourceKey = `${endpoint.origin}/${binding.knowledgeSource}`.toLowerCase();
    if (endpoints.has(endpointKey) || sources.has(sourceKey)) throw new Error("Each project binding requires its own knowledge base and source.");
    projectIds.add(binding.projectId);
    endpoints.add(endpointKey);
    sources.add(sourceKey);
  }
  return bindings;
}

