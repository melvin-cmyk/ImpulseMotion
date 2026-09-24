declare module "react-markdown" {
  import { FC, ReactNode } from "react"
  interface ReactMarkdownProps {
    children: string
    remarkPlugins?: unknown[]
    rehypePlugins?: unknown[]
    components?: Record<string, unknown>
    /** Maps every URL in the document (links, images) before rendering. */
    urlTransform?: (url: string, key: string, node: unknown) => string | null | undefined
  }
  const ReactMarkdown: FC<ReactMarkdownProps>
  export default ReactMarkdown
  /** Default sanitiser: keeps http(s)/mailto/relative URLs, drops other protocols. */
  export function defaultUrlTransform(url: string): string
}

declare module "remark-gfm" {
  const remarkGfm: unknown
  export default remarkGfm
}
