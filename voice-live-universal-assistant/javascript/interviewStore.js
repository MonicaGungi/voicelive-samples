import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHmac, randomBytes, randomUUID } from "node:crypto";

export class InterviewStore {
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS archived_projects (project_id TEXT PRIMARY KEY REFERENCES projects(id), archived_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL, PRIMARY KEY(project_id,user_id));
      CREATE TABLE IF NOT EXISTS interviews (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL, memory_error TEXT);
      CREATE TABLE IF NOT EXISTS conversations (interview_id TEXT NOT NULL REFERENCES interviews(id), foundry_id TEXT NOT NULL, PRIMARY KEY(interview_id,foundry_id));
      CREATE TABLE IF NOT EXISTS transcripts (sequence INTEGER PRIMARY KEY AUTOINCREMENT, interview_id TEXT NOT NULL REFERENCES interviews(id), item_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, exported INTEGER NOT NULL DEFAULT 0, UNIQUE(interview_id,item_id));
      CREATE TABLE IF NOT EXISTS scope_secrets (id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_roles (user_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), role TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,project_id));
      CREATE TABLE IF NOT EXISTS memory_scopes (tenant_id TEXT NOT NULL, user_object_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), first_name TEXT, last_name TEXT, memory_scope TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(tenant_id,user_object_id,project_id));
      CREATE INDEX IF NOT EXISTS memory_scopes_name_project ON memory_scopes(tenant_id,project_id,last_name,first_name);
      CREATE TABLE IF NOT EXISTS employee_scope_tenant (id INTEGER PRIMARY KEY CHECK(id=1), tenant_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS employee_scope_users (tenant_id TEXT NOT NULL, user_object_id TEXT NOT NULL, employee_id TEXT NOT NULL COLLATE NOCASE UNIQUE, PRIMARY KEY(tenant_id,user_object_id));
      CREATE TABLE IF NOT EXISTS employee_memory_scopes (tenant_id TEXT NOT NULL, user_object_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), employee_id TEXT NOT NULL, first_name TEXT, last_name TEXT, memory_scope TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(tenant_id,user_object_id,project_id));
      UPDATE interviews SET status='interrupted' WHERE status IN ('active','saving');
    `);
  }

  createProject(userId, name) {
    if (typeof name !== "string" || !name.trim() || name.length > 120) throw new Error("Project name must contain 1 to 120 characters.");
    if (this.db.prepare("SELECT 1 FROM projects p WHERE p.owner_id=? AND lower(p.name)=lower(?) AND NOT EXISTS (SELECT 1 FROM archived_projects a WHERE a.project_id=p.id)").get(userId, name.trim())) {
      throw new Error("You already have a project with this name. Select it from the project list.");
    }
    const project = { id: randomUUID(), name: name.trim() };
    this.db.prepare("INSERT INTO projects VALUES (?,?,?)").run(project.id, project.name, userId);
    this.db.prepare("INSERT INTO members VALUES (?,?)").run(project.id, userId);
    return project;
  }

  registerConfiguredProject(projectId, name) {
    if (typeof projectId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(projectId) || typeof name !== "string" || !name.trim()) {
      throw new Error("Configured project requires a stable ID and name.");
    }
    const existing = this.db.prepare("SELECT name,owner_id FROM projects WHERE id=?").get(projectId);
    if (existing) {
      if (existing.name !== name || existing.owner_id !== "__application_config__") throw new Error("Configured project conflicts with an existing user-created project.");
      return;
    }
    this.db.prepare("INSERT INTO projects VALUES (?,?,?)").run(projectId, name.trim(), "__application_config__");
  }

  addProjectMember(userId, projectId) {
    if (!this.db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) throw new Error("Unknown project.");
    this.db.prepare("INSERT OR IGNORE INTO members VALUES (?,?)").run(projectId, userId);
  }

  joinActiveProjects(userId) {
    if (typeof userId !== "string" || !userId.trim()) throw new Error("An authenticated user is required.");
    this.db.prepare("INSERT OR IGNORE INTO members(project_id,user_id) SELECT p.id,? FROM projects p WHERE NOT EXISTS (SELECT 1 FROM archived_projects a WHERE a.project_id=p.id)").run(userId);
  }

  projects(userId) {
    return this.db.prepare("SELECT p.id,p.name,p.owner_id=? AS isOwner,p.owner_id='__application_config__' AS isConfigured FROM projects p JOIN members m ON m.project_id=p.id WHERE m.user_id=? AND NOT EXISTS (SELECT 1 FROM archived_projects a WHERE a.project_id=p.id) ORDER BY p.name,p.rowid").all(userId, userId);
  }

  authorize(userId, projectId) {
    if (!this.db.prepare("SELECT 1 FROM members m WHERE m.user_id=? AND m.project_id=? AND NOT EXISTS (SELECT 1 FROM archived_projects a WHERE a.project_id=m.project_id)").get(userId, projectId)) {
      throw new Error("Project access denied.");
    }
  }

  bindEmployeeScope(userId, projectId, employeeId, metadata = {}) {
    this.authorize(userId, projectId);
    const identity = typeof userId === "string" && /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(userId);
    if (!identity || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(projectId)) throw new Error("A trusted tenant, user, and project are required for memory.");
    if (typeof employeeId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,15}$/.test(employeeId)) throw new Error("Your Entra employee ID must contain 1 to 16 letters, digits, hyphens, or underscores and start with a letter or digit. Contact an administrator.");
    const tenantId = identity[1].toLowerCase();
    const objectId = identity[2].toLowerCase();
    const normalizedId = employeeId.toUpperCase();
    const cleanName = name => typeof name === "string" && name.trim() && name.length <= 120 ? name.trim() : null;
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO employee_scope_tenant(id,tenant_id) VALUES(1,?)").run(tenantId);
      if (this.db.prepare("SELECT tenant_id FROM employee_scope_tenant WHERE id=1").get().tenant_id !== tenantId) throw new Error("This memory store is reserved for a different tenant.");
      const current = this.db.prepare("SELECT employee_id FROM employee_scope_users WHERE tenant_id=? AND user_object_id=?").get(tenantId, objectId);
      if (current && current.employee_id !== normalizedId) throw new Error("Your Entra employee ID has changed. Contact an administrator before continuing.");
      const owner = this.db.prepare("SELECT tenant_id,user_object_id FROM employee_scope_users WHERE employee_id=? COLLATE NOCASE").get(normalizedId);
      if (owner && (owner.tenant_id !== tenantId || owner.user_object_id !== objectId)) throw new Error("This employee ID is already associated with another user. Contact an administrator.");
      this.db.prepare("INSERT OR IGNORE INTO employee_scope_users(tenant_id,user_object_id,employee_id) VALUES(?,?,?)").run(tenantId, objectId, normalizedId);
      const scope = `${projectId}-${normalizedId}`;
      const scopeOwner = this.db.prepare("SELECT tenant_id,user_object_id,project_id FROM employee_memory_scopes WHERE memory_scope=? COLLATE NOCASE").get(scope);
      if (scopeOwner && (scopeOwner.tenant_id !== tenantId || scopeOwner.user_object_id !== objectId || scopeOwner.project_id !== projectId)) throw new Error("This employee and project combination conflicts with an existing memory scope. Contact an administrator.");
      this.db.prepare(`INSERT INTO employee_memory_scopes(tenant_id,user_object_id,project_id,employee_id,first_name,last_name,memory_scope,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,user_object_id,project_id) DO UPDATE SET
        first_name=COALESCE(excluded.first_name,employee_memory_scopes.first_name), last_name=COALESCE(excluded.last_name,employee_memory_scopes.last_name), updated_at=excluded.updated_at`)
        .run(tenantId, objectId, projectId, normalizedId, cleanName(metadata.firstName), cleanName(metadata.lastName), scope, now, now);
      this.db.exec("COMMIT");
      return scope;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  employeeScope(userId, projectId) {
    this.authorize(userId, projectId);
    const identity = typeof userId === "string" && /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(userId);
    if (!identity) throw new Error("A trusted tenant and user are required for memory.");
    const tenantId = identity[1].toLowerCase();
    const objectId = identity[2].toLowerCase();
    const tenant = this.db.prepare("SELECT tenant_id FROM employee_scope_tenant WHERE id=1").get();
    if (!tenant || tenant.tenant_id !== tenantId) throw new Error("This memory store is not configured for your tenant.");
    const mapping = this.db.prepare("SELECT memory_scope FROM employee_memory_scopes WHERE tenant_id=? AND user_object_id=? AND project_id=?").get(tenantId, objectId, projectId);
    if (!mapping) throw new Error("Your employee memory scope has not been registered. Start an interview first.");
    return mapping.memory_scope;
  }

  employeeScopeCandidate(userId, projectId, employeeId) {
    this.authorize(userId, projectId);
    if (typeof employeeId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,15}$/.test(employeeId) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(projectId)) throw new Error("A valid project and Entra employee ID are required for memory.");
    const identity = typeof userId === "string" && /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(userId);
    if (!identity) throw new Error("A trusted tenant and user are required for memory.");
    const tenantId = identity[1].toLowerCase();
    const objectId = identity[2].toLowerCase();
    const tenant = this.db.prepare("SELECT tenant_id FROM employee_scope_tenant WHERE id=1").get();
    if (tenant && tenant.tenant_id !== tenantId) throw new Error("This memory store is reserved for a different tenant.");
    const normalizedId = employeeId.toUpperCase();
    const owner = this.db.prepare("SELECT tenant_id,user_object_id FROM employee_scope_users WHERE employee_id=? COLLATE NOCASE").get(normalizedId);
    if (owner && (owner.tenant_id !== tenantId || owner.user_object_id !== objectId)) throw new Error("This employee ID is already associated with another user. Contact an administrator.");
    const existing = this.db.prepare("SELECT employee_id,memory_scope FROM employee_memory_scopes WHERE tenant_id=? AND user_object_id=? AND project_id=?").get(tenantId, objectId, projectId);
    if (existing && existing.employee_id !== normalizedId) throw new Error("Your Entra employee ID has changed. Contact an administrator before continuing.");
    return { scope: `${projectId}-${normalizedId}`, registered: Boolean(existing) };
  }

  previousMemoryScope(userId, projectId) {
    this.authorize(userId, projectId);
    const [tenantId, objectId] = userId.toLowerCase().split(":");
    return this.db.prepare("SELECT memory_scope FROM memory_scopes WHERE tenant_id=? AND user_object_id=? AND project_id=?").get(tenantId, objectId, projectId)?.memory_scope;
  }

  memoryScope(userId, projectId, metadata = {}) {
    this.authorize(userId, projectId);
    const identity = typeof userId === "string" && /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(userId);
    if (!identity || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(projectId)) throw new Error("A trusted tenant, user, and project are required for memory.");
    const tenantId = identity[1].toLowerCase();
    const objectId = identity[2].toLowerCase();
    const cleanName = name => typeof name === "string" && name.trim() && name.length <= 120 ? name.trim() : null;
    const firstName = cleanName(metadata.firstName);
    const lastName = cleanName(metadata.lastName);
    this.db.prepare("INSERT OR IGNORE INTO scope_secrets(id,secret) SELECT 1,? WHERE NOT EXISTS (SELECT 1 FROM memory_scopes)").run(randomBytes(32).toString("hex"));
    const secret = this.db.prepare("SELECT secret FROM scope_secrets WHERE id=1").get()?.secret;
    if (!secret || !/^[a-f0-9]{64}$/.test(secret)) throw new Error("Memory scope key is unavailable. Restore the interview database from backup.");
    const digest = createHmac("sha256", Buffer.from(secret, "hex")).update(JSON.stringify([tenantId, objectId, projectId])).digest("hex");
    const candidate = `nova-v2-${projectId.slice(0, 24).toLowerCase()}-${digest}`;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO memory_scopes(tenant_id,user_object_id,project_id,first_name,last_name,memory_scope,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,user_object_id,project_id) DO UPDATE SET
      first_name=COALESCE(excluded.first_name,memory_scopes.first_name), last_name=COALESCE(excluded.last_name,memory_scopes.last_name), updated_at=excluded.updated_at`)
      .run(tenantId, objectId, projectId, firstName, lastName, candidate, now, now);
    return this.db.prepare("SELECT memory_scope FROM memory_scopes WHERE tenant_id=? AND user_object_id=? AND project_id=?").get(tenantId, objectId, projectId).memory_scope;
  }

  grantAccess(ownerId, projectId, userId) {
    const project = this.db.prepare("SELECT owner_id FROM projects WHERE id=?").get(projectId);
    if (project?.owner_id !== ownerId) throw new Error("Only the project owner may grant access.");
    this.authorize(ownerId, projectId);
    this.db.prepare("INSERT OR IGNORE INTO members VALUES (?,?)").run(projectId, userId);
  }

  archiveProject(userId, projectId) {
    this.authorize(userId, projectId);
    const project = this.db.prepare("SELECT owner_id FROM projects WHERE id=?").get(projectId);
    if (project.owner_id !== userId) throw new Error("Only the project owner may remove this project.");
    if (this.db.prepare("SELECT 1 FROM interviews WHERE project_id=? AND status IN ('active','saving')").get(projectId)) {
      throw new Error("End all interviews and wait for memory saves before removing this project.");
    }
    this.db.prepare("INSERT INTO archived_projects VALUES (?,?)").run(projectId, new Date().toISOString());
    return { archived: true };
  }

  open(userId, projectId, interviewId) {
    this.authorize(userId, projectId);
    if (this.busy(userId, projectId)) {
      throw new Error("Finish the active interview or wait for its memory update before starting another.");
    }
    if (interviewId) {
      const interview = this.get(userId, projectId, interviewId);
      if (interview.status === "active") throw new Error("This interview is already active.");
    } else {
      interviewId = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare("INSERT INTO interviews VALUES (?,?,?,?,?,'new',NULL)").run(interviewId, projectId, userId, now, now);
    }
    const context = { userId, projectId, interviewId };
    this.setStatus(context, "active");
    return context;
  }

  projectRole(userId, projectId) {
    this.authorize(userId, projectId);
    return this.db.prepare("SELECT role FROM project_roles WHERE user_id=? AND project_id=?").get(userId, projectId)?.role ?? null;
  }

  saveProjectRole(userId, projectId, role) {
    this.authorize(userId, projectId);
    const clean = typeof role === "string" ? role.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
    if (!clean || clean.length > 120) throw new Error("Role must contain 1 to 120 characters.");
    this.db.prepare("INSERT INTO project_roles(user_id,project_id,role,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id,project_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at")
      .run(userId, projectId, clean, new Date().toISOString());
    return clean;
  }

  busy(userId, projectId) {
    this.authorize(userId, projectId);
    return Boolean(this.db.prepare("SELECT 1 FROM interviews WHERE user_id=? AND project_id=? AND status IN ('active','saving')").get(userId, projectId));
  }

  get(userId, projectId, interviewId) {
    this.authorize(userId, projectId);
    const interview = this.db.prepare("SELECT * FROM interviews WHERE id=? AND user_id=? AND project_id=?").get(interviewId, userId, projectId);
    if (!interview) throw new Error("Interview access denied.");
    return interview;
  }

  list(userId, projectId) {
    this.authorize(userId, projectId);
    return this.db.prepare("SELECT id,created_at,updated_at,status,memory_error FROM interviews WHERE user_id=? AND project_id=? ORDER BY updated_at DESC LIMIT 50").all(userId, projectId);
  }

  recordConversation(context, conversationId) {
    this.get(context.userId, context.projectId, context.interviewId);
    if (typeof conversationId !== "string" || !conversationId.startsWith("conv_")) throw new Error("Foundry did not return a valid conversation ID.");
    this.db.prepare("INSERT OR IGNORE INTO conversations VALUES (?,?)").run(context.interviewId, conversationId);
  }

  conversationIds(context) {
    this.get(context.userId, context.projectId, context.interviewId);
    return this.db.prepare("SELECT foundry_id FROM conversations WHERE interview_id=? ORDER BY rowid").all(context.interviewId).map((row) => row.foundry_id);
  }

  record(context, id, role, content) {
    this.get(context.userId, context.projectId, context.interviewId);
    if (!["user", "assistant"].includes(role) || typeof content !== "string" || !content.trim()) return;
    this.db.prepare("INSERT INTO transcripts(interview_id,item_id,role,content) VALUES (?,?,?,?) ON CONFLICT(interview_id,item_id) DO UPDATE SET content=excluded.content,exported=0").run(context.interviewId, id, role, content);
    this.db.prepare("UPDATE interviews SET updated_at=? WHERE id=?").run(new Date().toISOString(), context.interviewId);
  }

  transcript(context, pendingOnly = false) {
    this.get(context.userId, context.projectId, context.interviewId);
    return this.db.prepare(`SELECT sequence,item_id,role,content FROM transcripts WHERE interview_id=? ${pendingOnly ? "AND exported=0" : ""} ORDER BY sequence`).all(context.interviewId);
  }

  priorInterviewHistory(context) {
    this.get(context.userId, context.projectId, context.interviewId);
    return this.db.prepare(`SELECT t.sequence,i.id AS interview_id,i.created_at,t.role,t.content
      FROM transcripts t JOIN interviews i ON i.id=t.interview_id
      WHERE i.user_id=? AND i.project_id=? AND i.id!=?
      ORDER BY t.sequence DESC LIMIT 120`).all(context.userId, context.projectId, context.interviewId).reverse();
  }

  setStatus(context, status, error = null) {
    this.get(context.userId, context.projectId, context.interviewId);
    this.db.prepare("UPDATE interviews SET status=?,memory_error=?,updated_at=? WHERE id=?").run(status, error, new Date().toISOString(), context.interviewId);
  }

  markExported(context, rows) {
    this.get(context.userId, context.projectId, context.interviewId);
    const statement = this.db.prepare("UPDATE transcripts SET exported=1 WHERE interview_id=? AND sequence=? AND content=?");
    for (const row of rows) statement.run(context.interviewId, row.sequence, row.content);
  }

  setMemoryError(context, error) {
    this.get(context.userId, context.projectId, context.interviewId);
    this.db.prepare("UPDATE interviews SET memory_error=? WHERE id=?").run(error, context.interviewId);
  }

  pending(userId, projectId) {
    this.authorize(userId, projectId);
    return this.db.prepare("SELECT DISTINCT i.id FROM interviews i JOIN transcripts t ON t.interview_id=i.id WHERE i.user_id=? AND i.project_id=? AND i.status!='active' AND t.exported=0").all(userId, projectId)
      .map((row) => ({ userId, projectId, interviewId: row.id }));
  }

  close() { this.db.close(); }
}