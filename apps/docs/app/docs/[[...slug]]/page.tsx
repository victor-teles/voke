import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/notebook/page";
import { notFound } from "next/navigation";

import { getMDXComponents } from "@/components/mdx";
import { editUrl } from "@/lib/site";
import { markdownUrl, ogImagePath, pageSection, source } from "@/lib/source";

interface PageProps {
  params: Promise<{
    slug?: string[];
  }>;
}

export default async function Page({ params }: PageProps) {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) {
    notFound();
  }

  const MDXContent = page.data.body;
  const section = pageSection(page);

  return (
    <DocsPage
      breadcrumb={{ enabled: false }}
      tableOfContent={{ style: "clerk" }}
      toc={page.data.toc}
    >
      <div className="flex flex-col gap-3 border-b border-fd-border pb-7">
        {section === undefined ? null : (
          <p className="voke-eyebrow text-fd-primary">{section}</p>
        )}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <DocsTitle>{page.data.title}</DocsTitle>
          <div className="flex flex-row items-center gap-2 pt-1">
            <MarkdownCopyButton markdownUrl={markdownUrl(page)} />
            <ViewOptionsPopover
              githubUrl={editUrl(page.path)}
              markdownUrl={markdownUrl(page)}
            />
          </div>
        </div>
        <DocsDescription className="mb-0 max-w-[62ch] text-[1.08rem] leading-7">
          {page.data.description}
        </DocsDescription>
      </div>
      <DocsBody>
        <MDXContent components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export const generateStaticParams = () => source.generateParams();

export const generateMetadata = async ({ params }: PageProps) => {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) {
    notFound();
  }

  return {
    description: page.data.description,
    openGraph: { images: ogImagePath(page) },
    title: page.data.title,
  };
};
