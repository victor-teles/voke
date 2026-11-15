import { pageMarkdown, source } from "@/lib/source";

export const revalidate = false;

export const GET = async () => {
  const pages = await Promise.all(source.getPages().map(pageMarkdown));

  return new Response(pages.join("\n\n"), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
