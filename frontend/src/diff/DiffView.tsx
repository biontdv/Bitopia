// Monaco Editor diff view. We instantiate a real Monaco diff editor with
// monaco.editor.createDiffEditor and feed it an original/modified model pair.
// The content is stubbed for this slice (a placeholder "before vs after" of an
// agent edit) but the editor is genuinely created, sized, and disposed, so the
// wiring is production-ready; a later feature can feed real diffs streamed from
// the daemon.

import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";

const STUB_ORIGINAL = `export function greet(name) {
  // TODO: handle empty names
  return "Hello " + name;
}
`;

const STUB_MODIFIED = `export function greet(name: string): string {
  if (!name) return "Hello there";
  return \`Hello \${name}\`;
}
`;

export function DiffView() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const editor = monaco.editor.createDiffEditor(host, {
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12,
      theme: "vs-dark",
    });

    const original = monaco.editor.createModel(STUB_ORIGINAL, "typescript");
    const modified = monaco.editor.createModel(STUB_MODIFIED, "typescript");
    editor.setModel({ original, modified });

    return () => {
      editor.dispose();
      original.dispose();
      modified.dispose();
    };
  }, []);

  return (
    <div className="diff-wrap">
      <div className="diff-caption">Proposed change (preview)</div>
      <div ref={hostRef} className="diff-host" />
    </div>
  );
}
