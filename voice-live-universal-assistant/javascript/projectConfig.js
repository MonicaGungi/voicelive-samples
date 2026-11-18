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
    if (typeof project.name !== "string" || !project.name.trim() || typeof project.memoryScope !== "string" || !project.memoryScope.trim()) throw new Error(`Configured project ${project.id} needs a name and explicit memory scope.`);
    if (!Array.isArray(project.accessGroupIds) || project.accessGroupIds.length === 0) throw new Error(`Configured project ${project.id} must require at least one Entra access group.`);
    for (const groupId of project.accessGroupIds) if (!/^[0-9a-f-]{36}$/i.test(groupId)) throw new Error(`Configured project ${project.id} contains an invalid access group ID.`);
    project.roleGroupIds ||= {};
    project.roleAppValues ||= {};
    for (const role of ["stakeholder", "hr", "developer"]) {
      project.roleGroupIds[role] ||= [];
      project.roleAppValues[role] ||= [];
      if (!Array.isArray(project.roleGroupIds[role]) || !Array.isArray(project.roleAppValues[role])) throw new Error(`Role claim mappings for ${project.id}/${role} must be arrays.`);
    }
  }
  return parsed.projects;
}

export function projectAccess(project, identity) {
  return project.accessGroupIds.some(groupId => identity.groupIds.includes(groupId));
}

export function projectRole(project, identity) {
  const matches = [];
  for (const role of ["stakeholder", "hr", "developer"]) {
    if (project.roleGroupIds[role].some(groupId => identity.groupIds.includes(groupId)) || project.roleAppValues[role].some(value => identity.roles.includes(value))) matches.push(role);
  }
  return matches.length === 1 ? matches[0] : null;
}