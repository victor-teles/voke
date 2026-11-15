import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { highlight } from "fumadocs-core/highlight";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import Link from "next/link";
import type { ComponentProps } from "react";

const quickstart = `voke create my-api
cd my-api
bun run deploy`;

// The samples are real files, typechecked with this app, so they cannot drift from the API.
const snippets = [
  { file: "voke.config.ts", title: "voke.config.ts" },
  { file: "index.ts", title: "src/index.ts" },
] as const;

const features = [
  {
    body: "Declare Functions with typed contracts. Invoke them, route HTTP to them, and test them without a server.",
    href: "/docs/guides/functions",
    title: "Typed Functions",
  },
  {
    body: "Run your resources on the official AWS Emulator while your code reloads in the local Gateway.",
    href: "/docs/guides/local-aws",
    title: "Local AWS",
  },
  {
    body: "voke deploy builds, uploads and deploys a stage, then prints the API URL. No AWS CLI needed.",
    href: "/docs/guides/deploy",
    title: "One-command deploy",
  },
];

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring";

const PreBlock = (props: ComponentProps<"pre">) => (
  <CodeBlock {...props}>
    <Pre>{props.children}</Pre>
  </CodeBlock>
);

const highlighted = (code: string, lang: "bash" | "ts") =>
  highlight(code, {
    components: { pre: PreBlock },
    // Like Fumadocs' own code blocks: colors come from CSS variables, so both themes work.
    defaultColor: false,
    lang,
    themes: { dark: "github-dark", light: "github-light" },
  });

const readSnippet = (file: string): Promise<string> =>
  readFile(join(process.cwd(), "snippets", file), "utf-8");

export default async function HomePage() {
  const commands = await highlighted(quickstart, "bash");
  const files = await Promise.all(
    snippets.map(async ({ file, title }) => ({
      code: await highlighted(await readSnippet(file), "ts"),
      title,
    }))
  );

  return (
    <>
      <section className="voke-hero">
        <div className="relative mx-auto grid max-w-6xl gap-10 px-4 py-14 md:grid-cols-[1fr_1.1fr] md:items-center md:px-8 lg:py-20">
          <div className="min-w-0">
            <p className="mb-4 text-sm font-semibold uppercase tracking-[0.16em] text-fd-muted-foreground">
              TypeScript on AWS Lambda
            </p>
            <h1 className="text-4xl font-semibold leading-tight md:text-6xl">
              From typed Functions to a live API in three commands
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-8 text-fd-muted-foreground">
              Voke turns typed Functions into a local API, a CloudFormation
              stack and a deployed HTTP API, from one config file.
            </p>
            <div className="mt-6 max-w-md">{commands}</div>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                className={`rounded-md bg-fd-primary px-5 py-3 text-sm font-semibold text-fd-primary-foreground transition hover:opacity-90 ${focusRing}`}
                href="/docs/getting-started"
              >
                Get started
              </Link>
              <Link
                className={`rounded-md border border-fd-border px-5 py-3 text-sm font-semibold transition hover:bg-fd-muted ${focusRing}`}
                href="/docs"
              >
                Read the docs
              </Link>
            </div>
          </div>
          <div className="min-w-0">
            <Tabs items={files.map(({ title }) => title)}>
              {files.map(({ code, title }) => (
                <Tab key={title} value={title}>
                  {code}
                </Tab>
              ))}
            </Tabs>
          </div>
        </div>
      </section>

      <section
        aria-label="Features"
        className="mx-auto grid max-w-6xl gap-4 px-4 py-10 md:grid-cols-3 md:px-8"
      >
        {features.map((feature) => (
          <Link
            className={`voke-card p-5 transition hover:-translate-y-0.5 hover:border-fd-primary ${focusRing}`}
            href={feature.href}
            key={feature.href}
          >
            <h2 className="text-lg font-semibold">{feature.title}</h2>
            <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">
              {feature.body}
            </p>
          </Link>
        ))}
      </section>
    </>
  );
}
