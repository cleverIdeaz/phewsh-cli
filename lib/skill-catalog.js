const fs = require('fs');
const path = require('path');

const CATALOG_FILE = path.join(__dirname, '..', 'skills', 'catalog.json');
const CATEGORIES = new Set([
  'project-truth',
  'execution',
  'composable-skills',
  'workflow-systems',
  'security',
  'specialist-packs',
  'standards-and-directories',
  'workbench',
]);
const KINDS = new Set(['skill', 'system', 'directory', 'security-tool']);
const PROVENANCE = new Set(['original', 'synthesis', 'inspired', 'adapted', 'linked']);
const AVAILABILITY = new Set(['available', 'planned', 'deprecated']);
const INSTALL_MODES = new Set(['managed-block', 'skill-copy', 'ambient', 'upstream', 'none']);
const SECURITY_STATES = new Set([
  'Unreviewed',
  'Source inspected',
  'Scanner passed',
  'Phewsh tested',
  'Maintainer verified',
  'Warning or deprecated',
]);

function readCatalog() {
  const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error('Unsupported skills catalog');
  }
  return parsed.entries;
}

function validateCatalog(entries = readCatalog()) {
  const ids = new Set();
  for (const entry of entries) {
    for (const field of [
      'id',
      'name',
      'summary',
      'category',
      'kind',
      'provenance',
      'creator',
      'attribution',
      'source',
      'license',
      'availability',
      'install_mode',
      'install_command',
      'supported_harnesses',
      'dependencies',
      'security_status',
      'tested_on',
      'test_evidence',
      'last_checked',
      'related_entries',
      'source_path',
    ]) {
      if (!(field in entry)) throw new Error(`${entry.id || 'entry'} missing ${field}`);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id)) throw new Error(`Invalid catalog id: ${entry.id}`);
    if (ids.has(entry.id)) throw new Error(`Duplicate catalog id: ${entry.id}`);
    ids.add(entry.id);
    if (!CATEGORIES.has(entry.category)) throw new Error(`${entry.id} has invalid category`);
    if (!KINDS.has(entry.kind)) throw new Error(`${entry.id} has invalid kind`);
    if (!PROVENANCE.has(entry.provenance)) throw new Error(`${entry.id} has invalid provenance`);
    if (!AVAILABILITY.has(entry.availability)) throw new Error(`${entry.id} has invalid availability`);
    if (!INSTALL_MODES.has(entry.install_mode)) throw new Error(`${entry.id} has invalid install mode`);
    if (!SECURITY_STATES.has(entry.security_status)) throw new Error(`${entry.id} has invalid security state`);
    if (!Array.isArray(entry.supported_harnesses)
      || !Array.isArray(entry.dependencies)
      || !Array.isArray(entry.related_entries)) {
      throw new Error(`${entry.id} has invalid list fields`);
    }
    if (entry.provenance === 'linked' && entry.security_status !== 'Unreviewed') {
      throw new Error(`${entry.id} must start unreviewed`);
    }
    if (entry.security_status === 'Phewsh tested' && (!entry.tested_on || !entry.test_evidence)) {
      throw new Error(`${entry.id} needs dated test evidence`);
    }
    if (entry.availability === 'planned' && (entry.install_mode !== 'none' || entry.install_command)) {
      throw new Error(`${entry.id} cannot be installable while planned`);
    }
    if (entry.source_path) {
      const sourceFile = path.join(__dirname, '..', entry.source_path);
      if (!fs.existsSync(sourceFile)) throw new Error(`${entry.id} source path does not exist`);
    }
  }
  for (const entry of entries) {
    for (const dependency of entry.dependencies) {
      if (!ids.has(dependency)) throw new Error(`${entry.id} has unknown dependency ${dependency}`);
    }
    for (const related of entry.related_entries) {
      if (!ids.has(related)) throw new Error(`${entry.id} has unknown related entry ${related}`);
    }
  }
  return true;
}

const ENTRIES = readCatalog();
validateCatalog(ENTRIES);

function listCatalog({ view = 'atlas' } = {}) {
  if (view === 'atlas') return ENTRIES.map(entry => ({ ...entry }));
  if (view === 'packs') {
    return ENTRIES
      .filter(entry => entry.availability === 'available')
      .filter(entry => ['managed-block', 'skill-copy', 'upstream'].includes(entry.install_mode))
      .map(entry => ({ ...entry }));
  }
  throw new Error(`Unknown catalog view: ${view}`);
}

function getCatalogEntry(id) {
  const entry = ENTRIES.find(candidate => candidate.id === id);
  return entry ? { ...entry } : null;
}

module.exports = {
  CATALOG_FILE,
  getCatalogEntry,
  listCatalog,
  validateCatalog,
};
