/**
 * Driver interface — one file per runtime implementation.
 *
 * Adding a new runtime (Codex, Bedrock, Vertex, generic-OpenAI, …) means
 * dropping a single module in this directory that exports a RuntimeDriver.
 * No changes elsewhere in the gateway.
 */
export {};
