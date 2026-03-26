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

declare module "pptxgenjs" {
  class PptxGenJS {
    author: string
    title: string
    layout: string
    addSlide(): {
      background: { color: string }
      addText(text: string, opts?: Record<string, unknown>): void
      addImage(opts: Record<string, unknown>): void
      addTable(rows: unknown[][], opts?: Record<string, unknown>): void
      addShape(type: string, opts?: Record<string, unknown>): void
    }
    writeFile(opts: { fileName: string }): Promise<void>
  }
  export default PptxGenJS
}
