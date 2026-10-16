import type { EntityType } from './types';

export const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9$]+/g, ' ').trim();
export const annId = (t: EntityType, id: string) => `${t}:${id}`;
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
