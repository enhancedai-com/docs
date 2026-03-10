---
name: mintlify-docs
description: Create and maintain Mintlify documentation for developer-focused projects. Use when working with Mintlify docs, API documentation, developer guides, setup instructions, environment configuration, billing documentation, or when creating/updating docs.json and MDX files. Supports English documentation for developers, API reference generation, navigation structure, and Mintlify component usage.
---

# Mintlify Documentation Skill

**Always consult mintlify.com/docs for components, configuration, and latest features.**

This skill helps create and maintain Mintlify documentation sites, particularly for developer-focused projects like Enhanced AI's Fluxprompt system.

## Project Context

**Client**: Enhanced AI  
**System**: Fluxprompt (node-based workflow system, similar to N8N/Langflow)  
**Repository**: Single repo with front-end and back-end in separate root folders (e.g., `/frontend`, `/backend`)  
**Documentation**: English, developers only  
**APIs**: No formal spec today — map from code and document in Mintlify (manual pages or generate OpenAPI from code)  
**Mintlify**: Already present (`docs.json` exists); navigation structure still to be defined

## Before You Write

### Understand the project

1. **Read `docs.json`** in the project root to understand:
   - Existing navigation structure
   - Theme and configuration
   - What pages already exist
   - Navigation groups and naming conventions

2. **Check for existing content**:
   - Search docs before creating new pages
   - Update existing pages instead of duplicating
   - Link to existing content

3. **Read surrounding content**:
   - Review 2-3 similar pages to match voice, structure, and formatting
   - Understand the site's level of detail

## Required Documentation Sections

| Section | Content |
|---------|---------|
| **Getting started** | Project setup, prerequisites, first run (front + back if applicable) |
| **Configuration** | `.env` — list variables **per environment** (dev/staging/prod); examples with placeholders only |
| **Billing** | Stripe: model, where it's configured, main flows |
| **Concepts** | **Nodes (Fluxprompt)**: what they are, types, lifecycle, execution (N8N/Langflow-style); how they integrate in the product |
| **Features** | Collection, Node execution, Dashboard, Auth, API usage/integrations, Webhooks, Deploy/CI-CD/environments, Monitoring/logs, Dashboards, Reports, Chats, Forms |
| **API Reference** | Map available endpoints from code; document in Mintlify (manual or via OpenAPI); Mintlify as single source of truth |

## File Structure

**Recommended**: `/docs` at repo root, with `docs.json` and `.mdx` organized by domain:
- `getting-started/`
- `configuration/`
- `billing/`
- `concepts/` (nodes)
- `features/`
- `api-reference/`

If the project already has a convention, follow it. Otherwise, use `/docs` at root.

## Quick Reference

### CLI Commands

- `npm i -g mint` — Install Mintlify CLI
- `mint dev` — Local preview at localhost:3000
- `mint broken-links` — Check internal links
- `mint validate` — Validate documentation builds
- `mint a11y` — Check accessibility issues

### Required Files

- `docs.json` — Site configuration (navigation, theme, integrations)
- `*.mdx` files — Documentation pages with YAML frontmatter

## Page Frontmatter

Every page requires `title`. Include `description` for SEO:

```yaml
---
title: "Clear, descriptive title"
description: "Concise summary for SEO and navigation"
---
```

Optional fields: `sidebarTitle`, `icon`, `tag`, `mode`, `keywords`.

## File Conventions

- Use kebab-case: `getting-started.mdx`, `api-reference.mdx`
- Root-relative paths without extensions for internal links: `/getting-started/quickstart`
- No relative paths (`../`) or absolute URLs for internal pages
- Add new pages to `docs.json` navigation

## Navigation Structure

The `navigation` property in `docs.json` controls site structure. Choose a primary pattern:

| Pattern | When to Use |
|---------|-------------|
| **Groups** | Default. Single audience, straightforward hierarchy |
| **Tabs** | Distinct sections (Guides vs API Reference) or different audiences |
| **Anchors** | Persistent section links at sidebar top |
| **Dropdowns** | Multiple doc sections users switch between |
| **Products** | Multi-product company |
| **Versions** | Multiple API/product versions |

**Common pattern**: Tabs containing groups (most common for docs with API reference).

## Writing Standards

### Voice and Structure

- Second-person voice ("you")
- Active voice, direct language
- Sentence case for headings ("Getting started", not "Getting Started")
- Lead with context: explain what something is before how to use it
- Prerequisites at the start of procedural content

### What to Avoid

**Never use**:
- Marketing language ("powerful", "seamless", "robust")
- Filler phrases ("it's important to note", "in order to")
- Excessive conjunctions ("moreover", "furthermore")
- Editorializing ("obviously", "simply", "just")

### Formatting

- All code blocks must have language tags
- All images must have descriptive alt text
- Use bold and italics only when they serve understanding
- No decorative formatting or emoji

### Code Examples

- Keep examples simple and practical
- Use realistic values (not "foo" or "bar")
- One clear example is better than multiple variations
- Test that code works before including

## Document APIs

**Choose your approach**:

1. **Have OpenAPI spec?** → Add to `docs.json` with `"openapi": ["openapi.yaml"]`. Pages auto-generate.
2. **No spec?** → Write endpoints manually with `api: "POST /users"` in frontmatter.
3. **Hybrid** → Use OpenAPI for most endpoints, manual pages for complex workflows.

**For Enhanced AI**: Map endpoints from code and document in Mintlify. Mintlify is the single source of truth (no Swagger).

## Key Points

- **.env**: Document **per environment**; only placeholders in examples
- **APIs**: Emphasize "map from code" + "document in Mintlify as single source of truth"
- **Terminology**: "Nodes" / "Fluxprompt" (Enhanced AI = client name)
- **Language**: All docs in **English**; audience **developers only**

## Components

Common Mintlify components:

| Need | Use |
|------|-----|
| Hide optional details | `<Accordion>` |
| Long code examples | `<Expandable>` |
| User chooses one option | `<Tabs>` |
| Sequential instructions | `<Steps>` |
| Code in multiple languages | `<CodeGroup>` |
| API parameters | `<ParamField>` |
| API response fields | `<ResponseField>` |

**Callouts by severity**:
- `<Note>` — Supplementary info
- `<Info>` — Helpful context
- `<Tip>` — Recommendations
- `<Warning>` — Potentially destructive actions
- `<Check>` — Success confirmation

## Workflow

1. **Understand the task**: What needs documenting? Which pages affected?
2. **Research**: Read `docs.json`, search existing docs, read similar pages
3. **Plan**: Synthesize what reader should accomplish, propose updates
4. **Write**: Start with most important info, keep sections focused
5. **Update navigation**: Add new pages to `docs.json`
6. **Verify**: Frontmatter, language tags, links, navigation, style, run `mint broken-links` and `mint validate`

## Additional Resources

- For detailed Mintlify components and advanced patterns, see [reference.md](reference.md)
- Mintlify documentation: https://mintlify.com/docs
- Configuration schema: https://mintlify.com/docs.json
