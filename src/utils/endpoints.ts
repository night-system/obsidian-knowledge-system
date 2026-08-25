/**
 * Pure endpoint-path helpers for the v0.3.2 "endpoint path robustness" fix.
 *
 * DeepSeek's official gateway routes the Anthropic-compatible chat endpoint
 * (`POST /anthropic/v1/messages`) under the `/anthropic` path prefix, but exposes
 * the OpenAI-compatible model list (`GET /models`) at the root. Users commonly
 * fill Base URL as `https://api.deepseek.com` (missing the prefix, so chat
 * 404s) or `https://api.deepseek.com/anthropic` (so the model list 404s).
 *
 * These helpers only add/remove the `/anthropic` path segment. They never
 * hardcode the DeepSeek host: the transformation is harmless for any provider
 * because an extra candidate merely 404s and is skipped by the probe loop.
 *
 * This module intentionally imports nothing from `obsidian` and no Node
 * built-ins, so it can be unit-tested in isolation under Node.
 */

/** Trim whitespace and trailing slashes. */
function normalizeBase(base: string): string {
  return (base || '').trim().replace(/\/+$/, '');
}

/** True when `base` carries an `/anthropic` path segment (end or anywhere in path). */
export function hasAnthropicPath(base: string): boolean {
  return /\/anthropic(\/|$)/i.test(normalizeBase(base));
}

/** The root form of `base` with any `/anthropic` segment removed. */
function stripAnthropic(base: string): string {
  return normalizeBase(base)
    .replace(/\/anthropic\/?/i, '')
    .replace(/\/+$/, '');
}

/** True when `base` already carries an OpenAI-style `/v1` segment (e.g. custom gateway). */
function hasV1Segment(base: string): boolean {
  return /(^|\/)v1(\/|$)/i.test(normalizeBase(base));
}

/**
 * Candidate chat endpoint URLs to probe, in order.
 *
 * - contains `/anthropic` → the base is already the Anthropic-compatible root,
 *   so a single `{base}/v1/messages` candidate is used.
 * - ends with a `/v1` segment → a custom OpenAI-compatible gateway already
 *   carries its version prefix; probe `{base}/messages` only (avoid `/v1/v1`
 *   and preserve the original path).
 * - otherwise → probe `{base}/v1/messages`, then the DeepSeek-style
 *   `{base}/anthropic/v1/messages` correction candidate.
 */
export function chatEndpointCandidates(baseUrl: string): string[] {
  const base = normalizeBase(baseUrl);
  if (!base) return [];
  if (hasAnthropicPath(base)) return [`${base}/v1/messages`];
  if (hasV1Segment(base)) return [`${base}/messages`];
  return [`${base}/v1/messages`, `${base}/anthropic/v1/messages`];
}

/**
 * Candidate model-list endpoint URLs to probe, in order.
 *
 * - contains `/anthropic` → the model list lives at the root, so first strip
 *   the `/anthropic` segment, then probe `{root}/models` and `{root}/v1/models`
 *   (fixes "filled /anthropic → model list 404").
 * - ends with a `/v1` segment → a custom OpenAI-compatible gateway already
 *   carries its version prefix; probe `{base}/models` only (avoid `/v1/v1`
 *   and preserve the original path — symmetric with `chatEndpointCandidates`'
 *   `{base}/messages` for `/v1` segments).
 * - otherwise → probe `{base}/models` then `{base}/v1/models` (unchanged).
 */
export function modelsEndpointCandidates(baseUrl: string): string[] {
  const base = normalizeBase(baseUrl);
  if (!base) return [];
  if (hasAnthropicPath(base)) {
    const root = stripAnthropic(base);
    return [`${root}/models`, `${root}/v1/models`];
  }
  if (hasV1Segment(base)) return [`${base}/models`];
  return [`${base}/models`, `${base}/v1/models`];
}
