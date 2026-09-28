import { LitElement, html, TemplateResult, css, CSSResultGroup } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { HomeAssistant, LovelaceCardEditor } from 'custom-card-helpers';

import {
  OverseerrMediaStatus,
  type SeerrRequestCardConfig,
  type OverseerrMovieResult,
  type OverseerrTVResult,
  type OverseerrSearchResponse,
  type LovelaceGridOptions,
} from './types';
import { SEARCH_DEBOUNCE_MS } from './const';
import { localize } from './localize/localize';

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
    return {
      rows: 4,
      min_rows: this.config.name ? 4 : 3,
      max_rows: 12,
    };
  }

  // Used for Masonry-view column balancing. One unit ≈ 50px; the search field
  // is about two units tall and each result row about one.
  public getCardSize(): number {
    return 2 + this._results.length;
  }

  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private config!: SeerrRequestCardConfig;
  @state() private _query = '';
  @state() private _results: (OverseerrMovieResult | OverseerrTVResult)[] = [];
  @state() private _loading = false;
  @state() private _error: string | null = null;
  @state() private _requestingId: number | null = null;
  @state() private _requestedIds: Set<number> = new Set();

  private _searchTimeout?: ReturnType<typeof setTimeout>;
  // Guards against a slower, older search response overwriting the results
  // of a newer one that happened to resolve first.
  private _searchToken = 0;

  public setConfig(config: SeerrRequestCardConfig): void {
    if (!config) {
      throw new Error(localize('common.invalid_configuration'));
    }

    this.config = {
      name: 'Seerr Request Card',
      ...config,
    };
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._searchTimeout) {
      clearTimeout(this._searchTimeout);
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
            appearance="outline"
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

          <div class="results">${this._results.map((item) => this._renderResult(item))}</div>
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

  private _renderResult(item: OverseerrMovieResult | OverseerrTVResult): TemplateResult {
    const title = this._titleOf(item);
    const meta = this._metaOf(item);
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

    return html`
      <div class="result">
        <div class="result-thumb">
          <ha-icon icon=${item.media_type === 'movie' ? 'mdi:movie-open' : 'mdi:television-classic'}></ha-icon>
        </div>
        <div class="result-info">
          <div class="result-title">${title}</div>
          <div class="result-meta">${meta}</div>
        </div>
        <button class="request-button" ?disabled=${disabled} @click=${() => this._requestMedia(item)}>
          ${buttonLabel}
        </button>
      </div>
    `;
  }

  private _statusLabel(item: OverseerrMovieResult | OverseerrTVResult): string | null {
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

  private _titleOf(item: OverseerrMovieResult | OverseerrTVResult): string {
    return item.media_type === 'movie' ? item.title : item.name;
  }

  private _metaOf(item: OverseerrMovieResult | OverseerrTVResult): string {
    if (item.media_type === 'movie') {
      return localize('card.movie');
    }
    const year = item.first_air_date?.slice(0, 4);
    const tvShow = localize('card.tv_show');
    return year ? `${tvShow} · ${year}` : tvShow;
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

      if (token !== this._searchToken) {
        // A newer search has since started; discard this stale response.
        return;
      }

      this._results = response.results.filter(
        (result): result is OverseerrMovieResult | OverseerrTVResult =>
          result.media_type === 'movie' || result.media_type === 'tv',
      );
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

  private async _requestMedia(item: OverseerrMovieResult | OverseerrTVResult): Promise<void> {
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
