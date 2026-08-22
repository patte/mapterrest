/** Markdown imports arrive as HTML strings — rendered by the plugin in vite.config.ts. */
declare module '*.md' {
  const html: string;
  export default html;
}
