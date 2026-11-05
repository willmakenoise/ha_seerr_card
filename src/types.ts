import { LovelaceCard, LovelaceCardConfig, LovelaceCardEditor } from 'custom-card-helpers';
import type { ThumbnailSize } from './const';

declare global {
  interface HTMLElementTagNameMap {
    'seerr-request-card-editor': LovelaceCardEditor;
    'hui-error-card': LovelaceCard;
  }

  interface Window {
    customCards: Array<{
      type: string;
      name: string;
      description: string;
      preview?: boolean;
      documentationURL?: string;
    }>;
  }
}

// custom-card-helpers doesn't export this yet — shape matches
// LovelaceGridOptions in the frontend's panels/lovelace/types.ts.
export interface LovelaceGridOptions {
  columns?: number | 'full';
  rows?: number | 'auto';
  max_columns?: number;
  min_columns?: number;
  min_rows?: number;
  max_rows?: number;
}

export interface SeerrRequestCardConfig extends LovelaceCardConfig {
  type: string;
  name?: string;
  // The Overseerr/Seerr config entry to call services against. Required because
  // every overseerr.* service call needs it — see homeassistant/components/overseerr/services.py.
  config_entry_id: string;
  // Defaults to true. Requires python_overseerr 0.10.0+ (HA 2026.12+) for
  // poster_path to actually be populated; degrades gracefully to icons otherwise.
  show_thumbnails?: boolean;
  // Defaults to 'medium'. Only meaningful while show_thumbnails is true.
  thumbnail_size?: ThumbnailSize;
  // Defaults to 'list' (single-column list). 'grid' shows a horizontally
  // scrolling poster carousel, same naming as built-in cards' "Content
  // Layout" option.
  content_layout?: 'list' | 'grid';
  // Defaults to false. Shows a truncated excerpt of each result's
  // description between its title and the Request button.
  show_overview?: boolean;
}

// MediaStatus from python_overseerr/models.py — UNKNOWN means Overseerr has
// no record of the item yet, i.e. it's safe to request.
export enum OverseerrMediaStatus {
  UNKNOWN = 1,
  PENDING = 2,
  PROCESSING = 3,
  PARTIALLY_AVAILABLE = 4,
  AVAILABLE = 5,
}

export interface OverseerrMediaInfo {
  status: OverseerrMediaStatus;
}

// Shape of the objects returned inside the `results` array of the
// overseerr.search_media service response (see python_overseerr Movie/TV models).
// poster_path is a path relative to TMDB's image CDN, not a full URL — see
// posterUrl() in seerr-request-card.ts. Only present on python_overseerr
// 0.10.0+; absent/undefined on older versions, which we treat the same as
// "no poster available" rather than requiring a minimum version for it.
export interface OverseerrMovieResult {
  id: number;
  media_type: 'movie';
  title: string;
  original_title?: string;
  overview?: string;
  // Same python_overseerr 0.10.0+ gate as poster_path.
  release_date?: string | null;
  poster_path?: string | null;
  media_info?: OverseerrMediaInfo | null;
}

export interface OverseerrTVResult {
  id: number;
  media_type: 'tv';
  name: string;
  original_name?: string;
  overview?: string;
  first_air_date?: string;
  poster_path?: string | null;
  media_info?: OverseerrMediaInfo | null;
}

export interface OverseerrPersonResult {
  id: number;
  media_type: 'person';
  name: string;
}

// The card only ever deals with movie/TV results (person results are
// filtered out of the search response) — see SeerrRequestCard._search().
export type SeerrResultItem = OverseerrMovieResult | OverseerrTVResult;

export type OverseerrSearchResult = OverseerrMovieResult | OverseerrTVResult | OverseerrPersonResult;

export interface OverseerrSearchResponse {
  response: {
    results: OverseerrSearchResult[];
  };
}
