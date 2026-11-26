/**
 * Visual-only entry for the dsh-imagegen settings card.
 *
 * Renders the real `ImageGenSettingsSection` against an in-memory settings
 * scope, so both states of the card (a fresh install and one that has been
 * configured) can be checked in a real browser at the host's settings-pane
 * width. No host routes are used: the card only edits local choices, because
 * the gateway channel and its credentials belong to the deployment.
 */

import { createElement, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { ImageGenSettingsCardController, ImageGenSettingsSection, type ImageGenSettingsCardState } from '../src/client/SettingsCard.tsx'
import { applyHostLocale } from '../src/client/helpers.ts'
import type { ImageGenConfig, ImageGenScope } from '../src/client/settings-scope.ts'

applyHostLocale('zh')

const variant = new URLSearchParams(location.search).get('state') === 'new' ? 'new' : 'configured'

const EMPTY: ImageGenConfig = {
  enabled: true,
}

const CONFIGURED: ImageGenConfig = {
  enabled: true,
  announceToAgent: true,
  allowAgentImageGeneration: true,
  allowAgentVideoGeneration: true,
  localStoragePath: '/Users/you/Pictures/dsh-imagegen',
  skillsEnabled: true,
  allowHeavySkills: true,
  skillHeavyTimeoutMinutes: 20,
}

const config = variant === 'new' ? EMPTY : CONFIGURED

const scope = {
  getSnapshot: () => ({
    status: 'ready' as const,
    value: config,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host' as const,
  }),
  subscribe: () => () => {},
  mutate: async () => {},
  set: async () => {},
  unset: async () => {},
  load: async () => {},
  mutateOps: async () => {},
  // 这张卡片不编辑任何密钥：网关凭据由宿主凭据服务持有，提交时现取。
  getKeySetSnapshot: () => false,
  subscribeKeySet: () => () => {},
  getSecretSetSnapshot: () => false,
  subscribeSecretSets: () => () => {},
} as unknown as ImageGenScope

const controller = new ImageGenSettingsCardController(scope)
const face = controller.inject()
const useImageGenSettingsCard = <T,>(selector: (snapshot: ImageGenSettingsCardState) => T): T => useSyncExternalStore(
  face.hooks.imageGenSettingsCard.subscribe,
  () => selector(face.hooks.imageGenSettingsCard.getSnapshot()),
)
const root = createRoot(document.getElementById('root')!)
root.render(createElement(ImageGenSettingsSection, {
  ...face,
  useImageGenSettingsCard,
} as never))
