/**
 * The dsh-imagegen settings card.
 *
 * The plugin's generation channels, credentials and prompt-enhancement route
 * belong to the deployment, not to this card: models and the gateway endpoint
 * come from the host media catalog, and the prompt helper runs on the host
 * conversation model. What is left here is the handful of choices that are
 * genuinely local — whether Agents may generate, where the files land, and how
 * the infinite-canvas skills run.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { CardForm, booleanField, textField, type CardActions, type CardShell, type FieldState as CardFieldState } from './settings-form.ts'
import type { ImageGenScope } from './settings-scope.ts'
import { CANVAS_SKILL_API, PLUGIN_VERSION } from '../protocol.ts'
import type { ImageGenKey } from './locales.ts'
import { tt } from './helpers.ts'
import { useImageGenLanguageTick } from './use-language.ts'
import { OPEN_IMAGE_GEN_CONFIG_EVENT, takeImageGenConfigSection } from './config-entry.tsx'
import { PptSetup } from './PptSetup.tsx'
import { Select } from './Select.tsx'
import css from './settings-card.module.css'

/** The fields this card's staged form edits. */
export interface ImageGenSettings {
  enabled?: boolean
  announceToAgent?: boolean
  allowAgentImageGeneration?: boolean
  allowAgentVideoGeneration?: boolean
  localStoragePath?: string
  skillsEnabled?: boolean
  allowHeavySkills?: boolean
  skillAllowlist?: string
  skillOutputDir?: string
  skillHeavyTimeoutMinutes?: number
  skillAgentPreset?: string
}

/** What the card renders. */
export interface ImageGenSettingsCardState extends CardShell {
  /** Master switch. */
  enabled: CardFieldState
  /** System-prompt announcement flag. */
  announceToAgent: CardFieldState
  allowAgentImageGeneration: CardFieldState
  allowAgentVideoGeneration: CardFieldState
  localStoragePath: CardFieldState
  skillsEnabled: CardFieldState
  allowHeavySkills: CardFieldState
  skillAllowlist: CardFieldState
  skillOutputDir: CardFieldState
  skillHeavyTimeoutMinutes: CardFieldState
  skillAgentPreset: CardFieldState
}

/** The registration-side face the card's slot entry injects. */
export interface ImageGenSettingsCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useImageGenSettingsCard. */
    imageGenSettingsCard: SnapshotStore<ImageGenSettingsCardState>
  }
}

/** Bridges the imagegen scope onto the card's staged forms. */
export class ImageGenSettingsCardController {
  private readonly form: CardForm<ImageGenSettings>

  /** @param scope - the bound bridge scope for the dsh-imagegen namespace. */
  constructor(private readonly scope: ImageGenScope) {
    this.form = new CardForm(scope, [
      booleanField('enabled'),
      booleanField('announceToAgent'),
      booleanField('allowAgentImageGeneration'),
      booleanField('allowAgentVideoGeneration'),
      textField('localStoragePath'),
      booleanField('skillsEnabled'),
      booleanField('allowHeavySkills'),
      textField('skillAllowlist'),
      textField('skillOutputDir'),
      textField('skillHeavyTimeoutMinutes'),
      textField('skillAgentPreset'),
    ])
  }

