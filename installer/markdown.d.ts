// esbuild's text loader turns an imported .md file into its contents (see build:installer).
declare module "*.md" {
  const text: string;
  export default text;
}
