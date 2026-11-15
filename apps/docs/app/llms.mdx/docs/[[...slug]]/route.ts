import { notFound } from "next/navigation";

import { pageMarkdown, source } from "@/lib/source";

export const revalidate = false;

export const GET = async (
  _request: Request,
  { params }: { params: Promise<{ slug?: string[] }> }
) => {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) {
    notFound();
  }

  return new Response(await pageMarkdown(page), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};

export const generateStaticParams = () => source.generateParams();
