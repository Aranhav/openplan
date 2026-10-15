const UNSAFE_CHARACTERS = /[\s\p{Cc}\\]/u

/**
 * The path to open after signing in. Anything that could leave this app (another origin, a
 * protocol-relative URL, whitespace or backslashes that browsers strip or rewrite) becomes "/".
 */
export function safeRedirectPath(target: string | undefined): string {
  if (!target?.startsWith("/") || UNSAFE_CHARACTERS.test(target)) {
    return "/"
  }
  try {
    return new URL(target, window.location.origin).origin === window.location.origin ? target : "/"
  } catch {
    return "/"
  }
}

/** Search params for /login, remembering where to return to unless that is home. */
export function loginSearch(href: string): { redirect?: string } {
  return href === "/" ? {} : { redirect: href }
}