  private projection(): ImageGenSettingsCardState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      announceToAgent: this.form.field('announceToAgent'),
      allowAgentImageGeneration: this.form.field('allowAgentImageGeneration'),
      allowAgentVideoGeneration: this.form.field('allowAgentVideoGeneration'),
      localStoragePath: this.form.field('localStoragePath'),
      skillsEnabled: this.form.field('skillsEnabled'),
      allowHeavySkills: this.form.field('allowHeavySkills'),
      skillAllowlist: this.form.field('skillAllowlist'),
      skillOutputDir: this.form.field('skillOutputDir'),
      skillHeavyTimeoutMinutes: this.form.field('skillHeavyTimeoutMinutes'),
      skillAgentPreset: this.form.field('skillAgentPreset'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and the staged-form actions.
   */
  inject(): ImageGenSettingsCardFace {
    return {
      hooks: {
        imageGenSettingsCard: this.form.bind(() => this.projection()),
      },
      ...this.form.actions(),
    }
  }
}

/** Props the renderer binds for this Settings navigation section. */
export type ImageGenSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'dsh-imagegen'>
  & InjectFace<ImageGenSettingsCardFace>

type SettingsSectionId = 'general' | 'storage' | 'skills' | 'ppt' | null

/** One mutually-exclusive settings group. */
function SettingsSection(props: {
  id: Exclude<SettingsSectionId, null>
  title: string
  hint: string
  summary: string
  tone?: 'neutral' | 'ready' | 'attention'
  expanded: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const contentId = `dsh-imagegen-settings-${props.id}`
  return (
    <section className={css.settingsSection} data-open={props.expanded ? '' : undefined}>
      <button
        type="button"
        className={css.sectionToggle}
        aria-expanded={props.expanded}
        aria-controls={contentId}
        onClick={props.onToggle}
      >
        <span className={css.sectionToggleText}>
          <span className={css.sectionToggleTitle}>{props.title}</span>
          <span className={css.sectionToggleHint}>{props.hint}</span>
        </span>
        <span className={css.sectionSummary} data-tone={props.tone ?? 'neutral'}>{props.summary}</span>
        <span className={css.sectionChevron} aria-hidden="true">{props.expanded ? '⌃' : '⌄'}</span>
      </button>
      {props.expanded ? <div id={contentId} className={css.sectionContent}>{props.children}</div> : null}
    </section>
  )
}

/**
 * Render the card.
 * @param props - locale copy, the card snapshot, and the form actions.
 * @returns the card, or nothing while the namespace is still loading.
 */
export function ImageGenSettingsSection(props: ImageGenSettingsSectionProps) {
  // The card renders through the plugin's own dictionary so the uiLanguage
  // override applies here too — the host-locale props.t would only follow the
  // DSH interface language.
  const t = tt
  useImageGenLanguageTick()
  const state = props.useImageGenSettingsCard(snapshot => snapshot)
  const [initialSection] = useState(() => takeImageGenConfigSection())
  const [open, setOpen] = useState(true)
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(initialSection ?? 'general')
  /** The result line under the save button: which outcome the last save had. */
  const [saveNote, setSaveNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [skillProbing, setSkillProbing] = useState(false)
  const [skillProbeResult, setSkillProbeResult] = useState<string | null>(null)
  // "Set up PPT" elsewhere in the panel jumps straight to this section.
  useEffect(() => {
    const reveal = (): void => {
      const section = takeImageGenConfigSection()
      if (section === undefined) return
      setActiveSection(section)
    }
    window.addEventListener(OPEN_IMAGE_GEN_CONFIG_EVENT, reveal)
    return () => { window.removeEventListener(OPEN_IMAGE_GEN_CONFIG_EVENT, reveal) }
  }, [])

  if (!state.available) return null
  const title = t('settings.title')
  const disabled = !state.writable
  const fieldProps = {
    overriddenLabel: t('settings.overridden'),
    resetLabel: t('settings.reset'),
    invalidLabel: t('settings.invalidNumber'),
    disabled,
  }
  const generalSummary = state.enabled.text === 'false' ? t('settings.summaryDisabled') : t('settings.summaryEnabled')
  const localPath = state.localStoragePath.text.trim()
  const storageSummary = localPath === '' ? t('settings.summaryDefault') : localPath
  const skillsSummary = state.skillsEnabled.text === 'false' ? t('settings.summaryDisabled') : t('settings.summaryEnabled')

  if (!state.exposed) {
    return (
      <section
        className={css.card}
        data-dsh-imagegen-settings-panel
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
      >
        <button
          type="button"
          className={css.header}
          aria-expanded={open}
          aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${title}`}
          onClick={() => { setOpen(!open) }}
        >
          <span className={css.headText}>
            <span className={css.name}>{title}</span>
            <span className={css.description}>{t('settings.description')}</span>
          </span>
          <span className={open ? css.chevronOpen : css.chevron}>▾</span>
        </button>
        {open
          ? (
            <div className={css.body}>
              <p className={css.notExposed} role="status">{t('settings.notExposed')}</p>
            </div>
          )
          : null}
      </section>
    )
  }

  return (
    <section
      className={css.card}
      data-dsh-imagegen-settings-panel
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.title')}
    >
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title} <span className={css.version}>v{PLUGIN_VERSION}</span></span>
          <span className={css.description}>{t('settings.description')}</span>
        </span>
        {state.dirty ? <span className={css.pending}>{t('settings.unsaved')}</span> : null}
        <span className={open ? css.chevronOpen : css.chevron}>▾</span>
      </button>
      {open
        ? (
          <div className={css.body}>
            {!state.writable ? <p className={css.readOnly} role="status">{t('settings.readOnly')}</p> : null}

            <SettingsSection
              id="general"
              title={t('settings.generalTitle')}
              hint={t('settings.generalHint')}
              summary={generalSummary}
              tone={state.enabled.text === 'false' ? 'attention' : 'ready'}
              expanded={activeSection === 'general'}
              onToggle={() => { setActiveSection(activeSection === 'general' ? null : 'general') }}
            >
              <BooleanField
                id="dsh-imagegen-settings-enabled"
                label={t('settings.enabled')}
                hint={t('settings.enabledHint')}
                inheritLabel={t('settings.inherit')}
                onLabel={t('settings.on')}
                offLabel={t('settings.off')}
                {...fieldProps}
                {...state.enabled}
                onEdit={(text) => { props.edit('enabled', text) }}
                onReset={() => { props.resetField('enabled') }}
              />
              <BooleanField
                id="dsh-imagegen-settings-announce"
                label={t('settings.announceToAgent')}
                hint={t('settings.announceToAgentHint')}
                inheritLabel={t('settings.inherit')}
                onLabel={t('settings.on')}
                offLabel={t('settings.off')}
                {...fieldProps}
                {...state.announceToAgent}
                onEdit={(text) => { props.edit('announceToAgent', text) }}
                onReset={() => { props.resetField('announceToAgent') }}
              />
              <BooleanField
                id="dsh-imagegen-settings-agent-generation"
                label={t('settings.allowAgentImageGeneration')}
                hint={t('settings.allowAgentImageGenerationHint')}
                inheritLabel={t('settings.inherit')}
                onLabel={t('settings.on')}
                offLabel={t('settings.off')}
                {...fieldProps}
                {...state.allowAgentImageGeneration}
                onEdit={(text) => { props.edit('allowAgentImageGeneration', text) }}
                onReset={() => { props.resetField('allowAgentImageGeneration') }}
              />
            </SettingsSection>

            <SettingsSection
              id="storage"
              title={t('settings.storageTitle')}
              hint={t('settings.storageHint')}
              summary={storageSummary}
              tone={localPath === '' ? 'neutral' : 'ready'}
              expanded={activeSection === 'storage'}
              onToggle={() => { setActiveSection(activeSection === 'storage' ? null : 'storage') }}
            >
              <ValueField
                id="dsh-imagegen-settings-local-storage-path"
                label={t('settings.localStoragePath')}
                hint={t('settings.localStoragePathHint')}
                placeholder="E:\\dsh-imagegen-data"
                {...fieldProps}
                {...state.localStoragePath}
                onEdit={(text) => { props.edit('localStoragePath', text) }}
                onReset={() => { props.resetField('localStoragePath') }}
              />
            </SettingsSection>

            <SettingsSection
              id="skills"
              title={t('settings.skillsTitle')}
              hint={t('settings.skillsHint')}
              summary={skillsSummary}
              tone={state.skillsEnabled.text === 'false' ? 'neutral' : 'ready'}
              expanded={activeSection === 'skills'}
              onToggle={() => { setActiveSection(activeSection === 'skills' ? null : 'skills') }}
            >
              <BooleanField
                id="dsh-imagegen-settings-skills-enabled"
                label={t('settings.skillsEnabled')}
                hint={t('settings.skillsEnabledHint')}
                inheritLabel={t('settings.inherit')}
                onLabel={t('settings.on')}
                offLabel={t('settings.off')}
                {...fieldProps}
                {...state.skillsEnabled}
                onEdit={(text) => { props.edit('skillsEnabled', text) }}
                onReset={() => { props.resetField('skillsEnabled') }}
              />
              <BooleanField
                id="dsh-imagegen-settings-skills-heavy"
                label={t('settings.allowHeavySkills')}
                hint={t('settings.allowHeavySkillsHint')}
                inheritLabel={t('settings.inherit')}
                onLabel={t('settings.on')}
                offLabel={t('settings.off')}
                {...fieldProps}
                {...state.allowHeavySkills}
                onEdit={(text) => { props.edit('allowHeavySkills', text) }}
                onReset={() => { props.resetField('allowHeavySkills') }}
              />
              <ValueField
                id="dsh-imagegen-settings-skills-allowlist"
                label={t('settings.skillAllowlist')}
                hint={t('settings.skillAllowlistHint')}
                placeholder="extract-content, image-to-editable-ppt"
                {...fieldProps}
                {...state.skillAllowlist}
                onEdit={(text) => { props.edit('skillAllowlist', text) }}
                onReset={() => { props.resetField('skillAllowlist') }}
              />
              <ValueField
                id="dsh-imagegen-settings-skills-output"
                label={t('settings.skillOutputDir')}
                hint={t('settings.skillOutputDirHint')}
                placeholder=""
                {...fieldProps}
                {...state.skillOutputDir}
                onEdit={(text) => { props.edit('skillOutputDir', text) }}
                onReset={() => { props.resetField('skillOutputDir') }}
              />
              <ValueField
                id="dsh-imagegen-settings-skills-timeout"
                label={t('settings.skillHeavyTimeout')}
                hint={t('settings.skillHeavyTimeoutHint')}
                placeholder="20"
                {...fieldProps}
                {...state.skillHeavyTimeoutMinutes}
                onEdit={(text) => { props.edit('skillHeavyTimeoutMinutes', text) }}
                onReset={() => { props.resetField('skillHeavyTimeoutMinutes') }}
              />
              <ValueField
                id="dsh-imagegen-settings-skills-preset"
                label={t('settings.skillAgentPreset')}
                hint={t('settings.skillAgentPresetHint')}
                placeholder=""
                {...fieldProps}
                {...state.skillAgentPreset}
                onEdit={(text) => { props.edit('skillAgentPreset', text) }}
                onReset={() => { props.resetField('skillAgentPreset') }}
              />
              <div className={css.modelSummary}>
                <button
                  type="button"
                  className={css.addModel}
                  disabled={disabled || skillProbing}
                  onClick={() => {
                    setSkillProbing(true)
                    setSkillProbeResult(null)
                    void fetch(CANVAS_SKILL_API.list, { method: 'POST' })
                      .then(async response => await response.json() as { ok?: boolean; skills?: unknown[]; agentAvailable?: boolean; registryAvailable?: boolean })
                      .then(body => {
                        const total = Array.isArray(body.skills) ? body.skills.length : 0
                        setSkillProbeResult(t('settings.skillProbeOk', {
                          count: total,
                          agent: body.agentAvailable === true ? t('settings.skillProbeAgentOn') : t('settings.skillProbeAgentOff'),
                        }))
                      })
                      .catch(caught => { setSkillProbeResult(t('settings.skillProbeFailed', { error: caught instanceof Error ? caught.message : String(caught) })) })
                      .finally(() => { setSkillProbing(false) })
                  }}
                >
                  {skillProbing ? t('settings.skillProbing') : t('settings.skillProbe')}
                </button>
                {skillProbeResult !== null ? <p className={css.hint} role="status">{skillProbeResult}</p> : null}
              </div>
            </SettingsSection>

            <SettingsSection
              id="ppt"
              title={t('ppt.title')}
              hint={t('ppt.setupHint')}
              summary="PPTX"
              expanded={activeSection === 'ppt'}
              onToggle={() => { setActiveSection(activeSection === 'ppt' ? null : 'ppt') }}
            >
              <PptSetup />
            </SettingsSection>

            <div className={css.footer}>
              {saveNote !== null
                ? <p className={saveNote.ok ? css.saved : css.failed} role="status">{saveNote.text}</p>
                : state.failed ? <p className={css.failed} role="status">{t('settings.saveFailed')}</p> : null}
              <button
                type="button"
                className={css.discard}
                disabled={!state.dirty || state.saving}
                onClick={() => { props.discard(); setSaveNote(null) }}
              >
                {t('settings.discard')}
              </button>
              <button
                type="button"
                className={css.save}
                disabled={!state.dirty || state.invalid || state.saving}
                onClick={() => {
                  setSaveNote(null)
                  void props.save().then(outcome => {
                    setSaveNote(outcome.ok
                      ? { ok: true, text: t('settings.saved') }
                      : { ok: false, text: t('settings.saveFailedReason', { error: outcome.message ?? t('settings.saveFailed') }) })
                  })
                }}
              >
                {t(state.saving ? 'settings.saving' : 'settings.save')}
              </button>
            </div>
          </div>
        )
        : null}
    </section>
  )
}

/** Props every field control needs regardless of its value type. */
interface FieldProps {
  /** Stable id associating the label with its control. */
  id: string
  /** Visible label. */
  label: string
  /** One-line explanation rendered under the control. */
  hint: string
  /** Draft text this control renders. */
  text: string
  /** True when saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** True when the draft is not a value this field accepts. */
  invalid: boolean
  /** Copy for the overridden badge. */
  overriddenLabel: string
  /** Copy for the reset control. */
  resetLabel: string
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string
  /** Disables every control (read-only document, or an unavailable namespace). */
  disabled: boolean
  /** Stage draft text. */
  onEdit: (text: string) => void
  /** Stage a clear so the field re-inherits the composition layer. */
  onReset: () => void
}

/** A staged value field. */
function ValueField(props: FieldProps & {
  /** Placeholder shown while the draft is empty. */
  placeholder?: string
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span className={css.badges}>
              <span className={css.badge}>{props.overriddenLabel}</span>
              <button
                type="button"
                className={css.reset}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <input
        id={props.id}
        className={props.invalid ? css.inputInvalid : css.input}
        type="text"
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={props.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={props.invalid ? css.invalid : css.hint}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

/** A staged boolean field: 继承 / 开 / 关. */
function BooleanField(props: FieldProps & {
  /** Copy for the inherit option. */
  inheritLabel: string
  /** Copy for the on option. */
  onLabel: string
  /** Copy for the off option. */
  offLabel: string
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span className={css.badges}>
              <span className={css.badge}>{props.overriddenLabel}</span>
              <button
                type="button"
                className={css.reset}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <Select
        id={props.id}
        className={css.select}
        value={props.text}
        disabled={props.disabled}
        onChange={(value) => { props.onEdit(value) }}
      >
        <option value="">{props.inheritLabel}</option>
        <option value="true">{props.onLabel}</option>
        <option value="false">{props.offLabel}</option>
      </Select>
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}
