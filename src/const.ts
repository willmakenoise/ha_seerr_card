export const CARD_VERSION = '0.2.1';

// Delay after the last keystroke before firing a search, in milliseconds.
export const SEARCH_DEBOUNCE_MS = 350;

// Seeded into the "Edit card" dialog's live preview so config changes are
// visible without typing a query. Returns both movie and TV results.
export const PREVIEW_SEARCH_QUERY = 'batman';

// Overseerr/Seerr only return a path relative to TMDB's public image CDN, not
// a full URL — the card builds it directly rather than proxying through HA.
export const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/';

export type ThumbnailSize = 'small' | 'medium' | 'large';

// "small" keeps the original compact icon-replacement look: a cropped square,
// not a true poster shape. "medium"/"large" use TMDB's real 2:3 poster aspect
// ratio (e.g. w200 is natively 200×300), so object-fit: cover doesn't crop
// anything — the full poster shows. Each tmdbSize is chosen to comfortably
// cover ~2x the display size for retina screens without over-fetching.
export const THUMBNAIL_SIZES: Record<ThumbnailSize, { width: number; height: number; tmdbSize: string }> = {
  small: { width: 40, height: 40, tmdbSize: 'w92' },
  medium: { width: 60, height: 90, tmdbSize: 'w154' },
  large: { width: 100, height: 150, tmdbSize: 'w200' },
};

// Grid layout tiles size themselves from the card's own height rather than
// following thumbnail_size (designed for the fixed-size list-row thumb) —
// this is a single size generous enough to stay sharp at typical tile
// widths without over-fetching.
export const TILE_POSTER_TMDB_SIZE = 'w342';

// show_thumbnails: false behaves the same as thumbnail_size: 'small' for
// every size-dependent decision (list row height, whether show_overview is
// available) — this is the one place that equivalence is expressed.
export function getEffectiveThumbnailSize(config: {
  show_thumbnails?: boolean;
  thumbnail_size?: ThumbnailSize;
}): ThumbnailSize {
  if (config.show_thumbnails === false) {
    return 'small';
  }
  return config.thumbnail_size ?? 'medium';
}
