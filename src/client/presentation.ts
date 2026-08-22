export type GarminLoginRegion = 'cn' | 'global'

export interface GarminAuthenticatedAccountPresentation {
  email: string
  region: GarminLoginRegion
}

/** Select the user-visible secondary label for one regional login action. */
export function regionLoginSubtitle(
  region: GarminLoginRegion,
  domain: string,
  account?: GarminAuthenticatedAccountPresentation,
): string {
  return account?.region === region
    ? `已登录：「${account.email}」`
    : domain
}
