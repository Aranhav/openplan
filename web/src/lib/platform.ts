// `userAgentData` is not in the DOM types yet; only Chromium browsers have it.
type NavigatorWithUserAgentData = Navigator & { userAgentData?: { platform?: string } }

/**
 * The name of the operating system: the user agent data's where the browser has it, since the
 * `platform` that every browser has is deprecated and its answer is not guaranteed.
 */
function platformName(): string {
  const { userAgentData, platform } = navigator as NavigatorWithUserAgentData
  return userAgentData?.platform || platform
}

/** Whether the keyboard is a Mac's, where Command takes the place of Ctrl. */
export function isMac(): boolean {
  return /^(mac|iphone|ipad|ipod|ios)/i.test(platformName())
}
