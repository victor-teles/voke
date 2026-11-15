import { docsLlms } from "@/lib/source";

export const revalidate = false;

export const GET = () =>
  new Response(docsLlms.index(), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
