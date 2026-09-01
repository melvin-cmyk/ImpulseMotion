declare module "react-markdown" {
  import { FC, ReactNode } from "react"
  interface ReactMarkdownProps {
    children: string
    remarkPlugins?: unknown[]
    rehypePlugins?: unknown[]
    components?: Record<string, unknown>
  }
  const ReactMarkdown: FC<ReactMarkdownProps>
  export default ReactMarkdown
}

declare module "remark-gfm" {
  const remarkGfm: unknown
  export default remarkGfm
}
