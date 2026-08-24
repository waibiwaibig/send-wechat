import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["tests/**/*.ts"],
    extends: [...tseslint.configs.recommended],
  },
  {
    files: ["src/relay/worker.ts"],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: "./tsconfig.relay.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
