export type Links = Partial<Record<LinkKey, string>>;
export type LinkKey =
  | 'apple' | 'genius' | 'youtube' | 'wikipedia' | 'musicbrainz' | 'discogs'
  | 'rym' | 'aoty' | 'spotify' | 'deezer' | 'instagram' | 'website' | 'pitchfork' | 'metacritic' | 'soundcloud';

export interface Ext {
  mbid?: string;          // MusicBrainz artist / release-group id
  apple_id?: number;      // iTunes artistId / collectionId / trackId
  deezer_id?: number;
  genius_id?: number;
  youtube_id?: string;    // video id or playlist id (prefixed "PL")
  [k: string]: unknown;
}

export interface Artist {
  id: string; name: string; is_producer: boolean;
  image_url?: string | null; bio?: string | null; aliases: string[];
  links: Links; ext: Ext; created_at?: string; updated_at?: string;
}

export interface Release {
  id: string; title: string; type: string; date?: string | null; year?: number | null;
  artist_credit?: string | null; artwork_url?: string | null; label?: string | null;
  source: string; links: Links; ext: Ext; created_at?: string; updated_at?: string;
}

export interface Track {
  id: string; release_id?: string | null; disc?: number | null; number?: number | null;
  title: string; artist_credit?: string | null; duration_ms?: number | null;
  links: Links; ext: Ext; created_at?: string; updated_at?: string;
}

export type CreditRole = 'primary' | 'featured' | 'producer' | 'exec_producer';
export interface Credit {
  id: string; artist_id: string; release_id?: string | null; track_id?: string | null;
  role: CreditRole; position: number;
}

export type EntityType = 'artist' | 'release' | 'track' | 'label';
export interface Annotation {
  id: string; entity_type: EntityType; entity_id: string;
  rating?: number | null; favorite: boolean; review?: string | null; notes?: string | null;
  updated_at?: string;
}

export interface CriticScore {
  id: string; release_id: string; source: string; score?: number | null; max: number; url?: string | null;
}

export interface List { id: string; name: string; description?: string | null; ranked: boolean; kind?: 'list' | 'playlist'; cover_url?: string | null; custom_order?: boolean; created_at?: string; updated_at?: string }
export interface ListItem {
  id: string; list_id: string; entity_type: EntityType | 'text'; entity_id?: string | null;
  label?: string | null; position: number; note?: string | null;
}

export interface Concert {
  id: string; date?: string | null; location?: string | null; venue?: string | null; tour?: string | null;
  artist_id?: string | null; artist_credit?: string | null; support?: string | null;
  rating?: number | null; review?: string | null;
}

export interface Label {
  id: string; name: string; aliases: string[]; image_url?: string | null; bio?: string | null;
  links: Links; ext: Ext; created_at?: string; updated_at?: string;
}
export interface ReleaseLabel { id: string; release_id: string; label_id: string }
export interface ArtistLabel { id: string; artist_id: string; label_id: string }

export interface Tables {
  artists: Artist; releases: Release; tracks: Track; credits: Credit; annotations: Annotation;
  critic_scores: CriticScore; lists: List; list_items: ListItem; concerts: Concert;
  labels: Label; release_labels: ReleaseLabel; artist_labels: ArtistLabel;
}
export type TableName = keyof Tables;
export const TABLES: TableName[] = ['artists', 'releases', 'tracks', 'credits', 'annotations', 'critic_scores', 'lists', 'list_items', 'concerts', 'labels', 'release_labels', 'artist_labels'];
export type DataSet = { [K in TableName]: Tables[K][] };

export const RELEASE_TYPES = [
  'Album', 'Mixtape', 'EP', 'Single', 'Collaboration', 'Compilation', 'Deluxe', 'Soundtrack',
  'Live', 'Greatest Hits', 'Leak', 'Leak Compilation', 'Unreleased Album', 'Guest Appearance', 'Other',
];
