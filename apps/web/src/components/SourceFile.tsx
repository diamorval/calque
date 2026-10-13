import { CodeBlock, CodeBlockBody, CodeBlockCopyButton, CodeBlockFilename, CodeBlockHead } from "diametral-ds/code-block";

/** A pack source file, read-only: diametral-ds code block with line numbers and a copy button.
Long lines scroll inside the block, so it holds at phone width. */
export function SourceFile({ name, text }: { name: string; text: string }) {
  return (
    <CodeBlock className="min-w-0">
      <CodeBlockHead>
        <CodeBlockFilename>{name}</CodeBlockFilename>
        <CodeBlockCopyButton value={text} />
      </CodeBlockHead>
      <CodeBlockBody className="max-h-[420px] text-xs leading-relaxed">
        {text.split("\n").map((line, i) => (
          <span key={i} className="table-row">
            <span aria-hidden className="table-cell select-none pr-4 text-right text-[var(--ds-grey-brand)]">
              {i + 1}
            </span>
            <span className="table-cell whitespace-pre">{line}</span>
          </span>
        ))}
      </CodeBlockBody>
    </CodeBlock>
  );
}
