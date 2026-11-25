/**
 * The host gateway catalog as the browser half consumes it.
 *
 * There is exactly one channel and it comes from the deployment: the host reads
 * the media catalog, caches it and resolves every request against it, so the
 * plugin owns no channel table of its own. This module turns the catalog
 * snapshot into the two things the UI needs — the channel the model pickers and
 * the request-shaping helpers consume, and the alias → upstream-model mapping
 * that capability descriptions read.
 */

import { GATEWAY_CHANNEL_ID } from '../gateway-catalog.ts'
import type { ChannelConfig, GatewayCatalogSnapshot, GatewayModelOption } from '../protocol.ts'

/** The catalog as the pickers read it; a missing snapshot is an empty one. */
type Snapshot = Pick<GatewayCatalogSnapshot, 'image' | 'video'> | null

/**
 * The single gateway channel, rebuilt from both catalog lists.
 *
 * One channel carries both catalogs — image aliases in `models`, video aliases
 * in `videoModels` — exactly as the host maps them when it resolves a request.
 * `apiUrl` stays empty on purpose: the browser never calls the gateway, the
 * host does, and a URL here would invite a second request path.
 *
 * @param snapshot - the catalog snapshot the panel fetched, or null before the first read.
 * @param channelName - localized channel label the pickers show.
 * @returns one channel, or an empty list when the catalog offers no model.
 */
export function gatewayChannel(snapshot: Snapshot, channelName: string): ChannelConfig[] {
  const image = snapshot?.image ?? []
  const video = snapshot?.video ?? []
  if (image.length === 0 && video.length === 0) return []
  return [{
    id: GATEWAY_CHANNEL_ID,
    name: channelName,
    apiUrl: '',
    apiUrlFull: false,
    models: image.map(option => ({ alias: option.label, id: option.model })),
    videoModels: video.map(option => ({ alias: option.label, id: option.model })),
  }]
}

/**
 * The upstream model id behind one picker alias.
 *
 * Capabilities (edit support, GIF output, prompt limits) belong to the id the
 * gateway receives, not to the display name the picker shows. An alias the
 * catalog does not know is returned unchanged, so an id someone typed by hand
 * is still described rather than discarded.
 *
 * @param snapshot - the catalog snapshot.
 * @param alias - the picker value (the catalog's display label).
 * @returns the upstream model id.
 */
export function gatewayUpstreamId(snapshot: Snapshot, alias: string): string {
  const options = [...snapshot?.image ?? [], ...snapshot?.video ?? []]
  return options.find(option => option.label === alias)?.model ?? alias
}

/**
 * The alias a picker should start on.
 *
 * The user's own previous choice wins while the catalog still offers it — a
 * gateway that retires a model must not leave the picker pointing at it — and
 * falls back to the catalog's marked default, then to the first entry.
 *
 * @param options - one catalog list.
 * @param previous - the alias stored in settings, if any.
 * @returns the alias to select, or undefined when the list is empty.
 */
export function gatewayDefaultAlias(options: readonly GatewayModelOption[], previous: string | undefined): string | undefined {
  if (options.length === 0) return undefined
  const stored = previous?.trim() ?? ''
  if (stored !== '' && options.some(option => option.label === stored)) return stored
  return (options.find(option => option.isDefault) ?? options[0]!).label
}
