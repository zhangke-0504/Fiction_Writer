import { memo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

const remarkPlugins = [remarkGfm, remarkBreaks];
const components: Components = {
  a: ({ children, href }) => (
    <>
      {children}
      {href && href !== children && ` (${href})`}
    </>
  ),
  img: ({ alt }) => alt,
  table: ({ children }) => (
    <div className="chat-table-scroll">
      <table>{children}</table>
    </div>
  ),
};

export const HarnessMarkdown = memo(function HarnessMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-body chat-markdown">
      <Markdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </Markdown>
    </div>
  );
});
