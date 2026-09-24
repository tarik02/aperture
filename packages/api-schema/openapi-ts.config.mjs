// Generates zod schemas for every component in api/openapi.yaml.
// Run through scripts/generate-openapi.sh.
export default {
  input: "../../api/openapi.yaml",
  output: { path: "src", postProcess: [] },
  plugins: [{ name: "zod", definitions: true, requests: false, responses: false }],
};
