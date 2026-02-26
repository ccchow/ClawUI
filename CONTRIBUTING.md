# Contributing to ClawUI

Thank you for your interest in contributing to ClawUI! This guide will help you get started.

## Prerequisites

- **Node.js 20+** (LTS recommended)
- **npm 10+** (comes with Node.js 20)
- **Claude Code CLI** — required for interactive continuation and blueprint execution features
- **macOS or Linux** — the `expect` TTY wrapper is auto-detected (configurable via `EXPECT_PATH` env var)

## Getting Started

1. **Fork and clone** the repository:

   ```bash
   git clone https://github.com/ccchow/ClawUI.git
   cd ClawUI
   ```

2. **Install dependencies** (npm workspaces handle both backend and frontend):

   ```bash
   npm install
   ```

3. **Start the dev environment**:

   ```bash
   npm run dev
   ```

   This starts both the backend (Express on port 3001) and frontend (Next.js on port 3000).

## Dev vs Stable Environments

ClawUI uses separate dev and stable environments to prevent development from disrupting daily use:

| Environment | Frontend | Backend | Database | Usage |
|---|---|---|---|---|
| **Stable** | `:3000` | `:3001` | `.clawui/` | Daily use, runs compiled builds |
| **Dev** | `:3100` | `:3101` | `.clawui-dev/` | Development, runs from source with hot reload |

Scripts:
```bash
./scripts/start-dev.sh       # Start dev environment (hot reload)
./scripts/start-stable.sh    # Start stable from compiled builds
./scripts/deploy-stable.sh   # Build both → ready for stable restart
```

## Project Structure

```
ClawUI/
├── backend/src/        # Express server (TypeScript, ESM)
├── frontend/src/       # Next.js 14 app (React 18, Tailwind CSS)
├── docs/               # Architecture and design docs
└── scripts/            # Dev/stable environment scripts
```

See [README.md](README.md) for full architecture details.

## Code Style

### Backend (TypeScript / ESM)

- **ESM imports with `.js` extensions**: `import { foo } from "./bar.js"` — required for Node.js ESM resolution even though source files are `.ts`.
- **ESLint**: Run `npm run lint` (scoped to `backend/src/**/*.ts`).
- Type-check with `cd backend && npx tsc --noEmit`.

### Frontend (Next.js / React)

- **All components use `"use client"`** directive.
- **Tailwind CSS** with custom dark theme tokens (`bg-primary`, `accent-blue`, etc.) defined in `tailwind.config.ts`.
- **`@/*` path alias** maps to `./src/*`.
- Type-check with `cd frontend && npx tsc --noEmit`.

### General

- No semicolons are enforced — follow existing file conventions.
- Prefer small, focused changes over large refactors.

## Running Tests

Tests use Vitest in both packages:

```bash
cd backend && npx vitest run     # Backend tests
cd frontend && npx vitest run    # Frontend tests
```

## Making Changes

1. **Create a branch** from `main`:

   ```bash
   git checkout -b feat/your-feature
   ```

2. **Make your changes** — keep commits focused and atomic.

3. **Run checks** before submitting:

   ```bash
   # Type-check
   cd backend && npx tsc --noEmit
   cd frontend && npx tsc --noEmit

   # Lint
   npm run lint

   # Tests
   cd backend && npx vitest run
   cd frontend && npx vitest run
   ```

4. **Commit** with a clear message following [Conventional Commits](https://www.conventionalcommits.org/):

   ```
   feat: add session export to markdown
   fix: timeline scroll position reset on navigation
   docs: update API endpoint documentation
   refactor: extract shared timeline parsing logic
   ```

   Common prefixes: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.

## Pull Request Guidelines

- **One concern per PR** — don't mix features with unrelated refactors.
- **Describe what and why** — include context for reviewers. Screenshots for UI changes are appreciated.
- **Keep PRs small** — smaller PRs get reviewed faster and are easier to reason about.
- **Ensure all checks pass** — type-checking, linting, and tests must be green.
- **Update documentation** if your change affects public APIs, configuration, or architecture.

## Reporting Issues

Use [GitHub Issues](https://github.com/ccchow/ClawUI/issues) to report bugs or request features. Include:

- Steps to reproduce (for bugs)
- Expected vs actual behavior
- Node.js version and OS
- Relevant error output or screenshots

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
