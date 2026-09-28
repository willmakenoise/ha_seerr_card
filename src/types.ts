import { LovelaceCard, LovelaceCardConfig, LovelaceCardEditor } from 'custom-card-helpers';

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
// Note: movies carry no release date and neither carries a poster — the
// underlying python_overseerr client library doesn't map those fields yet.
export interface OverseerrMovieResult {
  id: number;
  media_type: 'movie';
  title: string;
  overview?: string;
  media_info?: OverseerrMediaInfo | null;
}

export interface OverseerrTVResult {
  id: number;
  media_type: 'tv';
  name: string;
  overview?: string;
  first_air_date?: string;
  media_info?: OverseerrMediaInfo | null;
}

export interface OverseerrPersonResult {
  id: number;
  media_type: 'person';
  name: string;
}

export type OverseerrSearchResult = OverseerrMovieResult | OverseerrTVResult | OverseerrPersonResult;

export interface OverseerrSearchResponse {
  response: {
    results: OverseerrSearchResult[];
  };
}
