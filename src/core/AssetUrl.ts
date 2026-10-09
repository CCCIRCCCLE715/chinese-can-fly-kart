/** Resolve public resources beneath the game page, including repository Pages. */
export function assetUrl(path: string): string {
  return new URL(path.replace(/^\/+/, ''), document.baseURI).href;
}
