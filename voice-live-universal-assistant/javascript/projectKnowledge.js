import { createHash } from "node:crypto";

const apiVersion = "2026-10-01";

export class ProjectKnowledge {
  constructor(credential, protectedProjects, request = fetch) {
    this.credential = credential;
    this.protectedProjects = protectedProjects;
    this.request = request;
  }

  async discover(origin) {
    const endpoint = new URL(origin);
    if (endpoint.protocol !== "https:" || !/^[a-z0-9-]+\.search\.windows\.net$/.test(endpoint.hostname) || endpoint.port || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new Error("Invalid Foundry IQ service endpoint.");
    const token = await this.credential.getToken("https://search.azure.com/.default");
    let next = new URL(`/knowledgebases?api-version=${apiVersion}`, endpoint.origin);
    const projects = [];
    const visited = new Set();
    while (next) {
      if (next.origin !== endpoint.origin || next.pathname !== "/knowledgebases" || next.hash || visited.has(next.href)) throw new Error("Invalid Foundry IQ continuation URL.");
      visited.add(next.href);
      const response = await this.request(next.href, { headers: { Authorization: `Bearer ${token.token}` }, redirect: "error" });
      if (!response.ok) throw new Error(`Foundry IQ discovery failed (HTTP ${response.status}).`);
      const result = await response.json();
      if (!Array.isArray(result.value)) throw new Error("Invalid Foundry IQ discovery response.");
      for (const base of result.value) {
        if (typeof base.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(base.name)) throw new Error("Invalid Foundry IQ knowledge base name.");
        const knowledgeToolEndpoint = `${endpoint.origin}/knowledgebases/${base.name}/mcp`;
        const id = base.name.length <= 80 ? base.name : `kb-${createHash("sha256").update(knowledgeToolEndpoint).digest("hex").slice(0, 32)}`;
        projects.push({ id, name: base.name, knowledgeToolEndpoint });
      }
      next = result["@odata.nextLink"] ? new URL(result["@odata.nextLink"], endpoint.origin) : null;
    }
    return projects;
  }

  async call(origin, path, options = {}) {
    const token = await this.credential.getToken("https://search.azure.com/.default");
    const response = await this.request(`${origin}${path}?api-version=${apiVersion}`, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token.token}` },
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Foundry IQ request failed (HTTP ${response.status}). Check the project configuration and Search permissions.`);
    return response.json();
  }

  async retrieve(knowledgeToolEndpoint, query) {
    const endpoint = new URL(knowledgeToolEndpoint);
    const match = endpoint.pathname.match(/^\/knowledgebases\/([a-z0-9][a-z0-9-]{0,127})\/mcp$/);
    if (endpoint.protocol !== "https:" || !/^[a-z0-9-]+\.search\.windows\.net$/.test(endpoint.hostname) || !match) throw new Error("Invalid project knowledge endpoint.");
    const post = body => this.call(endpoint.origin, `/knowledgebases('${match[1]}')/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const extract = result => (result.response || []).flatMap(message => message.content || []).map(part => part.text).filter(Boolean).join("\n");
    const hasContent = text => text.replace(/\s/g, "") !== "" && text.replace(/\s/g, "") !== "[]";
    // Minimal-effort KBs accept only intents; messages are the fallback for KBs that reject intents.
    let text;
    try { text = extract(await post({ intents: [{ type: "semantic", search: query }] })); }
    catch (error) {
      if (!/HTTP 400/.test(error.message)) throw error;
      text = extract(await post({ messages: [{ role: "user", content: [{ type: "text", text: query }] }] }));
    }
    if (!hasContent(text)) {
      // Broad questions fall under the reranker threshold; retry once without it.
      const base = await this.call(endpoint.origin, `/knowledgebases('${match[1]}')`);
      const params = [];
      for (const { name } of base.knowledgeSources || []) {
        const source = await this.call(endpoint.origin, `/knowledgesources('${name}')`);
        params.push({ knowledgeSourceName: name, kind: source.kind, rerankerThreshold: 0 });
      }
      if (params.length) text = extract(await post({ intents: [{ type: "semantic", search: query }], knowledgeSourceParams: params }));
    }
    return hasContent(text) ? text.slice(0, 12000) : "";
  }

  async verify(binding) {
    const endpoint = new URL(binding.knowledgeToolEndpoint);
    const knowledgeBase = endpoint.pathname.split("/")[2];
    const source = binding.knowledgeSource;
    const base = await this.call(endpoint.origin, `/knowledgebases('${knowledgeBase}')`);
    if (base.knowledgeSources?.length !== 1 || base.knowledgeSources[0].name !== source) throw new Error("The project knowledge base must contain only its configured file source.");
    for (const project of this.protectedProjects) {
      if (!project.knowledgeToolEndpoint) continue;
      const protectedEndpoint = new URL(project.knowledgeToolEndpoint);
      if (protectedEndpoint.origin !== endpoint.origin) continue;
      const protectedName = protectedEndpoint.pathname.split("/")[2];
      if (!/^[a-z0-9-]+$/.test(protectedName)) throw new Error("Unable to verify an existing project knowledge base.");
      const protectedBase = await this.call(endpoint.origin, `/knowledgebases('${protectedName}')`);
      if (protectedBase.knowledgeSources?.some(item => item.name === source)) throw new Error("The file source is already used by an existing project.");
    }
    const sourceInfo = await this.call(endpoint.origin, `/knowledgesources('${source}')`);
    if (sourceInfo.kind !== "file") throw new Error("The project knowledge source must support direct file upload.");
    return { origin: endpoint.origin, source };
  }

  async list(binding) {
    const { origin, source } = await this.verify(binding);
    const result = await this.call(origin, `/knowledgesources('${source}')/files`);
    return (result.value || []).map(file => ({ id: file.fileId, name: file.fileName, error: file.errorMessage || null }));
  }

  async upload(binding, name, content) {
    if (typeof name !== "string" || !name.trim() || name.length > 120 || /[\\/\x00-\x1f\x7f]/.test(name) || name === "." || name === "..") throw new Error("Choose a valid document filename.");
    if (!Buffer.isBuffer(content) || !content.length || content.length > 10 * 1024 * 1024) throw new Error("Choose a document between 1 byte and 10 MB.");
    const { origin, source } = await this.verify(binding);
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({ fileName: name })], { type: "application/json" }));
    form.append("content", new Blob([content], { type: "application/octet-stream" }), name);
    const file = await this.call(origin, `/knowledgesources('${source}')/files`, { method: "POST", body: form, signal: AbortSignal.timeout(190000) });
    if (!file.fileId || file.errorMessage) throw new Error(file.errorMessage || "Foundry IQ did not confirm the document was indexed.");
    return { id: file.fileId, name: file.fileName, error: file.errorMessage || null };
  }
}