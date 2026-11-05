import { LitElement, html, TemplateResult, css, CSSResultGroup, PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { HomeAssistant, LovelaceCardEditor } from 'custom-card-helpers';

import {
  OverseerrMediaStatus,
  type SeerrRequestCardConfig,
  type SeerrResultItem,
  type OverseerrSearchResponse,
  type LovelaceGridOptions,
} from './types';
import {
  SEARCH_DEBOUNCE_MS,
  TMDB_IMAGE_BASE_URL,
  THUMBNAIL_SIZES,
  TILE_POSTER_TMDB_SIZE,
  PREVIEW_SEARCH_QUERY,
  getEffectiveThumbnailSize,
} from './const';
import { localize } from './localize/localize';

// hui-card rebuilds the card element on every config change while in the
// edit dialog's preview (even per keystroke in the Name field), so share one
// demo search per Seerr instance instead of re-searching each rebuild.
const previewResults = new Map<string, Promise<SeerrResultItem[]>>();

// The "Edit card" dialog renders its own throwaway copy of the card for the
// live preview. Unlike the `preview` property — which views also set on the
// real dashboard cards in edit mode — this is never true for a card that's
// actually on the dashboard.
function isInEditCardDialog(element: Element): boolean {
  let node: Node | null = element;
  while (node) {
    if (node instanceof Element && node.localName === 'hui-dialog-edit-card') {
      return true;
    }
    node = node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode;
  }
  return false;
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'seerr-request-card',
  name: 'Seerr Request Card',
  description: 'Search for movies and TV shows and request them in Seerr/Overseerr.',
  preview: true,
  documentationURL: 'https://github.com/willmakenoise/ha_seerr_card',
});

@customElement('seerr-request-card')
export class SeerrRequestCard extends LitElement {
  public static async getConfigElement(): Promise<LovelaceCardEditor> {
    await import('./editor');
    return document.createElement('seerr-request-card-editor');
  }

  public static async getStubConfig(hass: HomeAssistant): Promise<Record<string, unknown>> {
    // Auto-select the Overseerr config entry when there's exactly one, so the
    // card is usable immediately after adding it, before opening the editor.
    try {
      const entries = await hass.connection.sendMessagePromise<Array<{ entry_id: string }>>({
        type: 'config_entries/get',
        domain: 'overseerr',
      });
      return { config_entry_id: entries.length === 1 ? entries[0].entry_id : '' };
    } catch {
      return { config_entry_id: '' };
    }
  }

  public getGridOptions(): LovelaceGridOptions {
    const minColumns = this._minColumns();
    const minRows = this._minRows();
    return {
      min_columns: minColumns,
      rows: minRows,
      min_rows: minRows,
    };
  }

  private _minColumns(): number {
    if (this.config.content_layout === 'grid') {
      return 4;
    }
    return 8;
  }

  private _minRows(): number {
    if (this.config.content_layout === 'grid') {
      // The title header costs almost exactly one row's worth of height, so
      // this doesn't need its own "no title" case beyond the ?: below.
      return this.config.name ? 5 : 4;
    }
    if (getEffectiveThumbnailSize(this.config) === 'small') {
      // The small thumb is short enough to fit one row less comfortably.
      return this.config.name ? 4 : 3;
    }
    return this.config.name ? 5 : 4;
  }

  // Used for Masonry-view column balancing. One unit ≈ 50px; the search field
  // is about two units tall and each result row about one.
  public getCardSize(): number {
    if (this.config.content_layout === 'grid') {
      // Single horizontally-scrolling row of 2:3 poster tiles — height no
      // longer grows with result count.
      return 7;
    }
    return 2 + this._results.length;
  }

  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private config!: SeerrRequestCardConfig;
  @state() private _query = '';
  @state() private _results: SeerrResultItem[] = [];
  @state() private _loading = false;
  @state() private _error: string | null = null;
  @state() private _requestingId: number | null = null;
  @state() private _requestedIds: Set<number> = new Set();
  // Posters that failed to load (bad path, CDN hiccup) — fall back to the icon
  // instead of showing a broken-image glyph.
  @state() private _failedPosterIds: Set<number> = new Set();

  private _searchTimeout?: ReturnType<typeof setTimeout>;
  // Guards against a slower, older search response overwriting the results
  // of a newer one that happened to resolve first.
  private _searchToken = 0;
  private _inEditCardDialog = false;
  private _previewSeeded = false;

