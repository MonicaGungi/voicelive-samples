import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

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

  projects(userId) {
    return this.db.prepare("SELECT p.id,p.name,p.owner_id=? AS isOwner,p.owner_id='__application_config__' AS isConfigured FROM projects p JOIN members m ON m.project_id=p.id WHERE m.user_id=? AND NOT EXISTS (SELECT 1 FROM archived_projects a WHERE a.project_id=p.id) ORDER BY p.name,p.rowid").all(userId, userId);
  }

  authorize(userId, projectId) {
    if (!this.db.prepare("SELECT 1 FROM members m WHERE m.user_id=? AND m.project_id=? AND NOT EXISTS (SELECT 1 FROM archived_projects a WHERE a.project_id=m.project_id)").get(userId, projectId)) {
      throw new Error("Project access denied.");
    }
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