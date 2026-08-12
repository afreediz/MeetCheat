/**
 * Options page — profile capture.
 *
 * The alias list is the highest-leverage field on this page: it's what turns a
 * mangled transcript into a hit. The UI leans on that rather than burying it.
 */

import { loadProfile, saveProfile, defaultProfile, seedAliases } from '../lib/profile.js';

const $ = (id) => document.getElementById(id);

const fields = {
  name: $('name'),
  aliases: $('aliases'),
  role: $('role'),
  onName: $('onName'),
  onProject: $('onProject'),
  onPeople: $('onPeople'),
  questionOnly: $('questionOnly'),
  soundEnabled: $('soundEnabled'),
  captureMic: $('captureMic'),
  sensitivity: $('sensitivity'),
  sensitivityOut: $('sensitivityOut'),
  logLevel: $('logLevel'),
  apiKey: $('apiKey'),
  notesModel: $('notesModel'),
  summaryModel: $('summaryModel'),
  transcribeModel: $('transcribeModel'),
};

const projectsEl = $('projects');
const peopleEl = $('people');

init();

async function init() {
  const profile = await loadProfile();
  render(profile);
  wire();
}

function render(p) {
  fields.name.value = p.user.name ?? '';
  fields.aliases.value = (p.user.aliases ?? []).join('\n');
  fields.role.value = p.user.role ?? '';

  fields.onName.checked = p.triggers.onName;
  fields.onProject.checked = p.triggers.onProject;
  fields.onPeople.checked = p.triggers.onPeople;
  fields.questionOnly.checked = p.triggers.questionOnly;
  fields.soundEnabled.checked = p.soundEnabled;
  fields.captureMic.checked = p.captureMic;

  fields.sensitivity.value = String(p.sensitivity);
  fields.sensitivityOut.textContent = Number(p.sensitivity).toFixed(2);
  fields.logLevel.value = p.logLevel ?? 'info';

  fields.apiKey.value = p.openai.apiKey ?? '';
  fields.notesModel.value = p.openai.notesModel ?? '';
  fields.summaryModel.value = p.openai.summaryModel ?? '';
  fields.transcribeModel.value = p.openai.transcribeModel ?? '';

  projectsEl.replaceChildren();
  for (const project of p.projects) addProjectRow(project);
  if (!p.projects.length) addProjectRow();

  peopleEl.replaceChildren();
  for (const person of p.people) addPersonRow(person);
  if (!p.people.length) addPersonRow();
}

function wire() {
  fields.sensitivity.addEventListener('input', () => {
    fields.sensitivityOut.textContent = Number(fields.sensitivity.value).toFixed(2);
  });

  $('seed').addEventListener('click', () => {
    const existing = splitLines(fields.aliases.value);
    const merged = [...new Set([...existing, ...seedAliases(fields.name.value)])];
    fields.aliases.value = merged.join('\n');
  });

  $('addProject').addEventListener('click', () => addProjectRow());
  $('addPerson').addEventListener('click', () => addPersonRow());
  $('save').addEventListener('click', onSave);
  $('test').addEventListener('click', onTestKey);
}

function addProjectRow(project = {}) {
  const node = $('projectRow').content.firstElementChild.cloneNode(true);
  node.querySelector('.p-name').value = project.name ?? '';
  node.querySelector('.p-aliases').value = (project.aliases ?? []).join(', ');
  node.querySelector('.p-desc').value = project.description ?? '';
  node.querySelector('.remove').addEventListener('click', () => node.remove());
  projectsEl.append(node);
}

function addPersonRow(person = {}) {
  const node = $('personRow').content.firstElementChild.cloneNode(true);
  node.querySelector('.q-name').value = person.name ?? '';
  node.querySelector('.q-rel').value = person.relation ?? 'manager';
  node.querySelector('.remove').addEventListener('click', () => node.remove());
  peopleEl.append(node);
}

function collect() {
  const base = defaultProfile();

  const projects = [...projectsEl.querySelectorAll('.row')]
    .map((row) => {
      const name = row.querySelector('.p-name').value.trim();
      const aliasText = row.querySelector('.p-aliases').value;
      const aliases = aliasText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        name,
        // Always keep the project's own name matchable, even if the user only
        // typed extra aliases.
        aliases: [...new Set([name, ...aliases])].filter(Boolean),
        description: row.querySelector('.p-desc').value.trim(),
      };
    })
    .filter((p) => p.name);

  const people = [...peopleEl.querySelectorAll('.row')]
    .map((row) => ({
      name: row.querySelector('.q-name').value.trim(),
      relation: row.querySelector('.q-rel').value,
    }))
    .filter((p) => p.name);

  const name = fields.name.value.trim();
  let aliases = splitLines(fields.aliases.value);
  // An empty alias list would silently disable name detection entirely, which
  // is the single most surprising way this could fail.
  if (!aliases.length && name) aliases = seedAliases(name);

  return {
    ...base,
    user: { name, aliases, role: fields.role.value.trim() },
    projects,
    people,
    triggers: {
      onName: fields.onName.checked,
      onProject: fields.onProject.checked,
      onPeople: fields.onPeople.checked,
      questionOnly: fields.questionOnly.checked,
    },
    openai: {
      apiKey: fields.apiKey.value.trim(),
      notesModel: fields.notesModel.value.trim() || base.openai.notesModel,
      summaryModel: fields.summaryModel.value.trim() || base.openai.summaryModel,
      transcribeModel: fields.transcribeModel.value.trim() || base.openai.transcribeModel,
    },
    sensitivity: Number(fields.sensitivity.value),
    logLevel: fields.logLevel.value,
    captureMic: fields.captureMic.checked,
    soundEnabled: fields.soundEnabled.checked,
  };
}

async function onSave() {
  const profile = collect();
  await saveProfile(profile);
  // Reflect any normalisation (seeded aliases, project name folded in).
  render(profile);
  flash($('saved'), 'Saved', 'ok');
}

/**
 * Verify the key before the user finds out mid-call. Deliberately hits the
 * cheap models endpoint rather than burning a completion.
 */
async function onTestKey() {
  const key = fields.apiKey.value.trim();
  const out = $('testResult');
  if (!key) return flash(out, 'Enter a key first', 'err', 4000);

  flash(out, 'Checking…', '', 30000);
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) flash(out, 'Key works', 'ok', 4000);
    else if (res.status === 401) flash(out, 'Key rejected (401)', 'err', 6000);
    else flash(out, `Unexpected response (${res.status})`, 'err', 6000);
  } catch (err) {
    flash(out, `Network error: ${err.message}`, 'err', 6000);
  }
}

function splitLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function flash(el, text, cls = '', ms = 2500) {
  el.textContent = text;
  el.className = `result ${cls}`.trim();
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.textContent = '';
    el.className = 'result';
  }, ms);
}
