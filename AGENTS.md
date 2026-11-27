# FluxPrompt docs: rules for agents and contributors

This repository is the FluxPrompt documentation site, built with [Mintlify](https://mintlify.com) and published at https://docs.fluxprompt.ai from the `main` branch. Pages are MDX files with YAML frontmatter. Navigation lives in `docs.json`.

The GitHub repository is public. Anything you commit is readable by anyone, even on a page that sits behind the site's sign-in.

## Audiences and tabs

Place a page by who reads it, not by the folder it lives in.

| Tab | Audience | Public on the site | Languages | Groups |
|---|---|---|---|---|
| Product guide | People who use FluxPrompt, and the product team | Yes | English and pt-BR | Concepts, SuperChat, Organizations and roles, Running agents, Integrations |
| API & MCP | Integrators calling FluxPrompt from code or an AI client | Yes | English and pt-BR | Completions API, Integrations API, Memory Pods API, MCP |
| Engineering | The engineering team | No, sign-in required | English | Ways of working, Runbooks, Architecture, Execution, Main API, Worker, Client, MCP server, Incidents and audits |
| Team | Everyone on the team | No, sign-in required | English | Welcome |

- Every group in the two public tabs has `"public": true` in `docs.json`. This is Mintlify partial authentication: https://mintlify.com/docs/deploy/authentication-setup. Never put an internal page in a public group.
- Both language trees in `docs.json` (`en` and `pt-BR`) list all four tabs. Add a new page to both trees.

## Bilingual pages

- Pages in **Product guide** and **API & MCP** need a pt-BR twin. Engineering and Team pages are English only; existing pt-BR copies may stay but are not required.
- The twin sits in a `pt-br/` folder next to the English file, following the convention the folder already uses (`mcp/pt-br/tools/versioning.mdx`, `worker/pt-br/error-taxonomy.mdx`). For a new folder, use `<folder>/pt-br/<page>.mdx`.
- List the English page in the `en` tree and the twin in the `pt-BR` tree, in the matching group.
- Update the twin in the same change as the English page. Translate prose, not syntax.
- Public pages written before this rule that still lack a twin are listed in `scripts/pt-br-backlog.json`. Remove a page from that list when you add its twin. Do not add new pages to it.

## Frontmatter

Every page needs `title` and `description`:

```mdx
---
title: "Cancel a run"
description: "How a running flow is cancelled and what each node does when it is."
---
```

Use sentence case for titles. Do not start the body with an `# H1`; Mintlify renders the title.

## Node specification

The node specification that the MCP `get_node_type` tool and SuperChat serve lives here, one page per node type, in `node-spec/nodes/<kebab-type>.mdx`. Edit the page here and run `pnpm sync:node-spec` in the back repo; never edit the generated files in back. It belongs in the Engineering tab.

## Accuracy

- Verify every statement about behavior against `origin/main` of the product repo (`back`, `front`, `worker`, `mcp-server`) before you write it. `main` is production. `develop` and `staging` are not, and `back@master` and `production` are legacy branch names that no longer receive work.
- When a feature is only on `develop` or `staging`, say so in a `<Warning>` at the top of the page and remove it when the feature reaches `main`.
- Cite the code you checked with a path, and when it helps, a `state_verified` date and `state_verified_against` commit in the frontmatter.

## What never goes in a page

- Customer names, emails, user ids, organization ids, flow ids or any other customer data, including in examples and screenshots.
- Secrets, tokens, internal hostnames that are not already public, or database credentials.
- Internal security designs and plans. They belong in the private Workflow repository, not here.

## Moving pages

Do not rename or move a page without a reason. When you do, add a `redirects` entry in `docs.json` from the old path to the new one, and update the links that pointed at it.

## Checks

Pull requests run `.github/workflows/docs-check.yml`:

- `docs.json` must parse.
- `node scripts/check-frontmatter.mjs` fails when a page in the navigation is missing, lacks `title` or `description`, or is a public page without a pt-BR twin.
- `mint broken-links` fails on broken internal links.
- `mint validate` fails when a page does not build, for example on an unknown component.

Run them locally before you push:

```bash
node scripts/check-frontmatter.mjs
npx --yes mint@latest broken-links
npx --yes mint@latest validate
```

Preview the site with `npx --yes mint@latest dev`.

## Style

- English for English pages, Brazilian Portuguese for twins.
- Plain, direct sentences in the active voice. Address the reader as "you".
- Bold for UI elements (**Settings**); code formatting for file names, commands, paths and identifiers.
- No comments in example code unless the comment is the point of the example.
