# AURORA AI code-repair setup

The AI repair endpoint is disabled until the Render API has a repository-scoped GitHub token. The endpoint is restricted to authenticated `super_admin` accounts and creates draft pull requests only. It never merges or deploys.

## Render environment variables

Add these to the **swass-api** service in Render:

- `GITHUB_REPAIR_TOKEN`: a fine-grained GitHub personal access token for this repository only.
- `GITHUB_REPAIR_REPOSITORY`: `emmanuelaustine995-rgb/SWASS`
- `GITHUB_REPAIR_BASE_BRANCH`: `main`
- `OPENAI_API_KEY`: existing OpenAI API key used by the maintenance assistant.
- `OPENAI_MODEL`: optional; defaults to the model configured by the API.

Do not put token values in source code, GitHub commits, screenshots, support messages, or ChatGPT messages.

## Create a least-privilege GitHub token

1. In GitHub, open **Settings → Developer settings → Personal access tokens → Fine-grained tokens**.
2. Create a token restricted to **Only select repositories** and select `SWASS`.
3. Grant repository permissions:
   - **Contents: Read and write** — read approved source files and create an isolated repair branch.
   - **Pull requests: Read and write** — open a draft repair pull request.
   - **Metadata: Read-only** — required repository metadata.
4. Do not grant Actions, Administration, Secrets, Environments, or workflow permissions.
5. Set an expiry and store the token directly in Render as `GITHUB_REPAIR_TOKEN`. Rotate it before expiry.

A GitHub App with equivalent repository-only permissions is preferable for a longer-term installation; the current API implementation accepts a fine-grained token.

## Protect the production branch

In GitHub repository settings, protect `main` and require pull requests and passing CI checks before merge. Do not allow the repair integration to bypass branch protection. Keep production deployment tied to a human-approved merge.

## How repairs work

1. A super-admin requests a diagnosis.
2. The super-admin chooses **Prepare code repair pull request**.
3. The API reads only the source paths allowlisted for that maintenance category, pinned to one base commit.
4. AI proposes complete replacement contents for existing allowlisted files only.
5. The API rejects paths outside the allowlist, oversized changes, and credential-like output.
6. A draft pull request is created on a separate `ai-repair/*` branch.
7. GitHub Actions checks the proposal. A super-admin reviews the complete diff and approves the merge manually.
8. Render deploys only if the repository's normal deployment configuration deploys approved merges.

A draft pull request is not a completed repair. A green indicator must not be interpreted as production success until CI, merge, deployment, and the production health check have all been verified.
