# Extremely Autonomous Agents

Working name. Domain: **extremely.agency**. A standalone AI agency product, closely modeled on the agency
that runs inside the World Asset Register repo (`maxkxd/AssetRegister`,
`agency/` + `agency-runner/`), but built and shipped as its own product.

## What we know so far

- **Separate product, separate repo.** Nothing here depends on or ships with
  World Asset Register. The WAR agency is the reference design, not a dependency.
- **Two clients, one system:** a desktop app and a mobile app, connected to
  the same backend and kept in sync.

## Reference design (in the WAR repo)

- `agency/` — the Charter pattern: each agent is plain files in git
  (`CHARTER.md`, `MEMORY.md`, `KPI.yaml`, `TOOLS.yaml`) plus the agency
  Postgres schema in `agency/db/migrations/`.
- `agency-runner/` — the runtime that executes agents.
- `WAR-Agentic-Operating-Model` repo — the full design plan and Decision Register.

## Status

Repo created 2026-10-28. Product details, stack, and scope still to come.

## License

[AGPL-3.0](LICENSE). Free to use and self-host; anyone who runs a modified
version as a service must publish their changes under the same license. A paid
hosted plan is offered separately, and the hosted backend lives in its own
repository. Outside pull requests aren't accepted until a CLA is in place - see
[CONTRIBUTING.md](CONTRIBUTING.md).
