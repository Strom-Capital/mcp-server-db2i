# Contributing to mcp-server-db2i

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing.

By taking part in this project you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, see [SECURITY.md](SECURITY.md) instead of opening an issue.

## Finding Something to Work On

Issues labeled [`good first issue`](https://github.com/Strom-Capital/mcp-server-db2i/labels/good%20first%20issue) or [`help wanted`](https://github.com/Strom-Capital/mcp-server-db2i/labels/help%20wanted) are good places to start. Comment on the issue before you begin, so two people don't build the same thing. For a larger change, open an issue first to agree on the approach.

## Getting Started

1. **Fork the repository** and clone your fork
2. **Use Node.js 22 or newer** (see `.nvmrc`)
3. **Install dependencies:**
   ```bash
   npm install
   ```
4. **Build the project:**
   ```bash
   npm run build
   ```
5. **Set up environment** (only needed to run against a real IBM i):
   ```bash
   cp .env.example .env
   # Edit .env with your IBM i credentials
   ```

## Development Workflow

### Making Changes

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```

2. Make your changes and run the same checks as CI:
   ```bash
   npm run build
   npm run typecheck
   npm run lint
   npm test
   ```
   The tests mock the database drivers, so they run without an IBM i system.

3. Test your changes with the MCP Inspector:
   ```bash
   npx @modelcontextprotocol/inspector node dist/index.js
   ```

### Keep Real System Names Out

This repository is public. Do not put customer, site or ERP names from a real system into code, tests, docs, examples, commit messages, issues or pull requests. That includes library, table and column names, user profiles and hostnames. Use stand-ins such as `MYLIB`, `OTHERLIB`, `ORDERS`, `CUSTOMERS`, `ORDERNO` and `ibmi.example.com`.

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/) for automated releases via [Release Please](https://github.com/googleapis/release-please). The **PR title** becomes the squash-commit subject on `main`, so it must be a conventional commit.

| Type | Description | Version Bump |
|------|-------------|--------------|
| `feat:` | New feature | Minor |
| `fix:` | Bug fix | Patch |
| `perf:` | Performance improvement | Patch |
| `deps:` | Dependency update | None (listed in changelog) |
| `ci:` | CI / release pipeline | None (listed in changelog) |
| `docs:` | Documentation only | None |
| `chore:` | Maintenance | None |
| `feat!:` / `fix!:` | Breaking change | Major |

Examples:
```
feat: add list_procedures tool
fix: handle null values in query results
docs: update JDBC options table
```

### Pull Requests

1. Push your branch to your fork
2. Open a PR against `main` with a conventional-commit title
3. Fill out the PR template, and write `Closes #N` for the issue it resolves
4. Ensure CI passes (a maintainer approves the first CI run for new contributors)
5. Request review

**Always squash-merge.** GitHub merge commits copy the PR title into the merge-commit body. Release Please then records both the feature commit and the merge commit, which produces duplicate changelog rows (see v1.3.2). The repository allows squash-merge only.

## Project Structure and New Tools

See [docs/development.md](docs/development.md#project-structure) for the source layout, and [Adding a New Tool](docs/development.md#adding-a-new-tool) for the steps. Update `README.md` when you add a tool.

## Code Style

- Use TypeScript strict mode
- Prefer `async/await` over raw promises
- Add JSDoc comments for public functions
- Keep tools focused and single-purpose

## Questions?

Open an issue for questions or discussion. We're happy to help!
