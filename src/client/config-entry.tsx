/**
 * Configuration entry surfaces shared by the browser half.
 *
 * The host renders the real settings page from a `settings.section`
 * registration; this module only carries its stable id and the in-app event
 * used by prompts that need to reveal that page.
 */

/** Stable id of the dsh-imagegen entry in the settings navigation. */
export const IMAGE_GEN_SECTION_ID = 'dsh-imagegen'

/** Event dispatched by in-app "configure" prompts. */
export const OPEN_IMAGE_GEN_CONFIG_EVENT = 'dsh-imagegen:open-config'
/** 已挂载的工作台切到画廊并重读画廊。 */
export const SHOW_GALLERY_EVENT = 'dsh-imagegen:show-gallery'

/** 请求在画廊打开；工作台此刻还没挂载时，挂载后取走这个请求。 */
let galleryRequested = false
export function takeGalleryRequest(): boolean {
  const requested = galleryRequested
  galleryRequested = false
  return requested
}

export function showImageGenGallery(): void {
  galleryRequested = true
  window.dispatchEvent(new CustomEvent(SHOW_GALLERY_EVENT))
}

/** 对话图片卡片「拿去精修」交给生图面板的图片：进图生图页当参考图。 */
export interface RefineImagesRequest {
  prompt: string
  images: Array<{ dataUrl: string; name: string; bytes: number }>
}

export const REFINE_IMAGES_EVENT = 'dsh-imagegen:refine-images'

/** 生图面板此刻还没挂载时，挂载后取走这个请求。 */
let refineRequested: RefineImagesRequest | undefined
export function takeRefineRequest(): RefineImagesRequest | undefined {
  const requested = refineRequested
  refineRequested = undefined
  return requested
}

export function refineImages(request: RefineImagesRequest): void {
  refineRequested = request
  window.dispatchEvent(new CustomEvent(REFINE_IMAGES_EVENT))
}

/** Settings groups an in-app prompt can jump to directly. */
export type ImageGenConfigSection = 'storage' | 'skills' | 'ppt' | 'general'

/** Ask the host to open Settings and select the dsh-imagegen section. */
let requestedSection: ImageGenConfigSection | undefined
export function takeImageGenConfigSection(): ImageGenConfigSection | undefined {
  const section = requestedSection
  requestedSection = undefined
  return section
}

export function openImageGenConfig(section?: ImageGenConfigSection): void {
  requestedSection = section
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(OPEN_IMAGE_GEN_CONFIG_EVENT, { detail: { section } }))
}