  public setConfig(config: SeerrRequestCardConfig): void {
    if (!config) {
      throw new Error(localize('common.invalid_configuration'));
    }

    this.config = {
      show_thumbnails: true,
      thumbnail_size: 'medium',
      content_layout: 'list',
      ...config,
    };
  }

  public connectedCallback(): void {
    super.connectedCallback();
    this._inEditCardDialog = isInEditCardDialog(this);
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._searchTimeout) {
      clearTimeout(this._searchTimeout);
    }
  }

  protected updated(changedProps: PropertyValues<this>): void {
    super.updated(changedProps);
    if (this._inEditCardDialog && !this._previewSeeded && this.hass && this.config.config_entry_id) {
      this._previewSeeded = true;
      this._seedPreview();
    }
  }

  private async _seedPreview(): Promise<void> {
    const entryId = this.config.config_entry_id;
    let pending = previewResults.get(entryId);
    if (!pending) {
      pending = this._fetchResults(PREVIEW_SEARCH_QUERY);
      previewResults.set(entryId, pending);
      pending.catch(() => previewResults.delete(entryId));
    }

    const token = ++this._searchToken;
    this._query = PREVIEW_SEARCH_QUERY;
    this._loading = true;
    try {
      const results = await pending;
      if (token === this._searchToken) {
        this._results = results;
      }
    } catch {
      // Leave the preview empty; the search field still works normally.
    } finally {
      if (token === this._searchToken) {
        this._loading = false;
      }
    }
  }

  protected render(): TemplateResult {
    if (!this.hass) {
      return this._renderSkeleton();
    }

    if (!this.config.config_entry_id) {
      return this._showError(localize('card.no_config_entry'));
    }

    const hasSearched = this._query.trim().length > 0;
    const showNoResults = hasSearched && !this._loading && !this._error && this._results.length === 0;

    return html`
      <ha-card .header=${this.config.name}>
        <div class="card-content">
          <ha-input-search
            class="search-field"
            appearance="outlined"
            .value=${this._query}
            .placeholder=${localize('card.search_placeholder')}
            @input=${this._onInput}
          ></ha-input-search>

          ${this._loading ? html`<ha-circular-progress indeterminate size="small"></ha-circular-progress>` : ''}
          ${this._error ? html`<div class="error">${this._error}</div>` : ''}
          ${
            showNoResults
              ? html`<div class="no-results">${localize('card.no_results').replace('{query}', this._query)}</div>`
              : ''
          }

          <div class="results ${this.config.content_layout === 'grid' ? 'layout-grid' : ''}">
            ${this._renderResultsList()}
          </div>
        </div>
      </ha-card>
    `;
  }

  private _renderSkeleton(): TemplateResult {
    return html`
      <ha-card>
        <div class="card-content skeleton-content">
          <div class="skeleton skeleton-field"></div>
        </div>
      </ha-card>
    `;
  }

  private _renderResultsList(): TemplateResult {
    if (this.config.content_layout !== 'grid') {
      return html`${this._results.map((item) => this._renderRow(item))}`;
    }
    // Each tile has a fixed width and snaps individually, so however many
    // fit side by side is purely a function of the card's rendered width —
    // no JS-side pagination/grouping needed.
    return html`${this._results.map((item) => this._renderTile(item))}`;
  }

  // Shared between both layouts: title/status/button-label logic is the same
  // either way, only the markup around it differs.
  private _resultViewModel(item: SeerrResultItem) {
    const isRequesting = this._requestingId === item.id;
    const isRequested = this._requestedIds.has(item.id);
    // Overseerr's create-request endpoint returns a different (unparseable) response
    // shape for media it already knows about, so we avoid calling it for those items.
    const existingStatus = this._statusLabel(item);
    const disabled = isRequesting || isRequested || existingStatus !== null;

    let buttonLabel = localize('card.request');
    if (isRequested) {
      buttonLabel = localize('card.requested');
    } else if (isRequesting) {
      buttonLabel = '…';
    } else if (existingStatus) {
      buttonLabel = existingStatus;
    }

    return {
      title: this._titleOf(item),
      meta: this._metaOf(item),
      year: this._yearOf(item),
      overview: item.overview,
      buttonLabel,
      disabled,
    };
  }

  // Single-column list row: thumb + title/meta + button side by side.
  private _renderRow(item: SeerrResultItem): TemplateResult {
    const vm = this._resultViewModel(item);
    // Drives the container box size for every row uniformly (even icon
    // fallbacks), so the list doesn't get jagged row heights.
    const effectiveThumbnailSize = getEffectiveThumbnailSize(this.config);
    const size = THUMBNAIL_SIZES[effectiveThumbnailSize];
    const posterUrl = this._posterUrl(item, size.tmdbSize);
    // The small thumb is a cropped icon-replacement, too little a visual
    // anchor for an adjacent multi-line description — only show it alongside
    // the bigger, true-poster-shaped sizes.
    const showOverview = this.config.show_overview && effectiveThumbnailSize !== 'small' && !!vm.overview;

    return html`
      <div class="result">
        <div class="result-thumb" style=${`width: ${size.width}px; height: ${size.height}px;`}>
          ${
            posterUrl
              ? html`
                  <img
                    class="result-poster"
                    src=${posterUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    width=${size.width}
                    height=${size.height}
                    @error=${() => this._onPosterError(item.id)}
                  />
                `
              : html`<ha-icon icon=${this._mediaIcon(item)}></ha-icon>`
          }
        </div>
        <div class="result-info">
          <div class="result-title">${vm.title}</div>
          <div class="result-meta">${vm.meta}</div>
          ${showOverview ? html`<div class="result-overview">${vm.overview}</div>` : ''}
        </div>
        <button class="request-button" ?disabled=${vm.disabled} @click=${() => this._requestMedia(item)}>
          ${vm.buttonLabel}
        </button>
      </div>
    `;
  }

  // Grid tile: poster fills the tile; title/year/button only show on
  // hover/focus, over a blurred, dimmed copy of the poster — avoids fixed-width
  // row content (button, thumb) overflowing a narrow grid column.
  private _renderTile(item: SeerrResultItem): TemplateResult {
    const vm = this._resultViewModel(item);
    const posterUrl = this._posterUrl(item, TILE_POSTER_TMDB_SIZE);
    const showOverview = this.config.show_overview && !!vm.overview;

    return html`
      <div class="result-tile">
        ${
          posterUrl
            ? html`
                <img
                  class="tile-media"
                  src=${posterUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  @error=${() => this._onPosterError(item.id)}
                />
              `
            : html`
                <div class="tile-media tile-icon-fallback">
                  <ha-icon icon=${this._mediaIcon(item)}></ha-icon>
                </div>
              `
        }
        <div class="tile-badge">${this._mediaTypeLabel(item)}</div>
        <div class="tile-overlay">
          ${vm.year ? html`<div class="tile-year">${vm.year}</div>` : ''}
          <div class="tile-title">${vm.title}</div>
          ${showOverview ? html`<div class="tile-overview">${vm.overview}</div>` : ''}
          <button class="tile-request-button" ?disabled=${vm.disabled} @click=${() => this._requestMedia(item)}>
            ${vm.buttonLabel}
          </button>
        </div>
      </div>
    `;
  }

  // Null whenever a poster shouldn't be shown: thumbnails disabled, no
  // poster_path from Overseerr (older python_overseerr, or TMDB has none for
  // this title), or a previous load of this exact poster already failed.
  private _posterUrl(item: SeerrResultItem, tmdbSize: string): string | null {
    if (this.config.show_thumbnails === false) {
      return null;
    }
    if (!item.poster_path || this._failedPosterIds.has(item.id)) {
      return null;
    }
    return `${TMDB_IMAGE_BASE_URL}${tmdbSize}${item.poster_path}`;
  }

  private _onPosterError(id: number): void {
    this._failedPosterIds = new Set(this._failedPosterIds).add(id);
  }

  private _statusLabel(item: SeerrResultItem): string | null {
    switch (item.media_info?.status) {
      case OverseerrMediaStatus.AVAILABLE:
        return localize('card.status_available');
      case OverseerrMediaStatus.PARTIALLY_AVAILABLE:
        return localize('card.status_partially_available');
      case OverseerrMediaStatus.PROCESSING:
        return localize('card.status_processing');
      case OverseerrMediaStatus.PENDING:
        return localize('card.status_pending');
      default:
        return null;
    }
  }

  private _titleOf(item: SeerrResultItem): string {
    return item.media_type === 'movie' ? item.original_title || item.title : item.original_name || item.name;
  }

  private _mediaTypeLabel(item: SeerrResultItem): string {
    return item.media_type === 'movie' ? localize('card.media_type_movie') : localize('card.media_type_tv');
  }

  private _mediaIcon(item: SeerrResultItem): string {
    return item.media_type === 'movie' ? 'mdi:movie-open' : 'mdi:television-classic';
  }

  private _metaOf(item: SeerrResultItem): string {
    const year = this._yearOf(item);
    const label = item.media_type === 'movie' ? localize('card.movie') : localize('card.tv_show');
    return year ? `${label} · ${year}` : label;
  }

  private _yearOf(item: SeerrResultItem): string | null {
    const date = item.media_type === 'movie' ? item.release_date : item.first_air_date;
    return date?.slice(0, 4) || null;
  }

  private _onInput(ev: Event): void {
    this._query = (ev.target as { value?: string }).value ?? '';

    if (this._searchTimeout) {
      clearTimeout(this._searchTimeout);
    }
    this._searchTimeout = setTimeout(() => this._search(), SEARCH_DEBOUNCE_MS);
  }

  private async _search(): Promise<void> {
    const query = this._query.trim();
    // Bump the token even on a cleared query, so a slow in-flight response
    // from a previous, now-abandoned search can't repopulate the results.
    const token = ++this._searchToken;

    if (!query) {
      this._results = [];
      this._error = null;
      return;
    }

    this._loading = true;
    this._error = null;

    try {
      const results = await this._fetchResults(query);
      if (token !== this._searchToken) {
        // A newer search has since started; discard this stale response.
        return;
      }
      this._results = results;
    } catch (err) {
      if (token !== this._searchToken) {
        return;
      }
      this._error = err instanceof Error ? err.message : localize('card.search_failed');
      this._results = [];
    } finally {
      if (token === this._searchToken) {
        this._loading = false;
      }
    }
  }

  private async _fetchResults(query: string): Promise<SeerrResultItem[]> {
    const { response } = await this.hass.connection.sendMessagePromise<OverseerrSearchResponse>({
      type: 'call_service',
      domain: 'overseerr',
      service: 'search_media',
      service_data: {
        config_entry_id: this.config.config_entry_id,
        query,
      },
      return_response: true,
    });
    return response.results.filter(
      (result): result is SeerrResultItem => result.media_type === 'movie' || result.media_type === 'tv',
    );
  }

  private async _requestMedia(item: SeerrResultItem): Promise<void> {
    this._requestingId = item.id;

    try {
      await this.hass.connection.sendMessagePromise({
        type: 'call_service',
        domain: 'overseerr',
        service: 'request_media',
        service_data: {
          config_entry_id: this.config.config_entry_id,
          media_type: item.media_type,
          media_id: item.id,
        },
        return_response: true,
      });

      this._requestedIds = new Set(this._requestedIds).add(item.id);
      this._fireNotification(localize('card.request_success').replace('{title}', this._titleOf(item)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._fireNotification(
        localize('card.request_failure').replace('{title}', this._titleOf(item)).replace('{error}', message),
      );
    } finally {
      this._requestingId = null;
    }
  }

  private _fireNotification(message: string): void {
    this.dispatchEvent(
      new CustomEvent('hass-notification', {
        detail: { message },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _showError(error: string): TemplateResult {
    const errorCard = document.createElement('hui-error-card');
    errorCard.setConfig({
      type: 'error',
      error,
      origConfig: this.config,
    });

    return html` ${errorCard} `;
  }

  static get styles(): CSSResultGroup {
    return css`
      :host {
        display: block;
        height: 100%;
      }

      ha-card {
        height: 100%;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .card-content {
        flex: 1;
        min-height: 0;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .search-field {
        width: 100%;
        flex-shrink: 0;
      }

      .error {
        color: var(--error-color);
        font-size: 14px;
        flex-shrink: 0;
      }

      .no-results {
        color: var(--secondary-text-color);
        font-size: 14px;
        flex-shrink: 0;
      }

      .results {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .results.layout-grid {
        /* flex-grow still fills whatever height the card is given (fixed
           row counts, Masonry's getCardSize()), but min-height provides a
           floor for "Auto height", which imposes no ancestor height at
           all — without it, flex-basis: auto has nothing non-circular to
           resolve against and collapses to 0. */
        flex: 1 1 auto;
        min-height: 162px;
        display: flex;
        flex-direction: row;
        overflow-x: auto;
        overflow-y: hidden;
        scroll-snap-type: x mandatory;
        /* Lets .tile-overview below query this container's own resolved
           height to decide how many overview lines fit comfortably. */
        container-type: size;
        container-name: grid-results;
      }

      .result-tile {
        position: relative;
        /* Height, not width, is the fixed dimension: height: 100% (an
           explicit percentage, not implicit flex-stretch) fills the
           results area's own height, and aspect-ratio derives the width
           from that — so how many tiles fit side by side grows with card
           width without distorting the poster shape. Deliberately explicit
           rather than relying on stretch to provide the cross size: WebKit
           (notably iOS Safari / the HA iOS app) doesn't reliably derive a
           flex item's main size from aspect-ratio + implicit stretch, and
           resolves it to a 0-width tile — i.e. nothing renders at all. */
        flex: 0 0 auto;
        height: 100%;
        aspect-ratio: 2 / 3;
        scroll-snap-align: start;
        border-radius: 8px;
        overflow: hidden;
        background: var(--secondary-background-color);
      }

      .tile-media {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        transition: filter 0.2s ease-in-out;
      }

      .tile-icon-fallback {
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--card-background-color);
        color: var(--secondary-text-color);
        --mdc-icon-size: 48px;
      }

      .result-tile:hover .tile-media,
      .result-tile:focus-within .tile-media {
        filter: blur(3px) brightness(0.45);
      }

      /* Styled to match ha-label's "dense" look (border/radius/colors/type
         scale) rather than using the real element — ha-label is only ever
         registered from Settings panels, not Lovelace, so it isn't
         reliably defined here. */
      .tile-badge {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 1;
        display: inline-flex;
        align-items: center;
        height: 20px;
        padding: 0 12px;
        box-sizing: border-box;
        border: 1px solid var(--outline-color);
        border-radius: var(--ha-border-radius-md);
        background-color: rgba(var(--rgb-primary-text-color), 0.15);
        color: var(--primary-text-color);
        font-size: var(--ha-font-size-s);
        font-weight: var(--ha-font-weight-medium);
        line-height: var(--ha-line-height-condensed);
        letter-spacing: 0.1px;
        text-wrap: nowrap;
      }

      .tile-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        gap: 4px;
        padding: 8px;
        background: linear-gradient(to top, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0.5) 55%, rgba(0, 0, 0, 0) 100%);
        opacity: 0;
        transition: opacity 0.2s ease-in-out;
        pointer-events: none;
      }

      .result-tile:hover .tile-overlay,
      .result-tile:focus-within .tile-overlay {
        opacity: 1;
        pointer-events: auto;
      }

      .tile-year {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.8);
      }

      .tile-title {
        font-size: 13px;
        font-weight: 600;
        color: #fff;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      .tile-overview {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.8);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      /* Sections view adds --ha-section-grid-row-height (56px, default) +
        --ha-section-grid-row-gap (8px, default) of card height per extra
        row — 64px — which flows straight through to this container's own
        height, so each tier below is exactly one row (64px) past the last,
        relative to the 162px floor above. */
      @container grid-results (min-height: 226px) {
        .tile-overview {
          -webkit-line-clamp: 3;
        }
      }

      @container grid-results (min-height: 290px) {
        .tile-overview {
          -webkit-line-clamp: 4;
        }
      }

      @container grid-results (min-height: 354px) {
        .tile-overview {
          -webkit-line-clamp: 5;
        }
      }

      .tile-request-button {
        margin-top: 4px;
        width: 100%;
        padding: 6px 0;
        border: none;
        border-radius: 16px;
        background: var(--primary-color);
        color: var(--text-primary-color);
        font-size: 11px;
        font-weight: 500;
        text-transform: uppercase;
        cursor: pointer;
      }

      .tile-request-button:disabled {
        opacity: 0.6;
        cursor: default;
      }

      .result {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px;
        border-radius: 8px;
        background: var(--secondary-background-color);
      }

      .result-thumb {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        flex-shrink: 0;
        border-radius: 6px;
        background: var(--card-background-color);
        color: var(--secondary-text-color);
        overflow: hidden;
      }

      .result-poster {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .result-info {
        flex: 1;
        min-width: 0;
      }

      .result-title {
        font-weight: 500;
        color: var(--primary-text-color);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .result-meta {
        font-size: 12px;
        color: var(--secondary-text-color);
      }

      .result-overview {
        font-size: 12px;
        color: var(--secondary-text-color);
        margin-top: 2px;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      .request-button {
        flex-shrink: 0;
        padding: 6px 12px;
        border: none;
        border-radius: 16px;
        background: var(--primary-color);
        color: var(--text-primary-color);
        font-size: 12px;
        font-weight: 500;
        text-transform: uppercase;
        cursor: pointer;
      }

      .request-button:disabled {
        opacity: 0.6;
        cursor: default;
      }

      .skeleton-content {
        pointer-events: none;
      }

      .skeleton {
        border-radius: 4px;
        background: var(--divider-color);
      }

      .skeleton-field {
        height: 40px;
      }
    `;
  }
}
