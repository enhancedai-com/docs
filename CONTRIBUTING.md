# Contribute to the documentation

This repository is the FluxPrompt documentation site, published at https://docs.fluxprompt.ai from `main`. Read [AGENTS.md](AGENTS.md) first: it explains which tab a page belongs in, which pages need a pt-BR twin, the required frontmatter, and what must never be written in a page.

## How to contribute

### Edit on GitHub

1. Open the page you want to change in this repository.
2. Click **Edit this file** (the pencil icon).
3. Make your change and open a pull request against `main`.

### Work locally

1. Clone this repository and create a branch from `main`, named `docs/<task-code>-<topic>`.
2. Make your changes.
3. Preview the site with `npx --yes mint@latest dev` and open `http://localhost:3000`.
4. Run the checks the pull request runs:
   ```bash
   node scripts/check-frontmatter.mjs
   npx --yes mint@latest broken-links
   npx --yes mint@latest validate
   ```
5. Commit and open a pull request against `main`.

## Writing guidelines

- **Use active voice**: "Run the command", not "The command should be run".
- **Address the reader directly**: use "you", not "the user".
- **Keep sentences short**: one idea per sentence.
- **Lead with the goal**: start instructions with what the reader wants to do.
- **Use consistent terms**: do not alternate between synonyms for the same thing.
- **Show examples**: a request and its response explain more than a paragraph.
- **Check the code**: verify behavior against `origin/main` of the product repository before you describe it.
