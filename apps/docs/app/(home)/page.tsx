import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { highlight } from "fumadocs-core/highlight";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import { ArrowRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ComponentProps, CSSProperties } from "react";

import { CopyCommand } from "@/components/home/copy-command";
import { HeroArt } from "@/components/home/hero-art";
import { Reveal } from "@/components/home/reveal";
import { Terminal } from "@/components/home/terminal";
import { Wiring } from "@/components/home/wiring";
import type { WiringSource } from "@/components/home/wiring";
import { githubUrl } from "@/lib/site";

// The samples are real files, typechecked with this app, so they cannot drift from the API.
const sources = [
  {
    deploys: ["Lambda function", "API Gateway route", "IAM role"],
    file: "http.ts",
    id: "http",
    label: "HTTP route",
    when: "On each request",
  },
  {
    deploys: ["Lambda function", "Event source mapping", "Queue permissions"],
    file: "sqs.ts",
    id: "sqs",
    label: "SQS queue",
    when: "On each batch",
  },
  {
    deploys: ["Lambda function", "SNS subscription", "Invoke permission"],
    file: "sns.ts",
    id: "sns",
    label: "SNS topic",
    when: "On each message",
  },
  {
    deploys: ["Lambda function", "EventBridge rule", "Invoke permission"],
    file: "eventbridge.ts",
    id: "eventbridge",
    label: "EventBridge rule",
    when: "On each matching event",
  },
  {
    deploys: ["Lambda function", "Scheduler schedule", "Scheduler role"],
    file: "schedule.ts",
    id: "schedule",
    label: "Schedule",
    when: "Every night at 03:00",
  },
  {
    deploys: ["Lambda function", "Event source mapping", "Stream read policy"],
    file: "kinesis.ts",
    id: "kinesis",
    label: "Kinesis stream",
    when: "On each batch of records",
  },
  {
    deploys: ["Lambda function", "Event source mapping", "Stream read policy"],
    file: "dynamodb.ts",
    id: "dynamodb",
    label: "DynamoDB stream",
    when: "On each item change",
  },
  {
    deploys: ["Lambda function", "EventBridge rule", "Bucket notifications"],
    file: "s3.ts",
    id: "s3",
    label: "S3 bucket",
    when: "On each upload",
  },
] as const;

const steps = [
  {
    command: "voke create my-api",
    output: [
      "Created my-api in ./my-api",
      "",
      "Next steps:",
      "  cd my-api",
      "  bun run dev",
    ],
    title: "Create",
  },
  {
    command: "bun run dev",
    output: ["VOKE  ready in 124 ms", "", ">➜ Local: http://localhost:3000/"],
    title: "Run locally",
  },
  {
    command: "bun run deploy",
    output: [
      "Building my-api (dev)",
      "Deploying stack my-api-dev",
      "Deployed in 48s",
      "",
      ">ApiUrl https://abc123.execute-api.us-east-1.amazonaws.com",
    ],
    title: "Deploy",
  },
] as const;

const features = [
  {
    art: "functions",
    body: "Describe a Function's input and output with Zod, Valibot or any Standard Schema. Invalid input never reaches your handler.",
    href: "/docs/guides/schemas",
    title: "Typed contracts",
  },
  {
    art: "local",
    body: "Queues, tables and buckets run on the official AWS Emulator while your code reloads in the local Gateway.",
    href: "/docs/guides/local-aws",
    title: "AWS on your machine",
  },
  {
    art: "durable",
    body: "Steps, waits and retries written as ordinary TypeScript. Lambda checkpoints the work, so it survives a crash or a week-long wait.",
    href: "/docs/guides/durable-functions",
    title: "Durable Functions",
  },
  {
    art: "http",
    body: "Routes carry their schemas, so Voke can serve an OpenAPI document and an API reference page from the same code.",
    href: "/docs/guides/openapi",
    title: "An API reference for free",
  },
  {
    art: "plugins",
    body: "Wrap every Function, add routes, provision a table or add a CLI command. Idempotency and OpenAPI ship as Plugins.",
    href: "/docs/guides/plugins",
    title: "Plugins",
  },
  {
    art: "deploy",
    body: "voke deploy builds, uploads and deploys a stage through CloudFormation, then prints the API URL. No AWS CLI needed.",
    href: "/docs/guides/deploy",
    title: "One-command deploy",
  },
] as const;

