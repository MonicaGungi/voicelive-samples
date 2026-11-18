# Artifact templates

## BRD — business requirements document
- Document metadata: project, version, date, owner, approval status
- Executive summary and problem statement
- Business objectives and measurable success indicators
- Stakeholders, user groups and responsibilities
- Current-state pain points and future-state outcomes
- Scope: in, out, deferred
- Business requirements `BR-001` etc. with rationale, priority, status and source
- Constraints, dependencies, risks and assumptions
- Decisions, open questions and approval requests

## PRD — product requirements document
- Product vision, personas, key journeys
- MVP boundaries and release assumptions
- Functional requirements `FR-001` etc.: description, actor, trigger, behavior, business rules, exceptions, priority, status, source
- Nonfunctional requirements `NFR-001` etc.: measurable targets if confirmed, otherwise TBD
- Data and integration requirements, privacy/security needs
- User experience, notifications, reports, admin needs
- Traceability to business requirements
- Acceptance criteria and outstanding decisions

## User stories
`US-001: As a [role], I want [capability], so that [outcome].`
Include linked requirement IDs, priority, preconditions, main flow, exception paths, Given/When/Then acceptance criteria, unresolved dependencies.

## Decision register
`DEC-001 | Topic | Decision | Status (confirmed/proposed/conflicted/superseded) | Owner | Date | Evidence/source | Supersedes`

## Open questions register
`Q-001 | Question | Why it matters | Impact | Owner | Related requirement IDs | Status`

## Executive handoff
One-page overview: business opportunity, users, core journeys, MVP, key decisions, top risks, critical unknowns, recommended next discovery actions. Clearly label all drafts as unapproved unless explicitly signed off.

## Project memory snapshot
Use JSON with fields: `project_id`, `project_name`, `last_updated`, `objective`, `users`, `workflows`, `requirements`, `decisions`, `assumptions`, `conflicts`, `open_questions`, `priorities`, `next_best_question`, `session_summary`. Avoid storing full transcripts unless authorized and supported by host retention policy.

## Document generation rules
- Generate documents only when explicitly requested, at an agreed milestone, or when the stakeholder says done.
- Do not generate a BRD or PRD in response to greetings or casual questions.
- Clearly distinguish confirmed, proposed, assumed, open, conflicted, and rejected information.
- Never invent missing document content.
- Mark documents as drafts until explicitly approved.
