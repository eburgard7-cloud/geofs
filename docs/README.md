# Docs index

One line per doc: what it's for, and who it's for.

| Doc | What it's for | Who it's for |
|---|---|---|
| [README.md](../README.md) | The showpiece: install in 60 seconds, features, powerups, joke planes, liveries, architecture | Players first, then maintainers |
| [docs/RUNBOOK.md](RUNBOOK.md) | The single operational source of truth: player support, race night, content, release, deploy, backups, troubleshooting, debug tools, dev environment | Whoever hosts, ships or fixes things |
| [docs/REFERENCE.md](REFERENCE.md) | Generated tables: hotkeys, every `CONFIG` flag, every endpoint, every env var. Rebuilt by `python race/tools/gen_docs.py` | Anyone looking up a key, flag, route or variable |
| [race/README.md](../race/README.md) | Module guide: every file in `race/`, how the pieces talk, what each `race.js` module does, the engine rules | Developers and Claude Code sessions |
| [race/PROTOCOL.md](../race/PROTOCOL.md) | The wire spec for `/ws/race/{room}` and `/ws/hub`, proto 1–8, checked against `app.py` | Anyone changing the relay or its client |
| [race/ACCEPTANCE.md](../race/ACCEPTANCE.md) | The in-sim checklist a release has to pass, grouped by feature, with a "Last passed" column | Testers on geo-fs.com before any version bump |
| [race/CHANGELOG.md](../race/CHANGELOG.md) | What shipped, per version, newest first | Everyone |
| [race/courses/CUPS.md](../race/courses/CUPS.md) | Which courses make up each cup, and which ones clear terrain | Race-night hosts, course authors |
| [race/docs/AUDIT.md](../race/docs/AUDIT.md) | Historical dead-code / superseded-UI audit (2026-09-23), with a status note | Whoever cleans up `race.js` |
| [CLAUDE.md](../CLAUDE.md) | The rules every Claude Code session in this repo follows | Claude Code sessions, and whoever writes their prompts |
| [DOCS_REPORT.md](../DOCS_REPORT.md) | This docs overhaul's findings and porting map (old section → new section) | Whoever merges tonight's branches |

Stubs kept so old links still work: [race/server/DEPLOY_CHECKLIST.md](../race/server/DEPLOY_CHECKLIST.md)
(→ RUNBOOK) and [race/docs/ACCEPTANCE.md](../race/docs/ACCEPTANCE.md) (→ race/ACCEPTANCE.md).
