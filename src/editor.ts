import { LitElement, html, TemplateResult, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { HomeAssistant, fireEvent, LovelaceCardEditor } from 'custom-card-helpers';

import type { SeerrRequestCardConfig } from './types';
import { localize } from './localize/localize';

@customElement('seerr-request-card-editor')
export class SeerrRequestCardEditor extends LitElement implements LovelaceCardEditor {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private _config?: SeerrRequestCardConfig;

  public setConfig(config: SeerrRequestCardConfig): void {
    this._config = { ...config };
  }

  protected render(): TemplateResult {
    if (!this.hass || !this._config) {
      return html`<div>Loading…</div>`;
    }

    return html`
      <ha-selector
        .hass=${this.hass}
        .selector=${{ config_entry: { integration: 'overseerr' } }}
        .value=${this._config.config_entry_id || ''}
        label=${localize('editor.seerr_instance')}
        required
        .configValue=${'config_entry_id'}
        @value-changed=${this._selectorChanged}
      ></ha-selector>
      <ha-input
        .value=${this._config.name || ''}
        .label=${localize('editor.name')}
        @input=${this._nameChanged}
      ></ha-input>
    `;
  }

  private _selectorChanged(ev: CustomEvent): void {
    if (!this._config || !this.hass) {
      return;
    }
    const target = ev.target as EventTarget & { configValue?: keyof SeerrRequestCardConfig };
    if (!target.configValue) {
      return;
    }

    this._config = { ...this._config, [target.configValue]: ev.detail.value };
    fireEvent(this, 'config-changed', { config: this._config });
  }

  private _nameChanged(ev: Event): void {
    if (!this._config || !this.hass) {
      return;
    }

    this._config = { ...this._config, name: (ev.target as { value?: string }).value ?? '' };
    fireEvent(this, 'config-changed', { config: this._config });
  }

  static get styles() {
    return css`
      ha-selector,
      ha-input {
        display: block;
        margin-bottom: 16px;
      }
    `;
  }
}
