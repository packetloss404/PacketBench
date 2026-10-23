import { useState } from "react";
import type { CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import { Copy, Check } from "lucide-react";

SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("ts", typescript);
SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("js", javascript);
SyntaxHighlighter.registerLanguage("jsx", jsx);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("py", python);
SyntaxHighlighter.registerLanguage("rust", rust);
SyntaxHighlighter.registerLanguage("rs", rust);
SyntaxHighlighter.registerLanguage("go", go);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("sh", bash);
SyntaxHighlighter.registerLanguage("sql", sql);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("markdown", markdown);

// Shared code stack (V4) — prefers the host monospace family over an optional
// JetBrains/Cascadia/Fira install. Geometry is identical in both themes.
const CODE_FONT_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

/**
 * Theme-aware syntax palette (V4). Replaces the fixed `oneDark` import with
 * semantic tokens so both themes resolve automatically and inline/fenced/diff
 * code share one scale. Sizes track `--text-code` / `--leading-code`; colors
 * track the role mapping: comments → muted, strings → success, keywords →
 * reasoning/accent, numbers/constants → warning, functions/links → info,
 * errors/deletions → error. Text shadows and decorative italics are disabled.
 */
const SYNTAX_THEME: Record<string, CSSProperties> = {
  'code[class*="language-"]': {
    color: "var(--color-text-primary)",
    background: "transparent",
    fontFamily: CODE_FONT_STACK,
    fontSize: "var(--text-code)",
    lineHeight: "var(--leading-code)",
    textShadow: "none",
  },
  'pre[class*="language-"]': {
    color: "var(--color-text-primary)",
    background: "var(--color-bg-primary)",
    border: "1px solid var(--color-bg-border)",
    borderRadius: "6px",
    fontFamily: CODE_FONT_STACK,
    fontSize: "var(--text-code)",
    lineHeight: "var(--leading-code)",
    textShadow: "none",
    margin: 0,
    padding: "1em",
    overflow: "auto",
  },
  comment: { color: "var(--color-text-muted)" },
  prolog: { color: "var(--color-text-muted)" },
  doctype: { color: "var(--color-text-muted)" },
  cdata: { color: "var(--color-text-muted)" },
  punctuation: { color: "var(--color-text-secondary)" },
  operator: { color: "var(--color-text-secondary)" },
  string: { color: "var(--color-accent-green)" },
  char: { color: "var(--color-accent-green)" },
  "attr-value": { color: "var(--color-accent-green)" },
  inserted: { color: "var(--color-accent-green)" },
  keyword: { color: "var(--color-accent-purple)" },
  builtin: { color: "var(--color-accent-purple)" },
  tag: { color: "var(--color-accent-purple)" },
  selector: { color: "var(--color-accent-purple)" },
  "attr-name": { color: "var(--color-accent-purple)" },
  function: { color: "var(--color-accent-blue)" },
  "class-name": { color: "var(--color-accent-blue)" },
  property: { color: "var(--color-accent-blue)" },
  url: { color: "var(--color-accent-blue)" },
  boolean: { color: "var(--color-accent-amber)" },
  number: { color: "var(--color-accent-amber)" },
  constant: { color: "var(--color-accent-amber)" },
  symbol: { color: "var(--color-accent-amber)" },
  regex: { color: "var(--color-accent-amber)" },
  deleted: { color: "var(--color-accent-red)" },
  entity: { color: "var(--color-accent-red)" },
  important: { color: "var(--color-accent-red)", fontWeight: 600 },
  variable: { color: "var(--color-text-primary)" },
};

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

interface CodeBlockProps {
  language: string;
  value: string;
}

function CodeBlock({ language, value }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="relative group my-2">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-2 right-2 z-10 flex min-h-target-icon min-w-target-icon items-center justify-center rounded border border-bg-border bg-bg-secondary text-text-secondary opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        aria-label="Copy code"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      <SyntaxHighlighter
        language={language}
        style={SYNTAX_THEME}
        PreTag="div"
      >
        {value.replace(/\n$/, "")}
      </SyntaxHighlighter>
    </div>
  );
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const classes = ["selectable markdown-content", className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { className, children, ...rest } = props;
            const match = /language-(\w+)/.exec(className || "");
            const isBlock = !!match;
            const codeText = String(children ?? "");

            if (!isBlock) {
              return (
                <code
                  {...rest}
                  className="bg-bg-secondary px-1 rounded font-mono text-code"
                >
                  {children}
                </code>
              );
            }

            return <CodeBlock language={match[1]} value={codeText} />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
