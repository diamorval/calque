import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

const DS = "the design system's component (@diametral/design-system/react)";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "engine/**", "**/.turbo/**", ".cache/**", "packs/**", "**/test-results/**", "**/playwright-report/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  { languageOptions: { globals: { ...globals.node } } },
  // apps/web is built only from the design system's React components and tokens.
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXOpeningElement[name.name=/^(button|input|select|textarea|table|dialog|label)$/]",
          message: `Raw form, table and dialog elements: use ${DS}.`,
        },
        { selector: "JSXAttribute[name.name='style']", message: "No inline style: layout goes in app.css with --ds-* tokens." },
        { selector: "Literal[value=/#[0-9a-fA-F]{3,8}\\b/]", message: "No hex colour: use the design system's --ds-* tokens." },
        { selector: "TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}\\b/]", message: "No hex colour: use the design system's --ds-* tokens." },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@mui/*", "@chakra-ui/*", "@mantine/*", "@radix-ui/*", "@headlessui/*", "@base-ui/*", "antd", "react-bootstrap", "@shadcn/*"], message: `Use ${DS}.` },
          ],
        },
      ],
    },
  },
);