const PreBlock = (props: ComponentProps<"pre">) => (
  <CodeBlock {...props}>
    <Pre>{props.children}</Pre>
  </CodeBlock>
);

const highlighted = (code: string) =>
  highlight(code, {
    components: { pre: PreBlock },
    // Like Fumadocs' own code blocks: colors come from CSS variables, so both themes work.
    defaultColor: false,
    lang: "ts",
    themes: { dark: "github-dark", light: "github-light" },
  });

const readSnippet = async (file: string): Promise<string> => {
  const code = await readFile(
    join(process.cwd(), "snippets", "wiring", file),
    "utf-8"
  );

  return code.trimEnd();
};

const stagger = (index: number) => ({ "--i": index }) as CSSProperties;

export default async function HomePage() {
  const wiring: WiringSource[] = await Promise.all(
    sources.map(async (source) => ({
      ...source,
      code: await highlighted(await readSnippet(source.file)),
    }))
  );

  return (
    <main className="voke-home">
      <section className="voke-hero">
        <div aria-hidden="true" className="voke-hero-art">
          <HeroArt />
        </div>
        <div className="mx-auto flex w-full max-w-(--home-max) flex-col justify-center px-5 pt-16 pb-10 min-[901px]:min-h-[min(46rem,calc(100svh-3.5rem))] min-[901px]:py-20 md:px-10">
          <p className="voke-eyebrow voke-rise text-white/60">
            TypeScript framework for AWS Lambda
          </p>
          <h1
            className="voke-display voke-rise mt-6 max-w-[11ch] text-[clamp(3.2rem,1.2rem+7.4vw,6.6rem)]"
            style={stagger(1)}
          >
            Every event gets an answer.
          </h1>
          <p
            className="voke-rise mt-7 max-w-[34rem] text-[1.14rem] leading-[1.6] text-white/70"
            style={stagger(2)}
          >
            Write a typed Function and say what calls it: an HTTP route, a
            queue, a schedule, a stream. Voke runs it on your machine, tests it
            in process, and deploys it to AWS Lambda with one command.
          </p>
          <div
            className="voke-rise mt-9 flex flex-wrap items-center gap-3"
            style={stagger(3)}
          >
            <Link
              className="voke-button"
              data-kind="primary"
              href="/docs/getting-started"
            >
              Get started
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
            <CopyCommand command="voke create my-api" />
          </div>
          <p
            className="voke-rise mt-6 text-[0.88rem] text-white/45"
            style={stagger(4)}
          >
            Voke is not published yet.{" "}
            <Link
              className="text-white/75 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white hover:decoration-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-voke-lamp"
              href="/docs/getting-started#try-it-from-the-repository"
            >
              Try it from the repository
            </Link>
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-(--home-max) px-5 py-24 md:px-10 md:py-32">
        <Reveal className="max-w-[44rem]">
          <p className="voke-eyebrow text-fd-primary">Event Sources</p>
          <h2 className="voke-h2 mt-4">
            Say what calls it. Voke wires the rest.
          </h2>
          <p className="mt-5 max-w-[38rem] text-[1.06rem] leading-[1.65] text-fd-muted-foreground">
            One helper per source. Each gives your handler a typed, validated
            input, and deploys the trigger and its permissions together with the
            Lambda function.
          </p>
        </Reveal>
        <Reveal className="mt-12" index={1}>
          <Wiring sources={wiring} />
        </Reveal>
      </section>

      <section className="border-y border-fd-border bg-fd-muted/40">
        <div className="mx-auto max-w-(--home-max) px-5 py-24 md:px-10 md:py-28">
          <Reveal className="max-w-[44rem]">
            <p className="voke-eyebrow text-fd-primary">Three commands</p>
            <h2 className="voke-h2 mt-4">
              From an empty folder to a live URL.
            </h2>
            <p className="mt-5 max-w-[36rem] text-[1.06rem] leading-[1.65] text-fd-muted-foreground">
              No YAML, no handler glue, no AWS CLI. The same project runs with
              hot reload on your machine and as one Lambda per Function on AWS.
            </p>
          </Reveal>
          <ol className="mt-12 grid gap-4 lg:grid-cols-3">
            {steps.map((step, index) => (
              <li key={step.command}>
                <Reveal className="h-full" index={index}>
                  <Terminal
                    command={step.command}
                    delay={index * 900}
                    output={step.output}
                    title={`${index + 1} · ${step.title}`}
                  />
                </Reveal>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-(--home-max) px-5 py-24 md:px-10 md:py-32">
        <Reveal className="max-w-[44rem]">
          <p className="voke-eyebrow text-fd-primary">In the box</p>
          <h2 className="voke-h2 mt-4">
            The parts you would have built yourself.
          </h2>
        </Reveal>
        <ul className="mt-12 grid gap-x-5 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature, index) => (
            <li key={feature.href}>
              <Reveal index={index % 3}>
                <Link
                  className="group block rounded-[16px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-fd-ring"
                  href={feature.href}
                >
                  <div className="voke-plate aspect-[16/10]">
                    <Image
                      alt=""
                      height={640}
                      src={`/illustrations/${feature.art}.webp`}
                      width={1024}
                    />
                  </div>
                  <h3 className="mt-5 flex items-center gap-2 text-[1.08rem] font-semibold">
                    {feature.title}
                    <ArrowRight
                      aria-hidden="true"
                      className="size-4 -translate-x-1 text-fd-primary opacity-0 transition duration-200 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100"
                    />
                  </h3>
                  <p className="mt-2 text-[0.96rem] leading-[1.6] text-fd-muted-foreground">
                    {feature.body}
                  </p>
                </Link>
              </Reveal>
            </li>
          ))}
        </ul>
      </section>

      <section className="px-5 pb-24 md:px-10">
        <Reveal>
          <div className="voke-plate mx-auto flex max-w-(--home-max) flex-col items-start gap-8 px-7 py-14 text-voke-bone md:flex-row md:items-end md:justify-between md:px-14 md:py-20">
            <div className="relative">
              <h2 className="voke-h2">Start with one Function.</h2>
              <p className="mt-4 max-w-[30rem] text-[1.04rem] leading-[1.6] text-white/65">
                Create a project, run it locally, and deploy it when the tests
                pass. The guide walks through each step.
              </p>
            </div>
            <div className="relative flex flex-wrap items-center gap-3">
              <Link
                className="voke-button"
                data-kind="primary"
                href="/docs/getting-started"
              >
                Get started
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
              <Link
                className="voke-button border border-white/16 text-voke-bone hover:bg-white/[0.06]"
                href="/docs/concepts"
              >
                Read the concepts
              </Link>
            </div>
          </div>
        </Reveal>
      </section>

      <footer className="border-t border-fd-border">
        <div className="mx-auto flex max-w-(--home-max) flex-wrap items-center justify-between gap-4 px-5 py-8 text-[0.88rem] text-fd-muted-foreground md:px-10">
          <p>Voke is open source under the MIT license.</p>
          <nav aria-label="Footer" className="flex gap-6">
            <Link className="hover:text-fd-foreground" href="/docs">
              Documentation
            </Link>
            <a className="hover:text-fd-foreground" href={githubUrl}>
              GitHub
            </a>
            <a className="hover:text-fd-foreground" href="/llms.txt">
              llms.txt
            </a>
          </nav>
        </div>
      </footer>
    </main>
  );
}
