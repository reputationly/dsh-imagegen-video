/**
 * How many reference images actually reach the model.
 *
 * The host carries the primary image in `image` and up to four extras in
 * `images` on the one OpenAI-style edit path every gateway model goes through,
 * so the ceiling is the same five for all of them. What this module adds is the
 * accounting the UI needs:
 *  - how many of the user's picked references will be USED,
 *  - how many will be DROPPED,
 *  - and the model the numbers belong to, for the tooltip.
 *
 * The workspace is allowed to accept more files than the model can use — a user
 * assembling a mood board wants them on screen — but it is never allowed to
 * accept them silently, which is what `dropped` is for.
 */

import { EDIT_REFERENCE_LIMIT } from './reference-images.ts'

/** How many files the picker accepts. Larger than the model's capacity on purpose. */
export const REPLICA_PICK_LIMIT = 20

export interface ReferenceCapacity {
  /** How many of the picked references the next request will actually carry. */
  usable: number
  /** How many will be left out, so the UI can say so. */
  dropped: number
  /**
   * The model's real ceiling, independent of what is picked.
   *
   * `usable` is a function of BOTH the ceiling and the form, so it is 0 when the
   * form is empty — which makes it useless as a "上限" for the UI to display:
   * "参考图上限 0 张" is a sentence that contradicts itself. This field is the
   * ceiling alone, and it is what the capacity line must show while nothing is
   * picked.
   */
  limit: number
  /** The model id as configured, for the tooltip. */
  model: string
}

/**
 * Resolve the real capacity for one target.
 *
 * @param model - the model alias the user picked.
 * @param picked - how many references the user has put in the form.
 */
export function referenceCapacity(model: string, picked: number): ReferenceCapacity {
  const limit = EDIT_REFERENCE_LIMIT
  const usable = Math.min(limit, picked)
  return { usable, dropped: Math.max(0, picked - usable), limit, model }
}

/**
 * Split the picked references into the two fields the request carries.
 *
 * The split is NOT arbitrary: `image` is the primary and `images` holds the
 * extras, and the engine re-slices the extras at 4. Slicing here as well means
 * the number the UI promises ("本次实际使用前 N 张") is the number that leaves
 * the browser, so the promise stays true even if the host limit changes.
 */
export function splitReferences(dataUrls: string[], usable: number): { primary?: string; extras: string[] } {
  const kept = dataUrls.slice(0, Math.max(0, usable))
  const [primary, ...rest] = kept
  return primary === undefined ? { extras: [] } : { primary, extras: rest }
}
