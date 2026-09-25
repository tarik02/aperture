import { loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";
import { applyMdxPreset } from "fumadocs-mdx/config";
import { defineDocs } from "fumadocs-mdx/macro";
import { remarkAutoTypeTable, type RemarkAutoTypeTableOptions } from "fumadocs-typescript";

const typeTableOptions: RemarkAutoTypeTableOptions = {
  options: {
    typeSimplifier: {
      override: ({ type, checker, location }) => {
        const text = checker.typeToString(type, location).replace(/ \| undefined$/, "");
        return text.length <= 48 ? text : undefined;
      },
    },
  },
};

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    async: true,
    mdxOptions: applyMdxPreset({
      remarkPlugins: (plugins) => [...plugins, [remarkAutoTypeTable, typeTableOptions]],
    }),
  },
});

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: "/docs",
  plugins: [lucideIconsPlugin()],
});
