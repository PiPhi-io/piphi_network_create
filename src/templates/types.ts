export type TemplateScaffoldOptions = {
  slug: string;
  title: string;
  language: "node" | "python" | "go";
  kind: string;
  image: string;
  port: number;
  preset: string;
  domain: string;
  snakeName: string;
  packageManager: "npm" | "pnpm" | "yarn";
  pythonManager: "pip" | "uv" | "pdm";
};

export type TemplateCommandSet = {
  installCommand: string;
  checkCommand: string;
  testCommand: string;
  validateCommand: string;
};
