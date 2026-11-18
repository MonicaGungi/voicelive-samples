# Enterprise Requirements Discovery Skill

Original skill designed for a single voice/text Azure AI Foundry requirements interviewer. Inspired by the publicly described approaches of:
- https://github.com/fatihgune/interviewer (MIT)
- https://github.com/ranggaoscar/rockfoundry (MIT)

This package is an original synthesis of patterns, not a verbatim redistribution of either repository's prompts or application code.

## Contents
- `SKILL.md`: primary behavioral instructions
- `references/discovery-checklist.md`: coverage map
- `references/readiness-rubric.md`: ambiguity/readiness heuristic
- `references/output-templates.md`: document schemas

## Deploy
Use as an agent skill if your selected Foundry agent runtime supports this skill layout; otherwise place SKILL.md in the agent's instructions and provide the reference files as supported knowledge/context. Connect voice separately through the voice capabilities supported by your chosen Foundry runtime. For durable cross-session memory, implement a project-keyed persistence tool/store; a prompt alone cannot persist data.

## Minimal test
Ask the agent: 'I want a platform that helps our salespeople prepare proposals faster.' Verify that it asks a single useful business question, captures answers without inventing details, identifies conflicting decisions, and produces a draft PRD with explicit open questions when asked.
