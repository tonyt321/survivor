import { randomUUID } from 'node:crypto';

export const STAT_KEYS = ['physical', 'mental', 'social', 'strategy'];

const LIMITS = { name: 40, bio: 500, personality: 300 };

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export const DEFAULT_CAST = [
  {
    id: 'dana-reyes',
    name: 'Dana Reyes',
    bio: 'Emergency room nurse who stays calm when everything is on fire. Has spent years reading people at their worst moments.',
    personality: 'Warm, observant, and quietly competitive. Hates being lied to.',
    stats: { physical: 6, mental: 7, social: 8, strategy: 6 },
  },
  {
    id: 'marcus-oyelaran',
    name: 'Marcus Oyelaran',
    bio: 'Former college wrestler who now coaches youth teams. Looks for the fight he knows he can win.',
    personality: 'Blunt, loyal to a fault, and slow to trust. Says exactly what he thinks.',
    stats: { physical: 9, mental: 4, social: 6, strategy: 4 },
  },
  {
    id: 'priya-natarajan',
    name: 'Priya Natarajan',
    bio: 'Patent attorney who treats every alliance like a contract with clauses.',
    personality: 'Analytical, precise, and always three moves ahead. Patient to the point of coldness.',
    stats: { physical: 4, mental: 9, social: 5, strategy: 8 },
  },
  {
    id: 'toby-finch',
    name: 'Toby Finch',
    bio: 'Street magician and cruise-ship entertainer who can make a stranger feel like an old friend in five minutes.',
    personality: 'Charming, playful, and a little too fond of misdirection.',
    stats: { physical: 4, mental: 6, social: 9, strategy: 7 },
  },
  {
    id: 'rosa-delgado',
    name: 'Rosa Delgado',
    bio: 'Beekeeper and farmer from a small town. Practical, patient, and tougher than she looks.',
    personality: 'Steady and kind, with a dry sense of humor. Keeps her word.',
    stats: { physical: 6, mental: 5, social: 7, strategy: 5 },
  },
  {
    id: 'kenji-mori',
    name: 'Kenji Mori',
    bio: 'Competitive puzzle gamer who has memorized more maps than he can count.',
    personality: 'Logical, awkward in big groups, and fiercely focused on the next challenge.',
    stats: { physical: 5, mental: 8, social: 3, strategy: 6 },
  },
  {
    id: 'hannah-brooks',
    name: 'Hannah Brooks',
    bio: 'Top-selling sales rep who has never accepted "no" as a final answer.',
    personality: 'Upbeat, persuasive, and quick to make promises. Keeps score of favors.',
    stats: { physical: 5, mental: 5, social: 9, strategy: 5 },
  },
  {
    id: 'gus-halloran',
    name: 'Gus Halloran',
    bio: 'Retired firefighter with 25 years of pulling people out of trouble.',
    personality: 'Gruff, protective of the underdog, and suspicious of anyone who talks too much.',
    stats: { physical: 8, mental: 5, social: 6, strategy: 3 },
  },
  {
    id: 'amara-osei',
    name: 'Amara Osei',
    bio: 'Podcast host who has interviewed hundreds of people and knows how to get them talking.',
    personality: 'Curious, articulate, and always taking a mental note on everyone.',
    stats: { physical: 4, mental: 6, social: 8, strategy: 7 },
  },
  {
    id: 'leo-varga',
    name: 'Leo Varga',
    bio: 'Forensic accountant who sees patterns in everything, and is not always wrong.',
    personality: 'Quiet, suspicious, and convinced someone is running a hidden game.',
    stats: { physical: 3, mental: 7, social: 2, strategy: 9 },
  },
];

export function allCharacters(custom = []) {
  return [
    ...DEFAULT_CAST.map((c) => ({ ...c, custom: false })),
    ...custom.map((c) => ({ ...c, custom: true })),
  ];
}

function requiredText(value, label, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new ValidationError(`${label} is required.`);
  if (text.length > max) throw new ValidationError(`${label} must be ${max} characters or fewer.`);
  return text;
}

function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Validates a castaway submitted by the user. `existing` is every character
// already in the library, so names and ids stay unique.
export function validateCharacter(input, existing = []) {
  if (!input || typeof input !== 'object') throw new ValidationError('Send a castaway object.');

  const name = requiredText(input.name, 'Name', LIMITS.name);
  const bio = requiredText(input.bio, 'Background', LIMITS.bio);
  const personality = requiredText(input.personality, 'Personality', LIMITS.personality);

  if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    throw new ValidationError(`There is already a castaway named ${name}.`);
  }

  const stats = {};
  for (const key of STAT_KEYS) {
    const value = Number(input.stats?.[key]);
    if (!Number.isInteger(value) || value < 1 || value > 10) {
      throw new ValidationError(`${key[0].toUpperCase()}${key.slice(1)} must be a whole number from 1 to 10.`);
    }
    stats[key] = value;
  }

  const taken = new Set(existing.map((c) => c.id));
  let id = slugify(name) || 'castaway';
  if (taken.has(id)) id = `${id}-${randomUUID().slice(0, 6)}`;

  return { id, name, bio, personality, stats };
}
