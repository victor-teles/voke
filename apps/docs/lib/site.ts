/** The public URL of the docs site. Set NEXT_PUBLIC_SITE_URL when the site is hosted. */
export const siteUrl = new URL(
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3942"
);

export const siteName = "Voke";

export const siteDescription =
  "A TypeScript framework for AWS Lambda: typed Functions, a local API, and one-command deploys.";

export const github = {
  branch: "main",
  /** Where the docs pages live in the repository. */
  contentPath: "apps/docs/content/docs",
  owner: "victor-teles",
  repo: "voke",
} as const;

export const githubUrl = `https://github.com/${github.owner}/${github.repo}`;

/** The GitHub URL that opens a docs page for editing. */
export const editUrl = (pagePath: string): string =>
  `${githubUrl}/blob/${github.branch}/${github.contentPath}/${pagePath}`;
