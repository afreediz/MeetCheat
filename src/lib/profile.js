/**
 * Profile storage: the user's identity, projects, and people worth watching for,
 * plus credentials. This is the input to both the local matcher and the prompts.
 *
 * Always chrome.storage.local — never .sync. The API key must not leave the
 * machine, and sync would replicate it through the user's Google account.
 */

import { STORAGE_KEY, TRIGGER_KIND, TUNING } from './constants.js';

/** @returns {import('./types.js').Profile} */
export function defaultProfile() {
  return {
    user: { name: '', aliases: [], role: '' },
    projects: [],
    people: [],
    triggers: {
      onName: true,
      onProject: true,
      onPeople: true,
      /** When true, only fire the notes call for questions aimed at the user. */
      questionOnly: false,
    },
    openai: {
      apiKey: '',
      // Small/fast tier by default. If this ID has moved on, the options page
      // lets the user correct it without a code change.
      notesModel: 'gpt-4.1-mini',
      summaryModel: 'gpt-4.1-mini',
      // gpt-transcribe is the model that accepts BOTH `keywords` (proper-noun
      // biasing — the thing that keeps "Afreedi" from landing as "Afridi") and
      // server-side VAD. The 4o-transcribe family has no keywords support, and
      // gpt-live-transcribe rejects turn_detection outright. If this ID is
      // changed to one without keywords, the transcriber degrades to prompt
      // biasing rather than failing.
      transcribeModel: 'gpt-transcribe',
    },
    sensitivity: TUNING.DEFAULT_SENSITIVITY,
    captureMic: true,
    soundEnabled: true,
    /** debug | info | warn | error — controls the panel's activity log. */
    logLevel: 'info',
  };
}

export async function loadProfile() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return mergeDefaults(stored[STORAGE_KEY]);
}

export async function saveProfile(profile) {
  await chrome.storage.local.set({ [STORAGE_KEY]: profile });
}

export function onProfileChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      cb(mergeDefaults(changes[STORAGE_KEY].newValue));
    }
  });
}

/** Shallow-merge stored data over defaults so added fields don't break old profiles. */
function mergeDefaults(stored) {
  const base = defaultProfile();
  if (!stored) return base;
  return {
    ...base,
    ...stored,
    user: { ...base.user, ...(stored.user ?? {}) },
    triggers: { ...base.triggers, ...(stored.triggers ?? {}) },
    openai: { ...base.openai, ...(stored.openai ?? {}) },
    projects: stored.projects ?? base.projects,
    people: stored.people ?? base.people,
  };
}

/**
 * Seed alias suggestions from a full name.
 *
 * Speech-to-text mangles proper nouns constantly, so the alias list is what
 * actually makes detection work. Seeding the obvious splits means the user
 * only has to add the genuinely weird manglings they hear in practice.
 */
export function seedAliases(name) {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return [];
  const parts = trimmed.split(/\s+/);
  const out = new Set([trimmed]);
  if (parts.length > 1) {
    out.add(parts[0]);
    out.add(parts[parts.length - 1]);
  }
  return [...out].filter((a) => a.length >= 2);
}

/**
 * Flatten the profile into the list the matcher scans against.
 *
 * @returns {Array<{kind: string, label: string, alias: string}>}
 */
export function buildTriggerSet(profile) {
  const out = [];
  const push = (kind, label, aliases) => {
    for (const alias of aliases ?? []) {
      const cleaned = (alias ?? '').trim();
      if (cleaned.length >= 2) out.push({ kind, label, alias: cleaned });
    }
  };

  if (profile.triggers.onName) {
    const aliases = profile.user.aliases?.length
      ? profile.user.aliases
      : seedAliases(profile.user.name);
    push(TRIGGER_KIND.NAME, profile.user.name || 'you', aliases);
  }

  if (profile.triggers.onProject) {
    for (const project of profile.projects) {
      const aliases = project.aliases?.length ? project.aliases : [project.name];
      push(TRIGGER_KIND.PROJECT, project.name, aliases);
    }
  }

  if (profile.triggers.onPeople) {
    for (const person of profile.people) {
      push(TRIGGER_KIND.PERSON, person.name, seedAliases(person.name));
    }
  }

  return out;
}

/**
 * Every distinct term worth biasing the transcriber toward. Realtime
 * transcription has no hard keyterm boosting, so this is only a soft hint —
 * the fuzzy matcher does the real work.
 */
export function vocabularyHints(profile) {
  const terms = new Set();
  for (const { alias } of buildTriggerSet(profile)) terms.add(alias);
  for (const project of profile.projects) terms.add(project.name);
  for (const person of profile.people) terms.add(person.name);
  if (profile.user.name) terms.add(profile.user.name);
  return [...terms].filter(Boolean);
}
