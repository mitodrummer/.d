---
name: memory-persistence-via-dotd
description: Sandbox memory does not persist — mirror memory writes to the mitodrummer/.d repo via PR so the host loadout sync delivers them to future sessions
metadata: 
  node_type: memory
  type: project
  originSessionId: e0acc804-1264-442f-9957-30eab741f959
  modified: 2026-08-19T04:47:42.795Z
---

The sandbox home (including `~/.claude/projects/-workbench/memory/`) is wiped between sessions. Karl's `mitodrummer/.d` repo syncs his `.claude/` to his host home, and the loadout brings the host home into the sandbox — so that repo is the persistence channel for memories.

**How to apply:** after writing or updating a memory locally, mirror it into a clone of `mitodrummer/.d` under `.claude/projects/-workbench/memory/` (same filenames, MEMORY.md index included), on a branch, and open a PR — never push to its default branch directly. Karl authorized this workflow on 2026-08-19. If a memory read from context conflicts with what the .d repo carries, the repo version is the durable one.
