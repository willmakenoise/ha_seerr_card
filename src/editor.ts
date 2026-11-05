import { LitElement, html, TemplateResult, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { HomeAssistant, fireEvent, LovelaceCardEditor } from 'custom-card-helpers';
import { mdiTextShort } from '@mdi/js';

import type { SeerrRequestCardConfig } from './types';
import { getEffectiveThumbnailSize } from './const';
import { localize } from './localize/localize';

interface FormSchema {
  name: string;
  [key: string]: unknown;
}

// ha-form isn't guaranteed to be defined when a custom card's editor opens —
// HA only loads it alongside built-in editors. Loading the button card's
// editor (which imports ha-form, and accepts a config with no entity) pulls
// it in.
async function loadHaForm(): Promise<void> {
  if (customElements.get('ha-form')) {
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const helpers = await (window as any).loadCardHelpers();
  const card = await helpers.createCardElement({ type: 'button' });
  await card.constructor.getConfigElement();
}

@customElement('seerr-request-card-editor')
export class SeerrRequestCardEditor extends LitElement implements LovelaceCardEditor {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private _config?: SeerrRequestCardConfig;
  @state() private _formLoaded = false;

  private _schemaCache?: { key: string; schema: FormSchema[] };

  public setConfig(config: SeerrRequestCardConfig): void {
    this._config = { ...config };
  }

  public connectedCallback(): void {
    super.connectedCallback();
    loadHaForm().then(() => {
      this._formLoaded = true;
    });
  }

  protected render(): TemplateResult {
    if (!this.hass || !this._config || !this._formLoaded) {
      return html``;
    }

    const data = {
      content_layout: 'list',
      show_thumbnails: true,
      thumbnail_size: 'medium',
      show_overview: false,
      ...this._config,
    };

    return html`
      <ha-form
        .hass=${this.hass}
        .data=${data}
        .schema=${this._schema(this._config)}
        .computeLabel=${this._computeLabel}
        @value-changed=${this._valueChanged}
      ></ha-form>
    `;
  }

  private _schema(config: SeerrRequestCardConfig): FormSchema[] {
    const showThumbnailSize = config.show_thumbnails !== false && config.content_layout !== 'grid';
    const showOverview = this._overviewAvailable(config);
    const key = `${showThumbnailSize}|${showOverview}`;
    if (this._schemaCache?.key === key) {
      return this._schemaCache.schema;
    }

    const schema: FormSchema[] = [
      { name: 'config_entry_id', required: true, selector: { config_entry: { integration: 'overseerr' } } },
      {
        name: 'content',
        type: 'expandable',
        flatten: true,
        iconPath: mdiTextShort,
        schema: [
          { name: 'name', selector: { text: {} } },
          {
            name: 'content_layout',
            selector: {
              select: {
                mode: 'box',
                options: [
                  { value: 'list', label: localize('editor.content_layout_list') },
                  { value: 'grid', label: localize('editor.content_layout_grid') },
                ],
              },
            },
          },
          { name: 'show_thumbnails', selector: { boolean: {} } },
          ...(showThumbnailSize
            ? [
                {
                  name: 'thumbnail_size',
                  selector: {
                    select: {
                      mode: 'dropdown',
                      options: [
                        { value: 'small', label: localize('editor.thumbnail_size_small') },
                        { value: 'medium', label: localize('editor.thumbnail_size_medium') },
                        { value: 'large', label: localize('editor.thumbnail_size_large') },
                      ],
                    },
                  },
                },
              ]
            : []),
          ...(showOverview ? [{ name: 'show_overview', selector: { boolean: {} } }] : []),
        ],
      },
    ];
    this._schemaCache = { key, schema };
    return schema;
  }

  private _computeLabel = (schema: FormSchema): string => {
    if (schema.name === 'config_entry_id') {
      return localize('editor.seerr_instance');
    }
    return localize(`editor.${schema.name}`);
  };

  private _valueChanged(ev: CustomEvent): void {
    let config: SeerrRequestCardConfig = ev.detail.value;
    if (!this._overviewAvailable(config) && config.show_overview) {
      config = { ...config, show_overview: false };
    }
    this._config = config;
    fireEvent(this, 'config-changed', { config });
  }

  // Grid tiles always use their own fixed poster size, so thumbnail_size
  // doesn't apply there. The small list thumb is too little a visual
  // anchor for a multi-line overview, so that combination hides (and resets,
  // in _valueChanged) show_overview too.
  private _overviewAvailable(config: SeerrRequestCardConfig): boolean {
    return config.content_layout === 'grid' || getEffectiveThumbnailSize(config) !== 'small';
  }

  static get styles() {
    return css`
      ha-form {
        display: block;
      }
    `;
  }
}
