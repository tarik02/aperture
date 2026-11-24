import { useTheme } from "next-themes";
import { use, useEffect, useId, useState } from "react";

const drawings = new Map<string, Promise<string>>();

function draw(id: string, chart: string, dark: boolean): Promise<string> {
  const key = `${dark}:${chart}`;
  let drawing = drawings.get(key);
  if (!drawing) {
    drawing = import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        fontFamily: "inherit",
        theme: dark ? "dark" : "default",
      });
      return (await mermaid.render(id, chart.replaceAll("\\n", "\n"))).svg;
    });
    drawings.set(key, drawing);
  }
  return drawing;
}

function Drawing({ chart }: { chart: string }) {
  const id = useId().replaceAll(":", "");
  const { resolvedTheme } = useTheme();
  const svg = use(draw(`mermaid-${id}`, chart, resolvedTheme === "dark"));
  return <div className="my-6 [&_svg]:mx-auto" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** A diagram, drawn in the page: what draws it needs a document to measure its text in. */
export function Mermaid({ chart }: { chart: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <Drawing chart={chart} /> : null;
}
