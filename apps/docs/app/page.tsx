import Link from "next/link";

const pillars = [
  {
    body: "Define Functions, collect them in a typed registry, and expose only route-backed work through the Gateway.",
    href: "/docs/guides/functions",
    title: "Function-first authoring",
  },
  {
    body: "Develop, test, build, and synthesize without hiding serverless behavior behind a generated app.",
    href: "/docs/getting-started",
    title: "Local-first workflow",
  },
  {
    body: "Move from Serverless Framework into explicit Voke config, Function skeletons, and risk-grouped reports.",
    href: "/docs/guides/serverless-migration",
    title: "Migration path",
  },
];

export default function HomePage() {
  return (
    <main>
      <section className="voke-hero">
        <div className="relative mx-auto grid min-h-[72vh] max-w-7xl gap-10 px-6 py-16 md:grid-cols-[1.05fr_0.95fr] md:items-center md:px-10 lg:py-24">
          <div className="max-w-3xl">
            <p className="mb-5 text-sm font-semibold uppercase tracking-[0.18em] text-fd-muted-foreground">
              Lambda framework for typed serverless apps
            </p>
            <h1 className="text-5xl font-semibold leading-[1.02] md:text-7xl">
              Voke functions
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-fd-muted-foreground">
              Learn the Function-first model, build Hono-compatible APIs, run
              local Gateway tests, synthesize CloudFormation, and migrate
              existing Serverless services with a clear review trail.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                className="rounded-md bg-fd-primary px-5 py-3 text-sm font-semibold text-fd-primary-foreground transition hover:opacity-90"
                href="/docs"
              >
                Start reading
              </Link>
              <Link
                className="rounded-md border border-fd-border px-5 py-3 text-sm font-semibold transition hover:bg-fd-muted"
                href="/docs/reference/cli"
              >
                CLI reference
              </Link>
            </div>
          </div>
          <div className="voke-card p-5 md:p-6">
            <div className="mb-4 flex items-center justify-between border-b border-fd-border pb-3 text-xs text-fd-muted-foreground">
              <span>voke.config.ts</span>
              <span>typed source of truth</span>
            </div>
            <pre className="overflow-x-auto text-sm leading-7">
              <code>
                <span className="voke-code-keyword">import</span>{" "}
                <span className="voke-code-muted">{"{"}</span>{" "}
                <span className="voke-code-symbol">defineConfig</span>{" "}
                <span className="voke-code-muted">{"}"}</span>{" "}
                <span className="voke-code-keyword">from</span>{" "}
                <span className="voke-code-string">"voke"</span>
                <span className="voke-code-muted">;</span>
                {"\n"}
                <span className="voke-code-keyword">import</span>{" "}
                <span className="voke-code-muted">{"{"}</span>{" "}
                <span className="voke-code-symbol">dynamodbTable</span>{" "}
                <span className="voke-code-muted">{"}"}</span>{" "}
                <span className="voke-code-keyword">from</span>{" "}
                <span className="voke-code-string">"voke/aws"</span>
                <span className="voke-code-muted">;</span>
                {"\n\n"}
                <span className="voke-code-keyword">export default</span>{" "}
                <span className="voke-code-symbol">defineConfig</span>
                <span className="voke-code-muted">({"{"}</span>
                {"\n  "}
                <span className="voke-code-property">name</span>
                <span className="voke-code-muted">:</span>{" "}
                <span className="voke-code-string">"hello-api"</span>
                <span className="voke-code-muted">,</span>
                {"\n  "}
                <span className="voke-code-property">stage</span>
                <span className="voke-code-muted">:</span>{" "}
                <span className="voke-code-string">"local"</span>
                <span className="voke-code-muted">,</span>
                {"\n  "}
                <span className="voke-code-property">region</span>
                <span className="voke-code-muted">:</span>{" "}
                <span className="voke-code-string">"us-east-1"</span>
                <span className="voke-code-muted">,</span>
                {"\n  "}
                <span className="voke-code-property">entrypoint</span>
                <span className="voke-code-muted">:</span>{" "}
                <span className="voke-code-string">"./src/index.ts"</span>
                <span className="voke-code-muted">,</span>
                {"\n  "}
                <span className="voke-code-property">cloudFormation</span>
                <span className="voke-code-muted">: {"{"}</span>
                {"\n    "}
                <span className="voke-code-property">resources</span>
                <span className="voke-code-muted">: {"{"}</span>
                {"\n      "}
                <span className="voke-code-property">usersTable</span>
                <span className="voke-code-muted">: </span>
                <span className="voke-code-symbol">dynamodbTable</span>
                <span className="voke-code-muted">({"{"}</span>{" "}
                <span className="voke-code-property">partitionKey</span>
                <span className="voke-code-muted">:</span>{" "}
                <span className="voke-code-string">"id"</span>{" "}
                <span className="voke-code-muted">{"}"}),</span>
                {"\n    "}
                <span className="voke-code-muted">{"},"}</span>
                {"\n  "}
                <span className="voke-code-muted">{"},"}</span>
                {"\n"}
                <span className="voke-code-muted">{"});"}</span>
              </code>
            </pre>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-4 px-6 py-10 md:grid-cols-3 md:px-10">
        {pillars.map((pillar) => (
          <Link
            className="voke-card p-5 transition hover:-translate-y-0.5 hover:border-fd-primary"
            href={pillar.href}
            key={pillar.href}
          >
            <h2 className="text-lg font-semibold">{pillar.title}</h2>
            <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">
              {pillar.body}
            </p>
          </Link>
        ))}
      </section>
    </main>
  );
}
