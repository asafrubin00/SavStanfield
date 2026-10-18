import type { EntityType } from './types';

export const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9$]+/g, ' ').trim();
export const annId = (t: EntityType, id: string) => `${t}:${id}`;
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

/** Matching key for label names: "Def Jam Recordings" and "Def Jam" are the same label. */
export const labelKey = (s: string) => norm(s).replace(/\b(records|recordings|record company|entertainment|music group|music|inc|llc|ltd|limited|co)\b/g, ' ').replace(/\s+/g, ' ').trim() || norm(s);
