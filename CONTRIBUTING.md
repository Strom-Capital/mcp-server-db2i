# Contributing to mcp-server-db2i

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing.

## Getting Started

1. **Fork the repository** and clone your fork
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Build the project:**
   ```bash
   npm run build
   ```
4. **Set up environment** (for testing):
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

2. Make your changes and ensure the project builds:
   ```bash
   npm run build
   ```

3. Test your changes with the MCP Inspector:
   ```bash
   npx @modelcontextprotocol/inspector node dist/index.js
   ```

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
3. Fill out the PR template
4. Ensure CI passes
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
