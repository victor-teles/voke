// The API Reference Page: Scalar's documented HTML integration, loaded from jsDelivr with a pinned
// version so no Scalar code enters the Lambda bundle. The standalone browser build at this URL
// registers `window.Scalar.createApiReference`. Bump deliberately and check the page by hand.
export const scalarVersion = "1.78.1";

/** Versions as npm publishes them: `1.78.1`, `1.79.0-beta.2`. */
export const scalarVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export const scalarScriptUrl = (version: string): string =>
  `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${version}`;

const htmlEscapes: Readonly<Record<string, string>> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&#39;",
  "<": "&lt;",
  ">": "&gt;",
};

const escapeHtml = (text: string): string =>
  text.replaceAll(/["&'<>]/gu, (character) => htmlEscapes[character] ?? "");

// JSON inside a <script> element: `<` is escaped so no string can close the element.
const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replaceAll("<", "\\u003c");

export interface ScalarPageInput {
  /** The URL the page loads the OpenAPI document from. */
  readonly documentUrl: string;
  readonly title: string;
  readonly version: string;
}

export const renderScalarPage = ({
  documentUrl,
  title,
  version,
}: ScalarPageInput): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="${escapeHtml(scalarScriptUrl(version))}"></script>
    <script>
      Scalar.createApiReference("#app", ${scriptJson({ url: documentUrl })});
    </script>
  </body>
</html>
`;
