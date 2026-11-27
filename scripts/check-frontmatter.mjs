import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_FIELDS = ['title', 'description'];
const DEFAULT_LANGUAGE = 'en';
const TWIN_LANGUAGE = 'pt-BR';
const SPECIAL_TWINS = { 'getting-started/welcome/index': 'getting-started/welcome/pt-br/overview' };

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

const pageFile = (page) => {
  for (const ext of ['.mdx', '.md']) {
    const file = path.join(root, `${page}${ext}`);
    if (fs.existsSync(file)) return file;
  }
  return null;
};

const twinOf = (page) => {
  if (SPECIAL_TWINS[page]) return pageFile(SPECIAL_TWINS[page]) ? SPECIAL_TWINS[page] : null;
  const parts = page.split('/');
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const candidate = [...parts.slice(0, i), 'pt-br', ...parts.slice(i)].join('/');
    if (pageFile(candidate)) return candidate;
  }
  return null;
};

const frontmatterFields = (file) => {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fields = {};
  const lines = match[1].split('\n');
  lines.forEach((line, index) => {
    const field = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!field) return;
    const [, key, raw] = field;
    let value = raw.trim().replace(/^['"]|['"]$/g, '').trim();
    if (/^[>|][-+]?$/.test(value)) {
      const next = lines[index + 1] ?? '';
      value = /^\s+\S/.test(next) ? next.trim() : '';
    }
    fields[key] = value;
  });
  return fields;
};

const collect = (items, isPublic, out) => {
  for (const item of items ?? []) {
    if (typeof item === 'string') {
      out.push({ page: item, isPublic });
      continue;
    }
    const groupPublic = isPublic || item.public === true;
    collect(item.pages, groupPublic, out);
    for (const key of ['groups', 'tabs', 'anchors', 'dropdowns', 'versions']) {
      if (Array.isArray(item[key])) collect(item[key], groupPublic, out);
    }
  }
  return out;
};

const errors = [];
const warnings = [];

let docs;
try {
  docs = readJson('docs.json');
} catch (error) {
  console.error(`docs.json does not parse: ${error.message}`);
  process.exit(1);
}

const backlogFile = 'scripts/pt-br-backlog.json';
const backlog = new Set(fs.existsSync(path.join(root, backlogFile)) ? readJson(backlogFile).pages : []);

const languages = docs.navigation?.languages ?? [{ language: DEFAULT_LANGUAGE, tabs: docs.navigation?.tabs ?? [] }];
const entriesByLanguage = new Map(
  languages.map((language) => [language.language, collect(language.tabs, false, [])]),
);

const checked = new Set();
for (const entries of entriesByLanguage.values()) {
  for (const { page } of entries) {
    if (checked.has(page)) continue;
    checked.add(page);
    const file = pageFile(page);
    if (!file) {
      errors.push(`${page}: listed in docs.json but no .mdx or .md file exists`);
      continue;
    }
    const fields = frontmatterFields(file);
    for (const field of REQUIRED_FIELDS) {
      if (!fields[field]) errors.push(`${page}: frontmatter is missing "${field}"`);
    }
  }
}

const twinEntries = entriesByLanguage.get(TWIN_LANGUAGE) ?? [];
const twinPublicPages = new Set(twinEntries.filter((entry) => entry.isPublic).map((entry) => entry.page));
const defaultEntries = entriesByLanguage.get(DEFAULT_LANGUAGE) ?? [];

for (const { page, isPublic } of defaultEntries) {
  if (!isPublic) continue;
  const twin = twinOf(page);
  if (!twin) {
    if (!backlog.has(page)) errors.push(`${page}: public page has no pt-BR twin (add <folder>/pt-br/<page>.mdx)`);
    continue;
  }
  if (backlog.has(page)) warnings.push(`${page}: has a pt-BR twin now; remove it from ${backlogFile}`);
  if (entriesByLanguage.has(TWIN_LANGUAGE) && !twinPublicPages.has(twin)) {
    errors.push(`${page}: its pt-BR twin ${twin} is not listed in a public group of the ${TWIN_LANGUAGE} navigation`);
  }
}

for (const page of backlog) {
  if (!defaultEntries.some((entry) => entry.page === page && entry.isPublic)) {
    warnings.push(`${page}: listed in ${backlogFile} but is not a public page in the navigation`);
  }
}

for (const warning of warnings) console.warn(`warning: ${warning}`);
for (const error of errors) console.error(`error: ${error}`);

console.log(
  `Checked ${checked.size} pages: ${errors.length} errors, ${warnings.length} warnings, ${backlog.size} public pages still waiting for a pt-BR twin.`,
);
process.exit(errors.length > 0 ? 1 : 0);
