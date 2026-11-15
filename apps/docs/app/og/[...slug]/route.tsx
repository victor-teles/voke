import { generateOGImage } from "fumadocs-ui/og";
import { notFound } from "next/navigation";

import { siteName } from "@/lib/site";
import { source } from "@/lib/source";

export const revalidate = false;

export const GET = async (
  _request: Request,
  { params }: { params: Promise<{ slug: string[] }> }
) => {
  const { slug } = await params;
  // The last segment is the image file name ("image.png").
  const page = source.getPage(slug.slice(0, -1));

  if (!page) {
    notFound();
  }

  return generateOGImage({
    description: page.data.description,
    primaryColor: "rgba(255, 178, 36, 0.28)",
    primaryTextColor: "rgb(255, 178, 36)",
    site: siteName,
    title: page.data.title,
  });
};

export const generateStaticParams = () =>
  source.getPages().map((page) => ({ slug: [...page.slugs, "image.png"] }));
