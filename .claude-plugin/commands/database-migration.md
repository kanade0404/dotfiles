---
name: database-migration
description: Workflow command scaffold for database-migration.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /database-migration

Use this workflow when working on database schema changes.

## Goal

Database schema changes with migration files

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Create migration file
- Update schema definitions
- Generate/update types
